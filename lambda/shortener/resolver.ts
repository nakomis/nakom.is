import { randomUUID } from 'crypto';

export interface RedirectResponse {
    statusCode: number;
    headers: Record<string, string>;
}

/**
 * What a resolver may know about the request beyond its path. Only the
 * short-link resolver reads it (for hit events on `hi-` links, HAND-22);
 * every other resolver ignores it.
 */
export interface ShortenerRequest {
    /** Request headers as API Gateway passed them on. Look them up case-insensitively. */
    headers: Record<string, string | undefined>;
    /** API Gateway's request id, or a random UUID when there isn't one. */
    requestId: string;
}

export const emptyRequest = (): ShortenerRequest => ({ headers: {}, requestId: randomUUID() });

/**
 * A resolver turns a request path into a response.
 *
 * `match` must be pure and synchronous — it decides whether the resolver
 * is interested, without doing any I/O. Only the first matching resolver's
 * `resolve` runs (unless it declines by returning null, in which case the
 * chain carries on to the next matching resolver).
 *
 * Convention: resolvers that own a namespace match a `word/` prefix, and
 * short links in the redirects table never contain a `/`.
 */
export interface Resolver<M> {
    name: string;
    match(path: string): M | null;
    resolve(match: M, request: ShortenerRequest): Promise<RedirectResponse | null>;
}

export type AnyResolver = Resolver<any>;

export function redirect(location: string, cacheControl?: string, statusCode = 301): RedirectResponse {
    const headers: Record<string, string> = { Location: location };
    if (cacheControl) {
        headers['Cache-Control'] = cacheControl;
    }
    return { statusCode, headers };
}

export async function runChain(
    path: string,
    resolvers: AnyResolver[],
    request: ShortenerRequest = emptyRequest(),
): Promise<RedirectResponse> {
    for (const resolver of resolvers) {
        const match = resolver.match(path);
        if (match === null) {
            continue;
        }
        const response = await resolver.resolve(match, request);
        if (response) {
            return response;
        }
    }
    throw new Error(`No resolver handled path: ${path}`);
}
