import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

const EMBED_MODEL    = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMS     = 1024;
const TOP_K          = 4;
const MIN_SCORE      = 0.5;   // cosine similarity threshold — drop weak matches
const EMBEDDINGS_KEY = 'blog-embeddings.json';

interface BlogChunk {
    id:         string;
    post_slug:  string;
    post_title: string;
    post_date:  string;
    post_url:   string;
    heading:    string;
    text:       string;
    embedding:  number[];
}

// Module-level cache — loaded once per Lambda container
let chunksCache: BlogChunk[] | null = null;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

async function loadChunks(): Promise<BlogChunk[]> {
    if (chunksCache) return chunksCache;

    const privateBucket = process.env.PRIVATE_BUCKET;
    if (!privateBucket) throw new Error('PRIVATE_BUCKET not set');

    const result = await s3.send(new GetObjectCommand({
        Bucket: privateBucket,
        Key:    EMBEDDINGS_KEY,
    }));
    const buf = await streamToBuffer(result.Body as Readable);
    chunksCache = JSON.parse(buf.toString('utf-8'));
    console.log(`Blog embeddings loaded: ${chunksCache!.length} chunks`);
    return chunksCache!;
}

async function embedQuery(text: string): Promise<number[]> {
    const response = await bedrock.send(new InvokeModelCommand({
        modelId:     EMBED_MODEL,
        contentType: 'application/json',
        accept:      'application/json',
        body:        Buffer.from(JSON.stringify({
            inputText:  text,
            dimensions: EMBED_DIMS,
            normalize:  true,
        })),
    }));
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    return result.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface BlogSearchResult {
    id: string;
    postSlug: string;
    postTitle: string;
    postDate: string;
    postUrl: string;
    heading: string;
    excerpt: string;
}

/**
 * Search blog posts by semantic similarity to the query.
 * Returns structured JSON results for use by the search API.
 */
export async function searchBlogJson(query: string): Promise<BlogSearchResult[]> {
    const [chunks, queryEmbedding] = await Promise.all([
        loadChunks(),
        embedQuery(query),
    ]);

    const scored = chunks
        .map(chunk => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .filter(({ score }) => score >= MIN_SCORE);

    // Keep only the best-scoring chunk per post, then take top K
    const seen = new Set<string>();
    const deduplicated = scored.filter(({ chunk }) => {
        if (seen.has(chunk.post_slug)) return false;
        seen.add(chunk.post_slug);
        return true;
    }).slice(0, TOP_K);

    return deduplicated.map(({ chunk }) => ({
        id: chunk.id,
        postSlug: chunk.post_slug,
        postTitle: chunk.post_title,
        postDate: chunk.post_date,
        postUrl: chunk.post_url,
        heading: chunk.heading,
        excerpt: chunk.text,
    }));
}

/**
 * Search blog posts by semantic similarity to the query.
 * Returns a formatted string of the top-K matching chunks, ready to inject into context.
 */
export async function searchBlog(query: string): Promise<string> {
    const [chunks, queryEmbedding] = await Promise.all([
        loadChunks(),
        embedQuery(query),
    ]);

    const scored = chunks
        .map(chunk => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .filter(({ score }) => score >= MIN_SCORE)
        .slice(0, TOP_K);

    if (scored.length === 0) return 'No relevant blog content found.';

    return scored.map(({ chunk }) => {
        const heading = chunk.heading ? ` — ${chunk.heading}` : '';
        return `**${chunk.post_title}${heading}** (${chunk.post_date})\n${chunk.text}\n${chunk.post_url}`;
    }).join('\n\n---\n\n');
}
