// Embedding model settings shared by the build-time generator
// (scripts/generate-topic-vectors.ts) and the runtime gate (relevance.ts).
// Kept in its own file so the generator can import these constants WITHOUT
// pulling in relevance.ts's import of topic-vectors.json (which doesn't exist
// until the generator has run). The baked exemplar vectors and the runtime
// query embed MUST use identical settings or their cosine is meaningless.
//
// Titan v2 in us-east-1 — the same model/region the blog search already uses
// (see blog-retriever.ts), so one BedrockRuntimeClient region serves both.
export const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const EMBED_DIMS = 1024;
export const BEDROCK_REGION = 'us-east-1';
