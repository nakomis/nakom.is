import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { handle, queryOf } from './handler';
import { withQuery } from './resolver';
import { HitSink, sqsHitSink } from './hits';
import { AnyResolver } from './resolver';
import { catResolver } from './resolvers/cat';
import { googleResolver } from './resolvers/google';
import { imdbResolver } from './resolvers/imdb';
import { DynamoSender, matchShortLink, shortLinkResolver } from './resolvers/short-link';
import { ticketResolver } from './resolvers/tickets';

function fakeTable(links: Record<string, string>, passthrough: Record<string, boolean> = {}) {
    const commands: UpdateItemCommand[] = [];
    const client = {
        send: jest.fn(async (command: UpdateItemCommand) => {
            commands.push(command);
            const key = command.input.Key!.shortPath.S!;
            if (!(key in links)) {
                throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
            }
            return { Attributes: { shortPath: { S: key }, url: { S: links[key] }, ...(key in passthrough ? { passthrough: { BOOL: passthrough[key] } } : {}), hitCount: { N: '1' } } };
        }),
    } as unknown as DynamoSender;
    return { client, commands };
}

function chainWith(links: Record<string, string>, passthrough: Record<string, boolean> = {}) {
    const table = fakeTable(links, passthrough);
    const chain: AnyResolver[] = [catResolver, shortLinkResolver(table.client, 'redirects'), googleResolver];
    return { chain, ...table };
}

const at = (shortPath?: string) => (shortPath === undefined ? {} : { pathParameters: { shortPath } });

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('shortener handler', () => {
    test('no path parameters → Google home page', async () => {
        const { chain, commands } = chainWith({});
        await expect(handle({}, chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk', 'Cache-Control': 'max-age=600' },
        });
        await expect(handle({ pathParameters: null }, chain)).resolves.toMatchObject({ headers: { Location: 'https://www.google.co.uk' } });
        expect(commands).toHaveLength(0);
    });

    test('empty short path → Google home page', async () => {
        const { chain } = chainWith({});
        await expect(handle(at(''), chain)).resolves.toMatchObject({ headers: { Location: 'https://www.google.co.uk' } });
    });

    test('cat prefix → http.cat without touching the table', async () => {
        const { chain, commands } = chainWith({ cat404: 'example.com' });
        await expect(handle(at('cat404'), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://http.cat/status/404' },
        });
        expect(commands).toHaveLength(0);
    });

    test('bare "cat" is a short link, not a cat', async () => {
        const { chain } = chainWith({ cat: 'cats.example.com' });
        await expect(handle(at('cat'), chain)).resolves.toMatchObject({ headers: { Location: 'https://cats.example.com' } });
    });

    test('known short link → 301 with cache, incrementing the hit count', async () => {
        const { chain, commands } = chainWith({ hn: 'https://news.ycombinator.com' });
        await expect(handle(at('hn'), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://news.ycombinator.com', 'Cache-Control': 'max-age=600' },
        });
        expect(commands).toHaveLength(1);
        expect(commands[0].input).toMatchObject({
            TableName: 'redirects',
            UpdateExpression: 'ADD hitCount :one',
            ConditionExpression: 'attribute_exists(shortPath)',
        });
    });

    test.each([
        ['example.com/page', 'https://example.com/page'],
        ['http://example.com', 'http://example.com'],
        ['https://example.com', 'https://example.com'],
        ['chrome://settings', 'chrome://settings'],
    ])('stored url %s → Location %s', async (stored, expected) => {
        const { chain } = chainWith({ link: stored });
        await expect(handle(at('link'), chain)).resolves.toMatchObject({ headers: { Location: expected } });
    });

    test('unknown short link → Google search, uncached', async () => {
        const { chain } = chainWith({});
        await expect(handle(at('nothing here'), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk/search?q=nothing%20here', 'Cache-Control': 'no-store' },
        });
    });

    test('percent-encoded paths from API Gateway are decoded once', async () => {
        const { chain, commands } = chainWith({ 'a b': 'example.com' });
        await expect(handle(at('a%20b'), chain)).resolves.toMatchObject({ headers: { Location: 'https://example.com' } });
        expect(commands[0].input.Key).toEqual({ shortPath: { S: 'a b' } });
        await expect(handle(at('taiga/home%20%23123'), [googleResolver])).resolves.toMatchObject({
            headers: { Location: 'https://www.google.co.uk/search?q=taiga%2Fhome%20%23123' },
        });
    });

    test('malformed percent-encoding is used as-is', async () => {
        const { chain } = chainWith({});
        await expect(handle(at('100%'), chain)).resolves.toMatchObject({
            headers: { Location: 'https://www.google.co.uk/search?q=100%25' },
        });
    });

    test('unexpected DynamoDB errors propagate', async () => {
        const client = { send: jest.fn().mockRejectedValue(new Error('throttled')) } as unknown as DynamoSender;
        const chain = [catResolver, shortLinkResolver(client, 'redirects'), googleResolver];
        await expect(handle(at('hn'), chain)).rejects.toThrow('throttled');
    });
});

