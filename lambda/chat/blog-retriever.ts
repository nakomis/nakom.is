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

// S3 record: id + binary embedding + all chunk metadata
interface S3EmbeddingRecord {
    id:           string;
    post_slug:    string;
    post_tags:    string[];
    post_title:   string;
    post_date:    string;
    post_url:     string;
    heading:      string;
    text:         string;
    post_excerpt: string;
    embedding:    string;  // base64-encoded Float32Array
}

// DynamoDB record: full text/metadata fetched after cosine search
interface ChunkMeta {
    post_slug:    string;
    post_title:   string;
    post_date:    string;
    post_url:     string;
    post_excerpt: string;
    heading:      string;
    text:         string;
}

// In-memory representation after decoding
interface DecodedRecord {
    id:           string;
    post_slug:    string;
    post_tags:    string[];
    post_title:   string;
    post_date:    string;
    post_url:     string;
    heading:      string;
    text:         string;
    post_excerpt: string;
    embedding:    Float32Array;
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
        id:           r.id,
        post_slug:    r.post_slug,
        post_tags:    r.post_tags,
        post_title:   r.post_title   ?? '',
        post_date:    r.post_date    ?? '',
        post_url:     r.post_url     ?? '',
        heading:      r.heading      ?? '',
        text:         r.text         ?? '',
        post_excerpt: r.post_excerpt ?? '',
        embedding:    decodeEmbedding(r.embedding),
    }));

    console.log(`Blog embeddings loaded: ${embeddingsCache.length} chunks`);
    return embeddingsCache;
}


function tokenize(query: string): string[] {
    return query.toLowerCase()
        .replace(/[^a-z0-9'\s-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2);
}

function keywordScore(text: string, heading: string, title: string, terms: string[]): number {
    if (terms.length === 0) return 0;
    const haystack = `${title} ${heading} ${text}`.toLowerCase();
    let count = 0;
    for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, 'g'));
        if (matches) count += matches.length;
    }
    return count / Math.sqrt(haystack.length + 1);
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
            post_slug:    item.post_slug?.S    ?? '',
            post_title:   item.post_title?.S   ?? '',
            post_date:    item.post_date?.S    ?? '',
            post_url:     item.post_url?.S     ?? '',
            post_excerpt: item.post_excerpt?.S ?? '',
            heading:      item.heading?.S      ?? '',
            text:         item.text?.S         ?? '',
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
            excerpt:   meta.post_excerpt || meta.text,
        };
    }).filter((r): r is BlogSearchResult => r !== null);
}

/**
 * Full-text keyword search over blog chunks (no embedding call).
 * Uses term-frequency scoring normalised by text length.
 */
export async function searchBlogJsonFullText(query: string): Promise<BlogSearchResult[]> {
    const records = await loadEmbeddings();
    const terms   = tokenize(query);
    if (terms.length === 0) return [];

    const scored = records
        .map(r => ({ r, score: keywordScore(r.text, r.heading, r.post_title, terms) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    return scored
        .filter(({ r }) => { if (seen.has(r.post_slug)) return false; seen.add(r.post_slug); return true; })
        .slice(0, TOP_K)
        .map(({ r }) => ({
            id:        r.id,
            postSlug:  r.post_slug,
            postTitle: r.post_title,
            postDate:  r.post_date,
            postUrl:   r.post_url,
            heading:   r.heading,
            excerpt:   r.post_excerpt || r.text,
        }));
}

/**
 * Hybrid search combining semantic similarity (HyDE query) with keyword matching (raw query)
 * using Reciprocal Rank Fusion (RRF, k=60).
 *
 * @param semanticQuery  HyDE-expanded hypothetical passage for the embedding component.
 * @param fulltextQuery  Raw user query for the keyword component.
 */
export async function searchBlogJsonHybrid(semanticQuery: string, fulltextQuery: string): Promise<BlogSearchResult[]> {
    const [records, queryEmbedding] = await Promise.all([
        loadEmbeddings(),
        embedQuery(semanticQuery),
    ]);

    const terms = tokenize(fulltextQuery);
    const recordById = new Map(records.map(r => [r.id, r]));

    // Semantic ranking
    const semanticScored = records
        .map(r => ({ id: r.id, post_slug: r.post_slug, score: cosineSimilarity(r.embedding, queryEmbedding) }))
        .sort((a, b) => b.score - a.score);
    const semanticRank = new Map<string, number>(semanticScored.map((r, i) => [r.id, i + 1]));

    // Fulltext ranking
    const fulltextScored = terms.length > 0
        ? records
              .map(r => ({ id: r.id, post_slug: r.post_slug, score: keywordScore(r.text, r.heading, r.post_title, terms) }))
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score)
        : [];
    const fulltextRank = new Map<string, number>(fulltextScored.map((r, i) => [r.id, i + 1]));

    // RRF fusion over union of candidates
    const k = 60;
    const CANDIDATES = TOP_K * 10;
    const candidateIds = new Set([
        ...semanticScored.slice(0, CANDIDATES).map(r => r.id),
        ...fulltextScored.slice(0, CANDIDATES).map(r => r.id),
    ]);

    const rrfScored = [...candidateIds]
        .map(id => {
            const sRank = semanticRank.get(id);
            const fRank = fulltextRank.get(id);
            const score = (sRank !== undefined ? 1 / (k + sRank) : 0)
                        + (fRank !== undefined ? 1 / (k + fRank) : 0);
            return { id, score, post_slug: recordById.get(id)?.post_slug ?? '' };
        })
        .sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const top = rrfScored
        .filter(({ post_slug }) => { if (seen.has(post_slug)) return false; seen.add(post_slug); return true; })
        .slice(0, TOP_K);

    return top.map(({ id }) => {
        const r = recordById.get(id);
        if (!r) return null;
        return {
            id,
            postSlug:  r.post_slug,
            postTitle: r.post_title,
            postDate:  r.post_date,
            postUrl:   r.post_url,
            heading:   r.heading,
            excerpt:   r.post_excerpt || r.text,
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
