import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const dynamoClient = new DynamoDBClient({});
const TABLE_NAME = process.env.RATE_LIMIT_TABLE || 'chat-rate-limits';

export async function checkRateLimit(dailyLimit: number): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days from now

  try {
    const result = await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        date: { S: today },
      },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#count': 'requestCount',
        '#ttl': 'expiry',
      },
      ExpressionAttributeValues: {
        ':zero': { N: '0' },
        ':one': { N: '1' },
        ':ttl': { N: ttl.toString() },
      },
      ReturnValues: 'UPDATED_NEW',
    }));

    const currentCount = parseInt(result.Attributes?.requestCount?.N || '0', 10);
    const remaining = Math.max(0, dailyLimit - currentCount);

    return {
      allowed: currentCount <= dailyLimit,
      remaining,
    };
  } catch (err) {
    console.error('Rate limiter error:', err);
    // Fail open - allow the request if DynamoDB is unavailable
    return { allowed: true, remaining: -1 };
  }
}
