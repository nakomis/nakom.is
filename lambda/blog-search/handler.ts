import { searchBlogJson, searchBlogJsonFullText, searchBlogJsonHybrid, getPostTags } from '../chat/blog-retriever';
import { hydeExpand } from './hyde';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

export const handler = async (event: any) => {
    const method: string =
        event.requestContext?.http?.method ?? event.httpMethod ?? 'POST';

    if (method === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (method !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }

    let query: string;
    let mode: SearchMode;
    try {
        // API Gateway with binaryMediaTypes: ["*/*"] base64-encodes the body
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body || '', 'base64').toString('utf-8')
            : (event.body || '{}');
        const body = JSON.parse(rawBody);
        query = (body.query ?? '').trim();
        const rawMode = body.mode ?? 'hybrid';
        mode = (['hybrid', 'semantic', 'fulltext'] as SearchMode[]).includes(rawMode)
            ? rawMode as SearchMode
            : 'hybrid';
    } catch {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Invalid JSON body' }),
        };
    }

    if (!query) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'query is required' }),
        };
    }

    let results;
    if (mode === 'fulltext') {
        results = await searchBlogJsonFullText(query);
    } else if (mode === 'semantic') {
        const tags = await getPostTags();
        const hypothetical = await hydeExpand(query, tags);
        results = await searchBlogJson(hypothetical);
    } else {
        // hybrid: HyDE for the semantic component, raw query for fulltext
        const tags = await getPostTags();
        const hypothetical = await hydeExpand(query, tags);
        results = await searchBlogJsonHybrid(hypothetical, query);
    }
    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ results }),
    };
};
