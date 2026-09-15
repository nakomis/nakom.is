import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { redirect, Resolver } from '../resolver';
import { googleSearch } from './google';
import { DynamoSender } from './short-link';

export interface TicketMatch {
    query: string;
    alias?: string;
    ref?: string;
}

// plane/ is the current prefix; taiga/ keeps pre-Plane bookmarks and keywords working
const PREFIXES = ['plane/', 'taiga/'];

// "home 123", "home #123", "home+123", "HOME-123"
const ALIAS_AND_REF = /^([a-z0-9]+)(?:[\s+]+#?|-)(\d+)$/i;

// nakom.is/plane/home 123 → the urlTemplate stored for "home", with {ref} filled in.
// Unknown aliases and malformed input fall back to a Google search for the query.
export function ticketResolver(client: DynamoSender, tableName: string): Resolver<TicketMatch> {
    return {
        name: 'tickets',
        match: (path) => {
            const prefix = PREFIXES.find((p) => path.startsWith(p));
            if (!prefix) {
                return null;
            }
            const query = path.slice(prefix.length).trim();
            const parsed = ALIAS_AND_REF.exec(query);
            return parsed ? { query, alias: parsed[1].toLowerCase(), ref: parsed[2] } : { query };
        },
        resolve: async ({ query, alias, ref }) => {
            if (!alias || !ref) {
                console.log(`Tickets: couldn't parse "${query}"`);
                return googleSearch(query);
            }
            const result = await client.send(new GetItemCommand({
                TableName: tableName,
                Key: { alias: { S: alias } },
            }));
            const template = result.Item?.urlTemplate?.S;
            if (!template) {
                console.log(`Tickets: unknown alias "${alias}"`);
                return googleSearch(query);
            }
            console.log(`Tickets: ${alias} ${ref}`);
            return redirect(template.split('{ref}').join(ref), 'no-store', 302);
        },
    };
}
