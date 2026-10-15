import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { HitSink, sqsHitSink } from './hits';
import { AnyResolver, RedirectResponse, runChain, ShortenerRequest } from './resolver';
import { catResolver } from './resolvers/cat';
import { googleResolver } from './resolvers/google';
import { imdbResolver } from './resolvers/imdb';
import { shortLinkResolver } from './resolvers/short-link';
import { ticketResolver } from './resolvers/tickets';

export interface ShortenerEvent {
    pathParameters?: { shortPath?: string } | null;
    headers?: Record<string, string | undefined> | null;
    requestContext?: { requestId?: string } | null;
}

const client = new DynamoDBClient({});

// Hit events for `hi-` links (HAND-22). Off when the queue isn't configured,
// so the Lambda behaves exactly as before. One attempt only: the sink's own
// short timeout is the budget, and a retry could not finish inside it anyway.
const hitsQueueUrl = process.env.HITS_QUEUE_URL;
const hits: HitSink | undefined = hitsQueueUrl
    ? sqsHitSink(new SQSClient({ maxAttempts: 1 }), hitsQueueUrl)
    : undefined;

// Order matters: first match wins, Google is always last.
const resolvers: AnyResolver[] = [
    catResolver,
    imdbResolver(),
    ticketResolver(client, process.env.TICKET_PROJECTS_TABLE ?? 'ticket-projects'),
    shortLinkResolver(client, process.env.REDIRECTS_TABLE ?? 'redirects', hits),
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
    const request: ShortenerRequest = {
        headers: event.headers ?? {},
        requestId: event.requestContext?.requestId ?? randomUUID(),
    };
    return runChain(path, chain, request);
}

export const handler = (event: ShortenerEvent) => handle(event, resolvers);