// HAND-22: the book's hi- links and Q-codes are uncached and publish one hit event per visit.
describe('hi- links', () => {
    const CLOUDFRONT_HEADERS = {
        'CloudFront-Viewer-Country': 'GB',
        'CloudFront-Viewer-Country-Region': 'EDH',
        'CloudFront-Viewer-City': 'Edinburgh',
        'CloudFront-Is-Mobile-Viewer': 'true',
        'CloudFront-Is-Tablet-Viewer': 'false',
        'CloudFront-Is-Desktop-Viewer': 'false',
        'CloudFront-Is-SmartTV-Viewer': 'false',
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'X-Forwarded-For': '203.0.113.7',
    };

    function hiChain(links: Record<string, string>, sink: HitSink = jest.fn(async () => undefined)) {
        const table = fakeTable(links);
        // The full production order, so a namespace resolver swallowing a counted path would show up here.
        const chain: AnyResolver[] = [
            catResolver,
            imdbResolver(jest.fn() as any),
            ticketResolver(table.client, 'ticket-projects'),
            shortLinkResolver(table.client, 'redirects', sink),
            googleResolver,
        ];
        return { chain, sink, ...table };
    }

    const event = (shortPath: string, headers: Record<string, string> = CLOUDFRONT_HEADERS) =>
        ({ pathParameters: { shortPath }, headers, requestContext: { requestId: 'req-1' } });

    test('typed link → 302 no-store, one event with source "link"', async () => {
        const { chain, sink, commands } = hiChain({ 'hi-fig-1-2': 'https://youtu.be/abc' });
        await expect(handle(event('hi-fig-1-2'), chain)).resolves.toEqual({
            statusCode: 302,
            headers: { Location: 'https://youtu.be/abc', 'Cache-Control': 'no-store' },
        });
        expect(commands).toHaveLength(1);
        expect(commands[0].input).toMatchObject({
            Key: { shortPath: { S: 'hi-fig-1-2' } },
            UpdateExpression: 'ADD hitCount :one',
            ConditionExpression: 'attribute_exists(shortPath)',
        });
        expect(sink).toHaveBeenCalledTimes(1);
        expect((sink as jest.Mock).mock.calls[0][0]).toEqual({
            shortPath: 'hi-fig-1-2',
            at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
            requestId: 'req-1',
            source: 'link',
            country: 'GB',
            region: 'EDH',
            city: 'Edinburgh',
            device: 'mobile',
            lang: 'en-GB',
            os: 'iOS',
            browser: 'Safari',
        });
    });

    test.each(['Q01', 'q01'])('QR-only code %s → lower-case row q01, 302 no-store, source "qr"', async (path) => {
        const { chain, sink, commands } = hiChain({ q01: 'https://youtu.be/abc' });
        await expect(handle(event(path), chain)).resolves.toEqual({
            statusCode: 302,
            headers: { Location: 'https://youtu.be/abc', 'Cache-Control': 'no-store' },
        });
        expect(commands).toHaveLength(1);
        expect(commands[0].input.Key).toEqual({ shortPath: { S: 'q01' } });
        expect(sink).toHaveBeenCalledTimes(1);
        expect((sink as jest.Mock).mock.calls[0][0]).toMatchObject({ shortPath: 'q01', source: 'qr' });
    });

    test.each(['hi-pythagoras', 'Hi-Pythagoras', 'HI-PYTHAGORAS', 'hI-pYTHAGORAS'])(
        'typed link %s → lower-case row, 302 no-store, source "link"',
        async (path) => {
            const { chain, sink, commands } = hiChain({ 'hi-pythagoras': 'https://youtu.be/abc' });
            await expect(handle(event(path), chain)).resolves.toEqual({
                statusCode: 302,
                headers: { Location: 'https://youtu.be/abc', 'Cache-Control': 'no-store' },
            });
            expect(commands[0].input.Key).toEqual({ shortPath: { S: 'hi-pythagoras' } });
            expect((sink as jest.Mock).mock.calls[0][0]).toMatchObject({ shortPath: 'hi-pythagoras', source: 'link' });
        },
    );

    test.each(['q1', 'q001', 'Q1', 'Q001', 'q0a', 'qa1'])('%s is not a Q-code: an ordinary link, case kept', async (path) => {
        const { chain, sink, commands } = hiChain({ [path]: 'https://example.com' });
        await expect(handle(event(path), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://example.com', 'Cache-Control': 'max-age=600' },
        });
        expect(commands[0].input.Key).toEqual({ shortPath: { S: path } });
        expect(sink).not.toHaveBeenCalled();
    });

    test('ordinary links keep their case', async () => {
        const { chain, sink, commands } = hiChain({ HN: 'https://news.ycombinator.com' });
        await expect(handle(event('HN'), chain)).resolves.toMatchObject({ statusCode: 301 });
        expect(commands[0].input.Key).toEqual({ shortPath: { S: 'HN' } });
        expect(sink).not.toHaveBeenCalled();
    });

    test('never puts the IP or the raw User-Agent in the event', async () => {
        const { chain, sink } = hiChain({ 'hi-x': 'example.com' });
        await handle(event('hi-x'), chain);
        const body = JSON.stringify((sink as jest.Mock).mock.calls[0][0]);
        expect(body).not.toContain('203.0.113.7');
        expect(body).not.toContain('Mozilla');
        expect(body).not.toContain('AppleWebKit');
    });

    test('without CloudFront headers every derived field is null', async () => {
        const { chain, sink } = hiChain({ 'hi-x': 'example.com' });
        await handle({ pathParameters: { shortPath: 'hi-x' } }, chain);
        const hit = (sink as jest.Mock).mock.calls[0][0];
        expect(hit).toMatchObject({
            shortPath: 'hi-x', source: 'link',
            country: null, region: null, city: null, device: null, lang: null, os: null, browser: null,
        });
        expect(hit.requestId).toEqual(expect.any(String));
    });

    test('an SQS failure still redirects', async () => {
        const sqs = { send: jest.fn().mockRejectedValue(new Error('AccessDenied')) };
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { chain } = hiChain({ 'hi-x': 'example.com' }, sqsHitSink(sqs, 'https://sqs.example/q'));
        await expect(handle(event('hi-x'), chain)).resolves.toEqual({
            statusCode: 302,
            headers: { Location: 'https://example.com', 'Cache-Control': 'no-store' },
        });
        expect(sqs.send).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
    });

    test('a hung SQS call is abandoned after the timeout and the redirect carries on', async () => {
        const sqs = {
            send: jest.fn((_cmd: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
                opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
            })),
        };
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { chain } = hiChain({ 'hi-x': 'example.com' }, sqsHitSink(sqs as any, 'https://sqs.example/q', 20));
        const started = Date.now();
        await expect(handle(event('hi-x'), chain)).resolves.toMatchObject({ statusCode: 302 });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('timed out after 20 ms'));
    });

    test('unknown hi- link → no event, falls through to Google as before', async () => {
        const { chain, sink } = hiChain({});
        await expect(handle(event('hi-nope'), chain)).resolves.toMatchObject({ statusCode: 301 });
        expect(sink).not.toHaveBeenCalled();
    });

    test('ordinary links are unchanged: 301, max-age=600, no event', async () => {
        const { chain, sink } = hiChain({ hn: 'https://news.ycombinator.com', hiking: 'example.com' });
        await expect(handle(event('hn'), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://news.ycombinator.com', 'Cache-Control': 'max-age=600' },
        });
        // Starts with "hi" but not "hi-".
        await expect(handle(event('hiking'), chain)).resolves.toMatchObject({ statusCode: 301 });
        expect(sink).not.toHaveBeenCalled();
    });

    test('a bare "hi-" is an ordinary link, not a counted one', () => {
        expect(matchShortLink('hi-')).toEqual({ shortPath: 'hi-' });
        expect(matchShortLink('HI-')).toEqual({ shortPath: 'HI-' });
    });

    test('namespace resolvers do not claim counted paths', () => {
        for (const path of ['hi-x', 'HI-X', 'Hi-X', 'q01', 'Q01']) {
            expect(imdbResolver(jest.fn() as any).match(path)).toBeNull();
            expect(ticketResolver({ send: jest.fn() } as any, 't').match(path)).toBeNull();
            expect(catResolver.match(path)).toBeNull();
        }
    });
});

