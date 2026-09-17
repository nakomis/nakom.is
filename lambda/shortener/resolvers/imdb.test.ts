import { runChain } from '../resolver';
import { googleResolver } from './google';
import { Fetcher, imdbResolver, pick } from './imdb';
import theMatrix from './__fixtures__/imdb/the-matrix.json';
import inception from './__fixtures__/imdb/inception.json';
import dune from './__fixtures__/imdb/dune.json';
import nothing from './__fixtures__/imdb/zzqxv-nonsense-qqq.json';
import stacyClausen from './__fixtures__/imdb/stacy-clausen.json';
import chrisEvans from './__fixtures__/imdb/chris-evans.json';

// Responses recorded from IMDb's suggestion endpoint on 17 Sep 2026, keyed by
// the query each was fetched for.
const RECORDED: Record<string, unknown> = {
    'the matrix': theMatrix, inception, dune, 'zzqxv nonsense qqq': nothing,
    'stacy clausen': stacyClausen, 'chris evans': chrisEvans,
};

function recordedFetcher() {
    const urls: string[] = [];
    const fetcher: Fetcher = async (url) => {
        urls.push(url);
        const title = decodeURIComponent(url.split('/').pop()!.replace(/\.json$/, ''));
        return { ok: true, json: async () => RECORDED[title] ?? { d: [] } };
    };
    return { fetcher, urls };
}

function resolve(path: string, fetcher: Fetcher = recordedFetcher().fetcher) {
    return runChain(path, [imdbResolver(fetcher), googleResolver]);
}

const title = (id: string) => ({ statusCode: 302, headers: { Location: `https://www.imdb.com/title/${id}/`, 'Cache-Control': 'no-store' } });
const person = (id: string) => ({ statusCode: 302, headers: { Location: `https://www.imdb.com/name/${id}/`, 'Cache-Control': 'no-store' } });
const search = (q: string) => ({ statusCode: 302, headers: { Location: `https://www.imdb.com/find/?q=${q}`, 'Cache-Control': 'no-store' } });

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('imdb resolver', () => {
    test.each([
        ['imdb/the matrix', 'tt0133093'],
        ['imdb/The Matrix', 'tt0133093'],
        ['imdb/ the  matrix ', 'tt0133093'],
        ['imdb/the matrix 1999', 'tt0133093'],
        ['imdb/inception', 'tt1375666'],   // three exact titles; the 2010 film is the most popular
        ['imdb/inception 2014', 'tt7321322'], // the year picks the short
        ['imdb/dune 1984', 'tt0087182'],
    ])('%s → title %s', async (path, id) => {
        await expect(resolve(path)).resolves.toEqual(title(id));
    });

    test.each([
        ['imdb/stacy clausen', 'nm10988681'], // the only exact match
        ['imdb/Chris Evans', 'nm0262635'],    // three exact matches; the actor is the most popular
    ])('%s → person %s', async (path, id) => {
        await expect(resolve(path)).resolves.toEqual(person(id));
    });

    test('a year rules people out', async () => {
        await expect(resolve('imdb/stacy clausen 2023')).resolves.toEqual(search('stacy%20clausen%202023'));
    });

    test('asks IMDb about the title without the year', async () => {
        const { fetcher, urls } = recordedFetcher();
        await resolve('imdb/the matrix 1999', fetcher);
        expect(urls).toEqual(['https://v3.sg.media-imdb.com/suggestion/t/the%20matrix.json']);
    });

    test.each([
        ['imdb/dune', 'dune'],                          // most popular is "Dune: Part Two", not an exact match
        ['imdb/zzqxv nonsense qqq', 'zzqxv%20nonsense%20qqq'], // no suggestions
        ['imdb/the matrix 1850', 'the%20matrix%201850'],        // no title from that year
    ])('%s → search results', async (path, q) => {
        await expect(resolve(path)).resolves.toEqual(search(q));
    });

    // A bare nakom.is/imdb/ reaches the Lambda as "imdb": the trailing slash is
    // stripped upstream. Both spellings go to the home page without a lookup.
    test.each(['imdb/', 'imdb'])('bare %s → IMDb home page', async (path) => {
        const { fetcher, urls } = recordedFetcher();
        await expect(resolve(path, fetcher)).resolves.toEqual({
            statusCode: 302, headers: { Location: 'https://www.imdb.com/', 'Cache-Control': 'no-store' },
        });
        expect(urls).toHaveLength(0);
    });

    test.each<[string, Fetcher]>([
        ['network error', async () => { throw new TypeError('fetch failed'); }],
        ['timeout', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }],
        ['HTTP error', async () => ({ ok: false, json: async () => ({}) })],
        ['changed response shape', async () => ({ ok: true, json: async () => ({ results: [] }) })],
        ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } })],
    ])('%s → search results rather than a broken redirect', async (_, fetcher) => {
        await expect(resolve('imdb/the matrix', fetcher)).resolves.toEqual(search('the%20matrix'));
    });

    test('passes a timeout signal to fetch', async () => {
        let signal: AbortSignal | undefined;
        await resolve('imdb/inception', async (_url, init) => { signal = init.signal; return { ok: true, json: async () => inception }; });
        expect(signal).toBeInstanceOf(AbortSignal);
    });

    test('ignores paths outside imdb/', () => {
        const resolver = imdbResolver(recordedFetcher().fetcher);
        expect(resolver.match('imdbthe matrix')).toBeNull();
        expect(resolver.match('imdbx')).toBeNull();
        expect(resolver.match('plane/home')).toBeNull();
    });
});

describe('pick', () => {
    test('ignores franchises, companies and other suggestions that are neither titles nor people', () => {
        expect(pick([{ id: 'in0000304', l: 'The Matrix' }, { id: 'tt0133093', l: 'The Matrix', y: 1999 }], 'the matrix'))
            .toBe('tt0133093');
        expect(pick([{ id: 'co0002663', l: 'Warner Bros.' }], 'warner bros')).toBeUndefined();
    });

    test('titles and people compete in popularity order', () => {
        const heat = [{ id: 'tt0113277', l: 'Heat', y: 1995 }, { id: 'nm9999999', l: 'Heat' }];
        expect(pick(heat, 'heat')).toBe('tt0113277');
        expect(pick([...heat].reverse(), 'heat')).toBe('nm9999999');
    });

    test('matches titles regardless of punctuation, accents and ampersands', () => {
        expect(pick([{ id: 'tt1', l: 'Amélie' }], 'amelie')).toBe('tt1');
        expect(pick([{ id: 'tt2', l: 'Mr. & Mrs. Smith' }], 'mr and mrs smith')).toBe('tt2');
        expect(pick([{ id: 'tt3', l: 'WALL·E' }], 'wall e')).toBe('tt3');
    });

    test('an exact match that is not the most popular still wins when it is the only one', () => {
        expect(pick([{ id: 'tt1', l: 'Alien: Romulus' }, { id: 'tt2', l: 'Alien' }], 'alien')).toBe('tt2');
    });

    test('several exact matches, none the most popular → no pick', () => {
        expect(pick([{ id: 'tt1', l: 'Heat 2' }, { id: 'tt2', l: 'Heat' }, { id: 'tt3', l: 'Heat' }], 'heat')).toBeUndefined();
    });
});
