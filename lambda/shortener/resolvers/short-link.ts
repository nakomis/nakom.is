import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { buildHitEvent, HIT_PREFIX, HitSink, HitSource, QR_CODE } from '../hits';
import { redirect, Resolver, withQuery } from '../resolver';

export type DynamoSender = Pick<DynamoDBClient, 'send'>;

export interface ShortLinkMatch {
    /** The key in the redirects table. */
    shortPath: string;
    /** Set only for the book's counted links (`hi-…` and `q01`…`q99`), which are uncached and publish a hit event. */
    source?: HitSource;
}

/**
 * Pure: which redirects-table key a path refers to, and whether it is one of
 * the book's counted links (HAND-22).
 *
 * Two forms are counted, both case-insensitively and looked up in lower case
 * (so their rows must be stored in lower case):
 *
 *  - `hi-<slug>`, the link printed in the book: source `link`.
 *  - `q01` … `q99`, the QR-only codes. A QR code in alphanumeric mode (the
 *    smallest grid, so the biggest modules) can encode only capitals, so they
 *    arrive as `Q01`. Source `qr`. Each is an ordinary row in the redirects
 *    table pointing at the same URL as its `hi-` link; the book's links.json
 *    maps Q-numbers to slugs, so nothing here needs to.
 *
 * Exactly two digits: `q1` and `q001` are ordinary short links. Every other
 * path keeps its case and behaves exactly as before.
 */
export function matchShortLink(path: string): ShortLinkMatch | null {
    if (path === '') {
        return null;
    }
    const lower = path.toLowerCase();
    if (QR_CODE.test(lower)) {
        return { shortPath: lower, source: 'qr' };
    }
    if (lower.startsWith(HIT_PREFIX) && lower.length > HIT_PREFIX.length) {
        return { shortPath: lower, source: 'link' };
    }
    return { shortPath: path };
}

// Looks the path up in the redirects table, incrementing its hit count.
// Declines (returns null) when there's no such short link.
//
// Ordinary links: 301 with max-age=600, as they always have been. Counted links:
// 302 with no-store, so every visit reaches the Lambda, plus one hit event per
// visit when a sink is configured.
export function shortLinkResolver(client: DynamoSender, tableName: string, hits?: HitSink): Resolver<ShortLinkMatch> {
    return {
        name: 'short-link',
        match: matchShortLink,
        resolve: async ({ shortPath: path, source }, request) => {
            let url: string | undefined;
            let passthrough = false;
            try {
                const result = await client.send(new UpdateItemCommand({
                    TableName: tableName,
                    Key: { shortPath: { S: path } },
                    UpdateExpression: 'ADD hitCount :one',
                    ConditionExpression: 'attribute_exists(shortPath)',
                    ExpressionAttributeValues: { ':one': { N: '1' } },
                    ReturnValues: 'ALL_NEW',
                }));
                url = result.Attributes?.url?.S;
                passthrough = result.Attributes?.passthrough?.BOOL === true;
            } catch (err) {
                if (err instanceof ConditionalCheckFailedException) {
                    return null;
                }
                throw err;
            }

            if (!url) {
                return null;
            }
            if (!url.startsWith('http') && !url.startsWith('chrome://')) {
                url = `https://${url}`;
            }
            // Opt-in per link (`passthrough` BOOL on the item, set by `nis --passthrough`):
            // the query is merged into the target, never logged (it may hold an OAuth code).
            if (passthrough) {
                url = withQuery(url, request.query);
            }
            console.log(`Redirecting: ${path}`);
            if (!source) {
                return redirect(url, 'max-age=600');
            }
            if (hits) {
                // The sink bounds its own wait and never throws (see hits.ts).
                await hits(buildHitEvent(path, source, request));
            }
            return redirect(url, 'no-store', 302);
        },
    };
}
