import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { buildHitEvent, HIT_PREFIX, HitSink, HitSource, QR_SUFFIX } from '../hits';
import { redirect, Resolver } from '../resolver';

export type DynamoSender = Pick<DynamoDBClient, 'send'>;

export interface ShortLinkMatch {
    /** The key in the redirects table. */
    shortPath: string;
    /** Set only for `hi-` links, which are uncached and publish a hit event. */
    source?: HitSource;
}

/**
 * Pure: which redirects-table key a path refers to.
 *
 * `hi-` links (HAND-22) may carry a trailing `/q`, which the book's QR codes
 * add so a scan can be told from a typed link. It is stripped before the
 * lookup, so both forms hit the same row. Both are matched in any case and
 * looked up in lower case, so `hi-` rows must be stored in lower case. Short links never otherwise contain a
 * `/`, and no namespace resolver claims `hi-…/`, so the suffix cannot collide.
 */
export function matchShortLink(path: string): ShortLinkMatch | null {
    if (path === '') {
        return null;
    }
    // Case-insensitive for hi- links only: a QR code in alphanumeric mode (a
    // smaller grid, so bigger modules) can only encode capitals, so the book's
    // codes may arrive as HI-PYTHAGORAS/Q. The key is always lower case.
    // Ordinary short links keep their case exactly as before.
    const lower = path.toLowerCase();
    if (lower.startsWith(HIT_PREFIX)) {
        if (lower.endsWith(QR_SUFFIX) && lower.length > HIT_PREFIX.length + QR_SUFFIX.length) {
            return { shortPath: lower.slice(0, -QR_SUFFIX.length), source: 'qr' };
        }
        return { shortPath: lower, source: 'link' };
    }
    return { shortPath: path };
}

// Looks the path up in the redirects table, incrementing its hit count.
// Declines (returns null) when there's no such short link.
//
// Ordinary links: 301 with max-age=600, as they always have been. `hi-` links:
// 302 with no-store, so every visit reaches the Lambda, plus one hit event per
// visit when a sink is configured.
export function shortLinkResolver(client: DynamoSender, tableName: string, hits?: HitSink): Resolver<ShortLinkMatch> {
    return {
        name: 'short-link',
        match: matchShortLink,
        resolve: async ({ shortPath: path, source }, request) => {
            let url: string | undefined;
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
