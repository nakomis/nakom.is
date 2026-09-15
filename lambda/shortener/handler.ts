import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AnyResolver, RedirectResponse, runChain } from './resolver';
import { catResolver } from './resolvers/cat';
import { googleResolver } from './resolvers/google';
import { shortLinkResolver } from './resolvers/short-link';

export interface ShortenerEvent {
    pathParameters?: { shortPath?: string } | null;
}

const client = new DynamoDBClient({});

// Order matters: first match wins, Google is always last.
const resolvers: AnyResolver[] = [
    catResolver,
    shortLinkResolver(client, process.env.REDIRECTS_TABLE ?? 'redirects'),
    googleResolver,
];

export async function handle(event: ShortenerEvent, chain: AnyResolver[]): Promise<RedirectResponse> {
    const path = event.pathParameters?.shortPath ?? '';
    return runChain(path, chain);
}

export const handler = (event: ShortenerEvent) => handle(event, resolvers);
