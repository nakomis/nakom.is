import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
