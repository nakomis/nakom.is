import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AnyResolver, RedirectResponse, runChain } from './resolver';
import { catResolver } from './resolvers/cat';
import { googleResolver } from './resolvers/google';
import { shortLinkResolver } from './resolvers/short-link';
import { taigaResolver } from './resolvers/taiga';

export interface ShortenerEvent {
    pathParameters?: { shortPath?: string } | null;
}

const client = new DynamoDBClient({});

// Order matters: first match wins, Google is always last.
const resolvers: AnyResolver[] = [
    catResolver,
    taigaResolver(client, process.env.TICKET_PROJECTS_TABLE ?? 'ticket-projects'),
    shortLinkResolver(client, process.env.REDIRECTS_TABLE ?? 'redirects'),
    googleResolver,
];

// API Gateway hands over proxy path parameters still percent-encoded
function decodePath(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export async function handle(event: ShortenerEvent, chain: AnyResolver[]): Promise<RedirectResponse> {
    const path = decodePath(event.pathParameters?.shortPath ?? '');
    return runChain(path, chain);
}

export const handler = (event: ShortenerEvent) => handle(event, resolvers);
