import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { redirect, Resolver } from '../resolver';

export type DynamoSender = Pick<DynamoDBClient, 'send'>;

// Looks the path up in the redirects table, incrementing its hit count.
// Declines (returns null) when there's no such short link.
export function shortLinkResolver(client: DynamoSender, tableName: string): Resolver<string> {
    return {
        name: 'short-link',
        match: (path) => (path === '' ? null : path),
        resolve: async (path) => {
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
            return redirect(url, 'max-age=600');
        },
    };
}
