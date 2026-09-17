import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { runChain } from '../resolver';
import { googleResolver } from './google';
import { DynamoSender } from './short-link';
import { ticketResolver } from './tickets';

interface ProjectRow {
    urlTemplate?: string;
    projectUrl?: string;
}

const HOME: ProjectRow = {
    urlTemplate: 'https://plane.home.nakomis.com/nakomis/browse/HOME-{ref}/',
    projectUrl: 'https://plane.home.nakomis.com/nakomis/projects/b709434e-ddb5-41b1-a35a-063c9247c52a/issues/',
};

function fakeProjects(rows: Record<string, ProjectRow>) {
    const commands: GetItemCommand[] = [];
    const client = {
        send: jest.fn(async (command: GetItemCommand) => {
            commands.push(command);
            const alias = command.input.Key!.alias.S!;
            const row = rows[alias];
            if (!row) {
                return {};
            }
            const item: Record<string, { S: string }> = { alias: { S: alias } };
            if (row.urlTemplate) item.urlTemplate = { S: row.urlTemplate };
            if (row.projectUrl) item.projectUrl = { S: row.projectUrl };
            return { Item: item };
        }),
    } as unknown as DynamoSender;
    return { client, commands };
}

function resolve(path: string, rows: Record<string, ProjectRow> = { home: HOME }) {
    const { client, commands } = fakeProjects(rows);
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
        const { result } = resolve('plane/x 7', { x: { urlTemplate: 'https://example.com/{ref}?focus={ref}' } });
        await expect(result).resolves.toMatchObject({ headers: { Location: 'https://example.com/7?focus=7' } });
    });

    test.each(['plane/home', 'plane/HOME', 'plane/ home ', 'taiga/home'])('%s → the project page, uncached 302', async (path) => {
        const { result, commands } = resolve(path);
        await expect(result).resolves.toEqual({
            statusCode: 302,
            headers: { Location: HOME.projectUrl, 'Cache-Control': 'no-store' },
        });
        expect(commands[0].input.Key).toEqual({ alias: { S: 'home' } });
    });

    test('alias without a project URL → Google search', async () => {
        const { result } = resolve('plane/old', { old: { urlTemplate: HOME.urlTemplate } });
        await expect(result).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk/search?q=old', 'Cache-Control': 'no-store' },
        });
    });

    test('unknown alias without a ref → Google search', async () => {
        const { result } = resolve('plane/nope');
        await expect(result).resolves.toMatchObject({ statusCode: 301, headers: { Location: 'https://www.google.co.uk/search?q=nope' } });
    });

    test('unknown alias → Google search for the query', async () => {
        const { result } = resolve('plane/nope 123');
        await expect(result).resolves.toEqual({
            statusCode: 301,
            headers: { Location: 'https://www.google.co.uk/search?q=nope%20123', 'Cache-Control': 'no-store' },
        });
    });

    test.each(['plane/home abc', 'plane/', 'plane/home 12 34', 'plane/home--12', 'plane/home-'])(
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
