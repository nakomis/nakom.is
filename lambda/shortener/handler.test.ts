import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { handle } from './handler';
import { AnyResolver } from './resolver';
import { catResolver } from './resolvers/cat';
import { googleResolver } from './resolvers/google';
import { DynamoSender, shortLinkResolver } from './resolvers/short-link';

function fakeTable(links: Record<string, string>) {
    const commands: UpdateItemCommand[] = [];
    const client = {
        send: jest.fn(async (command: UpdateItemCommand) => {
            commands.push(command);
            const key = command.input.Key!.shortPath.S!;
            if (!(key in links)) {
                throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
            }
            return { Attributes: { shortPath: { S: key }, url: { S: links[key] }, hitCount: { N: '1' } } };
        }),
    } as unknown as DynamoSender;
    return { client, commands };
}

function chainWith(links: Record<string, string>) {
    const table = fakeTable(links);
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
