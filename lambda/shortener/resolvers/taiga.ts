import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { redirect, Resolver } from '../resolver';
import { googleSearch } from './google';
import { DynamoSender } from './short-link';

export interface TaigaMatch {
    query: string;
    alias?: string;
    ref?: string;
}

const PREFIX = 'taiga/';

// "home 123", "home #123", "home+123"
const ALIAS_AND_REF = /^([a-z0-9-]+)[\s+]+#?(\d+)$/i;

// nakom.is/taiga/home 123 → the urlTemplate stored for "home", with {ref} filled in.
// Unknown aliases and malformed input fall back to a Google search for the query.
export function taigaResolver(client: DynamoSender, tableName: string): Resolver<TaigaMatch> {
    return {
        name: 'taiga',
        match: (path) => {
            if (!path.startsWith(PREFIX)) {
                return null;
            }
            const query = path.slice(PREFIX.length).trim();
            const parsed = ALIAS_AND_REF.exec(query);
            return parsed ? { query, alias: parsed[1].toLowerCase(), ref: parsed[2] } : { query };
        },
        resolve: async ({ query, alias, ref }) => {
            if (!alias || !ref) {
                console.log(`Taiga: couldn't parse "${query}"`);
                return googleSearch(query);
            }
            const result = await client.send(new GetItemCommand({
                TableName: tableName,
                Key: { alias: { S: alias } },
            }));
            const template = result.Item?.urlTemplate?.S;
            if (!template) {
                console.log(`Taiga: unknown alias "${alias}"`);
                return googleSearch(query);
            }
            console.log(`Taiga: ${alias} ${ref}`);
            return redirect(template.split('{ref}').join(ref), 'no-store', 302);
        },
    };
}
