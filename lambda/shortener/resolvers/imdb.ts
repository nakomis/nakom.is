import { redirect, Resolver } from '../resolver';

export interface ImdbMatch {
    /** What was typed, e.g. "the matrix 1999". */
    query: string;
    /** The query without a trailing year: what IMDb is asked about. */
    title: string;
    year?: number;
}

interface Suggestion {
    id: string;
    l?: string;
    y?: number;
}

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const PREFIX = 'imdb/';
// Upstream strips a trailing slash, so a bare nakom.is/imdb/ arrives as "imdb".
const BARE = 'imdb';
const TIMEOUT_MS = 1500;
const IMDB = 'https://www.imdb.com';

// "dune 1984" → title "dune", year 1984
const TRAILING_YEAR = /^(.*\S)\s+((?:18|19|20)\d\d)$/;

// nakom.is/imdb/the matrix → straight to the title (or person) when IMDb's suggestions make
// the answer clear, otherwise to IMDb's own search results. IMDb has no public
// API, so this uses the unofficial endpoint behind its search box; anything
// unexpected — an error, a timeout, a changed response — just means the search
// page, never a broken redirect.
export function imdbResolver(fetcher: Fetcher = fetch as unknown as Fetcher): Resolver<ImdbMatch> {
    return {
        name: 'imdb',
        match: (path) => {
            if (path === BARE) {
                return { query: '', title: '' };
            }
            if (!path.startsWith(PREFIX)) {
                return null;
            }
            const query = path.slice(PREFIX.length).trim().replace(/\s+/g, ' ');
            const withYear = TRAILING_YEAR.exec(query);
            return withYear
                ? { query, title: withYear[1], year: Number(withYear[2]) }
                : { query, title: query };
        },
        resolve: async ({ query, title, year }) => {
            if (!query) {
                return redirect(`${IMDB}/`, 'no-store', 302);
            }
            const id = await lookUp(fetcher, title, year);
            if (id) {
                console.log(`IMDb: "${query}" → ${id}`);
                const page = id.startsWith('nm') ? 'name' : 'title';
                return redirect(`${IMDB}/${page}/${id}/`, 'no-store', 302);
            }
            console.log(`IMDb: "${query}" → search`);
            return redirect(`${IMDB}/find/?q=${encodeURIComponent(query)}`, 'no-store', 302);
        },
    };
}

async function lookUp(fetcher: Fetcher, title: string, year?: number): Promise<string | undefined> {
    try {
        const first = /^[a-z0-9]/.test(title[0].toLowerCase()) ? title[0].toLowerCase() : 'x';
        const response = await fetcher(
            `https://v3.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(title.toLowerCase())}.json`,
            { signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        if (!response.ok) {
            return undefined;
        }
        const body = await response.json() as { d?: Suggestion[] };
        return pick(Array.isArray(body.d) ? body.d : [], title, year);
    } catch (err) {
        console.log(`IMDb: lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * The title (tt…) or person (nm…) to go straight to, if any. Suggestions arrive
 * in IMDb's popularity order with titles and people interleaved, and exact
 * duplicates are common ("Inception" is a 2010 film, a 2014 short and an
 * unreleased feature; three people are called Chris Evans), so an entry wins if
 * it is the only exact match, or if it is the most popular result and an exact
 * match. A year only makes sense for a title, so it rules people out.
 */
export function pick(suggestions: Suggestion[], title: string, year?: number): string | undefined {
    const wanted = normalise(title);
    const candidates = suggestions.filter(s =>
        year === undefined ? /^(tt|nm)\d+$/.test(s.id) : /^tt\d+$/.test(s.id) && s.y === year);
    const exact = candidates.filter(s => normalise(s.l ?? '') === wanted);
    if (exact.length === 1) {
        return exact[0].id;
    }
    if (candidates.length > 0 && exact[0] === candidates[0]) {
        return candidates[0].id;
    }
    return undefined;
}

function normalise(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
