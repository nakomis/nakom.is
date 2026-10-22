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
    /** The incoming query string, percent-encoded, without the leading `?`. Empty when there is none. */
    query: string;
}

export const emptyRequest = (): ShortenerRequest => ({ headers: {}, requestId: randomUUID(), query: '' });

function paramKey(pair: string): string {
    const raw = pair.split('=', 1)[0].replace(/\+/g, ' ');
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/**
 * Appends the incoming query string to a redirect target (HOME-529), so that
 * e.g. an OAuth `?code=…` survives the hop. If the target already has a query
 * the two are merged and the target's own parameters win on a clash. Pairs are
 * kept as written (no re-encoding), and any `#fragment` stays at the end.
 */
export function withQuery(target: string, query: string): string {
    if (!query) {
        return target;
    }
    const hash = target.indexOf('#');
    const fragment = hash === -1 ? '' : target.slice(hash);
    const beforeFragment = hash === -1 ? target : target.slice(0, hash);
    const q = beforeFragment.indexOf('?');
    const base = q === -1 ? beforeFragment : beforeFragment.slice(0, q);
    const own = q === -1 ? '' : beforeFragment.slice(q + 1);
    const ownPairs = own.split('&').filter((pair) => pair !== '');
    const taken = new Set(ownPairs.map(paramKey));
    const added = query.split('&').filter((pair) => pair !== '' && !taken.has(paramKey(pair)));
    const merged = [...ownPairs, ...added].join('&');
    return `${base}${merged ? `?${merged}` : ''}${fragment}`;
}

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
