import { searchBlogJson } from '../chat/blog-retriever';

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
    try {
        const body = JSON.parse(event.body || '{}');
        query = (body.query ?? '').trim();
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

    const results = await searchBlogJson(query);
    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ results }),
    };
};