// HOME-529: per-link opt-in query-string passthrough
describe('query-string passthrough', () => {
    const cb = 'http://127.0.0.1:8765/aliexpress/callback';
    const withQ = (shortPath: string, multi: Record<string, string[]>) =>
        ({ pathParameters: { shortPath }, multiValueQueryStringParameters: multi });

    test('passthrough on: the query is appended', async () => {
        const { chain } = chainWith({ alifinder: cb }, { alifinder: true });
        await expect(handle(withQ('alifinder', { code: ['test'], x: ['1'] }), chain)).resolves.toEqual({
            statusCode: 301,
            headers: { Location: `${cb}?code=test&x=1`, 'Cache-Control': 'max-age=600' },
        });
    });

    test('passthrough on: merged with the target query, target wins on a clash', async () => {
        const { chain } = chainWith({ l: 'https://e.com/p?a=1&b=2#frag' }, { l: true });
        await expect(handle(withQ('l', { b: ['9'], c: ['3'] }), chain)).resolves.toMatchObject({
            headers: { Location: 'https://e.com/p?a=1&b=2&c=3#frag' },
        });
    });

    test('passthrough on: no incoming query leaves the target alone', async () => {
        const { chain } = chainWith({ l: 'https://e.com/p?a=1' }, { l: true });
        await expect(handle({ pathParameters: { shortPath: 'l' } }, chain)).resolves.toMatchObject({
            headers: { Location: 'https://e.com/p?a=1' },
        });
    });

    test.each([
        ['false', { alifinder: false }],
        ['missing', {}],
    ])('passthrough %s: the query is dropped', async (_name, flags) => {
        const { chain } = chainWith({ alifinder: cb }, flags);
        await expect(handle(withQ('alifinder', { code: ['test'] }), chain)).resolves.toMatchObject({
            headers: { Location: cb },
        });
    });

    test('other resolvers ignore the query', async () => {
        const { chain } = chainWith({}, {});
        await expect(handle(withQ('some words', { code: ['x'] }), chain)).resolves.toMatchObject({
            headers: { Location: 'https://www.google.co.uk/search?q=some%20words' },
        });
    });

    test('the query is never logged', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const { chain } = chainWith({ alifinder: cb }, { alifinder: true });
        await handle(withQ('alifinder', { code: ['SECRET'] }), chain);
        expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
        log.mockRestore();
    });

    test('queryOf re-encodes values and keeps repeated keys', () => {
        expect(queryOf({ multiValueQueryStringParameters: { a: ['b c', 'd&e'], 'k y': ['1'] } })).toBe('a=b%20c&a=d%26e&k%20y=1');
        expect(queryOf({ queryStringParameters: { a: '1' } })).toBe('a=1');
        expect(queryOf({})).toBe('');
    });

    test('withQuery compares keys after decoding and preserves encoding', () => {
        expect(withQuery('https://e.com/?a%20b=1', 'a+b=2&c=%2F')).toBe('https://e.com/?a%20b=1&c=%2F');
    });
});
