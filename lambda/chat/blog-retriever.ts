import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, BatchGetItemCommand } from '@aws-sdk/client-dynamodb';
import { Readable } from 'stream';

const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const ddb     = new DynamoDBClient({});

const EMBED_MODEL    = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMS     = 1024;
const TOP_K          = 4;
const MIN_SCORE      = 0.22;
const EMBEDDINGS_KEY = 'blog-embeddings.json';

// S3 record: id + binary embedding + fields needed for deduplication and HyDE tag expansion
interface S3EmbeddingRecord {
    id:        string;
    post_slug: string;
    post_tags: string[];
    embedding: string;  // base64-encoded Float32Array
}

// DynamoDB record: full text/metadata fetched after cosine search
interface ChunkMeta {
    post_slug:  string;
    post_title: string;
    post_date:  string;
    post_url:   string;
    heading:    string;
    text:       string;
}

// In-memory representation after decoding
interface DecodedRecord {
    id:        string;
    post_slug: string;
    post_tags: string[];
    embedding: Float32Array;
}

// Module-level cache — loaded once per Lambda container
let embeddingsCache: DecodedRecord[] | null = null;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

async function loadEmbeddings(): Promise<DecodedRecord[]> {
    if (embeddingsCache) return embeddingsCache;

    const privateBucket = process.env.PRIVATE_BUCKET;
    if (!privateBucket) throw new Error('PRIVATE_BUCKET not set');

    const result = await s3.send(new GetObjectCommand({
        Bucket: privateBucket,
        Key:    EMBEDDINGS_KEY,
    }));
    const buf     = await streamToBuffer(result.Body as Readable);
    const records: S3EmbeddingRecord[] = JSON.parse(buf.toString('utf-8'));

    // Decode base64 Float32 embeddings once at cold start
    embeddingsCache = records.map(r => ({
        id:        r.id,
        post_slug: r.post_slug,
        post_tags: r.post_tags,
        embedding: decodeEmbedding(r.embedding),
    }));

    console.log(`Blog embeddings loaded: ${embeddingsCache.length} chunks`);
    return embeddingsCache;
}

function decodeEmbedding(b64: string): Float32Array {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

async function embedQuery(text: string): Promise<Float32Array> {
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
    const result: number[] = JSON.parse(Buffer.from(response.body).toString('utf-8')).embedding;
    return new Float32Array(result);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchChunkMeta(ids: string[]): Promise<Map<string, ChunkMeta>> {
    const table = process.env.BLOG_CHUNKS_TABLE;
    if (!table) throw new Error('BLOG_CHUNKS_TABLE not set');

    const response = await ddb.send(new BatchGetItemCommand({
        RequestItems: {
            [table]: {
                Keys: ids.map(id => ({ id: { S: id } })),
            },
        },
    }));

    const metaMap = new Map<string, ChunkMeta>();
    for (const item of response.Responses?.[table] ?? []) {
        metaMap.set(item.id.S!, {
            post_slug:  item.post_slug?.S  ?? '',
            post_title: item.post_title?.S ?? '',
            post_date:  item.post_date?.S  ?? '',
            post_url:   item.post_url?.S   ?? '',
            heading:    item.heading?.S    ?? '',
            text:       item.text?.S       ?? '',
        });
    }
    return metaMap;
}

export interface BlogSearchResult {
    id:        string;
    postSlug:  string;
    postTitle: string;
    postDate:  string;
    postUrl:   string;
    heading:   string;
    excerpt:   string;
}

/**
 * Return the unique set of tags across all published posts.
 * Used by HyDE to ground the hypothetical passage in the blog's vocabulary.
 */
export async function getPostTags(): Promise<string[]> {
    const records = await loadEmbeddings();
    return [...new Set(records.flatMap(r => r.post_tags ?? []))].sort();
}

/**
 * Search blog posts by semantic similarity to the query.
 * Returns structured JSON results for use by the search API.
 */
export async function searchBlogJson(query: string): Promise<BlogSearchResult[]> {
    const [records, queryEmbedding] = await Promise.all([
        loadEmbeddings(),
        embedQuery(query),
    ]);

    const scored = records
        .map(r => ({ id: r.id, post_slug: r.post_slug, score: cosineSimilarity(r.embedding, queryEmbedding) }))
        .sort((a, b) => b.score - a.score);

    console.log('Search scores (top 5):', scored.slice(0, 5).map(
        ({ id, score }) => `${score.toFixed(4)} ${id}`
    ).join(' | '));

    // Deduplicate by post, apply score threshold, take top K
    const seen = new Set<string>();
    const topIds = scored
        .filter(({ score }) => score >= MIN_SCORE)
        .filter(({ post_slug }) => {
            if (seen.has(post_slug)) return false;
            seen.add(post_slug);
            return true;
        })
        .slice(0, TOP_K)
        .map(({ id }) => id);

    if (topIds.length === 0) return [];

    const metaMap = await fetchChunkMeta(topIds);

    return topIds.map(id => {
        const meta = metaMap.get(id);
        if (!meta) return null;
        return {
            id,
            postSlug:  meta.post_slug,
            postTitle: meta.post_title,
            postDate:  meta.post_date,
            postUrl:   meta.post_url,
            heading:   meta.heading,
            excerpt:   meta.text,
        };
    }).filter((r): r is BlogSearchResult => r !== null);
}

/**
 * Search blog posts by semantic similarity to the query.
 * Returns a formatted string of the top-K matching chunks, ready to inject into context.
 */
export async function searchBlog(query: string): Promise<string> {
    const [records, queryEmbedding] = await Promise.all([
        loadEmbeddings(),
        embedQuery(query),
    ]);

    const scored = records
        .map(r => ({ id: r.id, score: cosineSimilarity(r.embedding, queryEmbedding) }))
        .sort((a, b) => b.score - a.score)
        .filter(({ score }) => score >= MIN_SCORE)
        .slice(0, TOP_K);

    if (scored.length === 0) return 'No relevant blog content found.';

    const metaMap = await fetchChunkMeta(scored.map(({ id }) => id));

    return scored.map(({ id }) => {
        const meta = metaMap.get(id);
        if (!meta) return null;
        const heading = meta.heading ? ` — ${meta.heading}` : '';
        const link    = `<a href="${meta.post_url}">${meta.post_title}${heading}</a>`;
        return `POST_LINK: ${link}\nDATE: ${meta.post_date}\nEXCERPT: ${meta.text}`;
    }).filter(Boolean).join('\n\n---\n\n');
}
