import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { runChain } from '../resolver';
import { googleResolver } from './google';
import { DynamoSender } from './short-link';
import { ticketResolver } from './tickets';

const HOME = 'https://plane.home.nakomis.com/nakomis/browse/HOME-{ref}/';

function fakeProjects(templates: Record<string, string>) {
    const commands: GetItemCommand[] = [];
    const client = {
        send: jest.fn(async (command: GetItemCommand) => {
            commands.push(command);
            const alias = command.input.Key!.alias.S!;
            return alias in templates ? { Item: { alias: { S: alias }, urlTemplate: { S: templates[alias] } } } : {};
        }),
    } as unknown as DynamoSender;
    return { client, commands };
}

function resolve(path: string, templates: Record<string, string> = { home: HOME }) {
    const { client, commands } = fakeProjects(templates);
    const chain = [ticketResolver(client, 'ticket-projects'), googleResolver];
    return { result: runChain(path, chain), commands };
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('ticket resolver', () => {
    test.each([
        'plane/home 123',
        'plane/home  123',
        'plane/home+123',
        'plane/home #123',
        'plane/HOME 123',
        'plane/ home 123 ',
        'plane/HOME-123',
        'plane/home-123',
        'taiga/home 123',
        'taiga/HOME-123',
    ])('%s → work item 123, uncached 302', async (path) => {
        const { result, commands } = resolve(path);
        await expect(result).resolves.toEqual({
            statusCode: 302,
            headers: {
                Location: 'https://plane.home.nakomis.com/nakomis/browse/HOME-123/',
                'Cache-Control': 'no-store',
            },
        });
        expect(commands[0].input).toEqual({ TableName: 'ticket-projects', Key: { alias: { S: 'home' } } });
    });

    test('fills every {ref} in the template', async () => {
        const { result } = resolve('plane/x 7', { x: 'https://example.com/{ref}?focus={ref}' });
        await expect(result).resolves.toMatchObject({ headers: { Location: 'https://example.com/7?focus=7' } });
    });

    test('unknown alias → Google search for the query', async () => {
        const { result } = resolve('plane/nope 123');
        await expect(result).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk/search?q=nope%20123', 'Cache-Control': 'no-store' },
        });
    });

    test.each(['plane/home', 'plane/home abc', 'plane/', 'plane/home 12 34', 'plane/home--12', 'taiga/home'])(
        'malformed %s → Google search without a table lookup',
        async (path) => {
            const { result, commands } = resolve(path);
            await expect(result).resolves.toMatchObject({ statusCode: 301 });
            expect(commands).toHaveLength(0);
        },
    );

    test('ignores paths outside plane/ and taiga/', () => {
        const { client } = fakeProjects({});
        const resolver = ticketResolver(client, 'ticket-projects');
        expect(resolver.match('plane')).toBeNull();
        expect(resolver.match('taiga')).toBeNull();
        expect(resolver.match('planehome 123')).toBeNull();
        expect(resolver.match('hn')).toBeNull();
    });
});
