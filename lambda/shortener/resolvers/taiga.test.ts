import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { runChain } from '../resolver';
import { googleResolver } from './google';
import { DynamoSender } from './short-link';
import { taigaResolver } from './taiga';

const HOME = 'https://taiga.home.nakomis.com/project/home-infrastructure/us/{ref}';

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
    const chain = [taigaResolver(client, 'ticket-projects'), googleResolver];
    return { result: runChain(path, chain), commands };
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('taiga resolver', () => {
    test.each([
        'taiga/home 123',
        'taiga/home  123',
        'taiga/home+123',
        'taiga/home #123',
        'taiga/HOME 123',
        'taiga/ home 123 ',
    ])('%s → user story 123, uncached 302', async (path) => {
        const { result, commands } = resolve(path);
        await expect(result).resolves.toEqual({
            statusCode: 302,
            headers: {
                Location: 'https://taiga.home.nakomis.com/project/home-infrastructure/us/123',
                'Cache-Control': 'no-store',
            },
        });
        expect(commands[0].input).toEqual({ TableName: 'ticket-projects', Key: { alias: { S: 'home' } } });
    });

    test('fills every {ref} in the template', async () => {
        const { result } = resolve('taiga/x 7', { x: 'https://example.com/{ref}?focus={ref}' });
        await expect(result).resolves.toMatchObject({ headers: { Location: 'https://example.com/7?focus=7' } });
    });

    test('unknown alias → Google search for the query', async () => {
        const { result } = resolve('taiga/nope 123');
        await expect(result).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk/search?q=nope%20123', 'Cache-Control': 'no-store' },
        });
    });

    test.each(['taiga/home', 'taiga/home abc', 'taiga/', 'taiga/home 12 34'])(
        'malformed %s → Google search without a table lookup',
        async (path) => {
            const { result, commands } = resolve(path);
            await expect(result).resolves.toMatchObject({ statusCode: 301 });
            expect(commands).toHaveLength(0);
        },
    );

    test('ignores paths outside taiga/', () => {
        const { client } = fakeProjects({});
        const resolver = taigaResolver(client, 'ticket-projects');
        expect(resolver.match('taiga')).toBeNull();
        expect(resolver.match('taigahome 123')).toBeNull();
        expect(resolver.match('hn')).toBeNull();
    });
});
