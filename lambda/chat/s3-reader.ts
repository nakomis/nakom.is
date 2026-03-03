import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3 = new S3Client({});

const cache = new Map<string, { content: string; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Read a file from the private S3 bucket, with a 1-hour module-level cache.
 * Returns an error string if the file is not found.
 */
export async function readPrivateFile(key: string): Promise<string> {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        return cached.content;
    }

    const privateBucket = process.env.PRIVATE_BUCKET;
    if (!privateBucket) {
        return 'Error: PRIVATE_BUCKET environment variable not set';
    }

    try {
        const result = await s3.send(new GetObjectCommand({
            Bucket: privateBucket,
            Key: key,
        }));
        const content = await streamToString(result.Body as Readable);
        cache.set(key, { content, timestamp: now });
        return content;
    } catch (err: any) {
        if (err.name === 'NoSuchKey') {
            return `File ${key} not found in private bucket. It may not have been uploaded yet.`;
        }
        throw err;
    }
}

/**
 * Read all blog posts from the blog S3 bucket (posts/ prefix), with a 1-hour module-level cache.
 * Returns all posts concatenated as markdown, separated by horizontal rules.
 */
export async function readBlogPosts(): Promise<string> {
    const now = Date.now();
    const cacheKey = '__blog_posts__';
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        return cached.content;
    }

    const blogBucket = process.env.BLOG_BUCKET;
    if (!blogBucket) {
        return 'Error: BLOG_BUCKET environment variable not set';
    }

    const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: blogBucket,
        Prefix: 'posts/',
    }));

    const keys = (listResult.Contents ?? [])
        .map(obj => obj.Key!)
        .filter(key => key.endsWith('.md'));

    if (keys.length === 0) {
        return 'No blog posts found.';
    }

    const posts = await Promise.all(
        keys.map(async key => {
            const result = await s3.send(new GetObjectCommand({ Bucket: blogBucket, Key: key }));
            const content = await streamToString(result.Body as Readable);
            return `# ${key.replace('posts/', '')}\n\n${content}`;
        })
    );

    const aggregated = posts.join('\n\n---\n\n');
    cache.set(cacheKey, { content: aggregated, timestamp: now });
    return aggregated;
}
