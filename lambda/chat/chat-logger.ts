import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});

export interface LogEntryInput {
  event: any;
  conversationId: string;
  userMessage: string;
  messageCount: number;
  toolsCalled: string[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  rateLimited: boolean;
}

export interface LogEntry {
  logType: string;
  sk: string;
  conversationId: string;
  ip: string;
  userAgent: string;
  country: string;
  userMessage: string;
  messageCount: number;
  toolsCalled: Set<string>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  rateLimited: boolean;
  ttl: number;
}

export function buildLogEntry(input: LogEntryInput): LogEntry {
  const headers = input.event?.headers ?? {};
  const forwarded: string = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'] ?? '';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  const userAgent: string = headers['user-agent'] ?? headers['User-Agent'] ?? 'unknown';
  const country: string = headers['cloudfront-viewer-country'] ?? headers['CloudFront-Viewer-Country'] ?? 'unknown';

  const now = new Date();
  const timestamp = now.toISOString();
  const requestId = randomUUID();
  const ttl = Math.floor(now.getTime() / 1000) + 365 * 24 * 60 * 60;

  return {
    logType: 'CVCHAT',
    sk: `${timestamp}#${requestId}`,
    conversationId: input.conversationId,
    ip,
    userAgent,
    country,
    userMessage: input.userMessage,
    messageCount: input.messageCount,
    toolsCalled: new Set(input.toolsCalled),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    durationMs: input.durationMs,
    rateLimited: input.rateLimited,
    ttl,
  };
}

export async function writeLogEntry(entry: LogEntry, tableName: string): Promise<void> {
  const item: Record<string, any> = {
    logType: { S: entry.logType },
    sk: { S: entry.sk },
    conversationId: { S: entry.conversationId },
    ip: { S: entry.ip },
    userAgent: { S: entry.userAgent },
    country: { S: entry.country },
    userMessage: { S: entry.userMessage.slice(0, 2000) }, // guard against oversized values
    messageCount: { N: String(entry.messageCount) },
    inputTokens: { N: String(entry.inputTokens) },
    outputTokens: { N: String(entry.outputTokens) },
    durationMs: { N: String(entry.durationMs) },
    rateLimited: { BOOL: entry.rateLimited },
    ttl: { N: String(entry.ttl) },
  };

  if (entry.toolsCalled.size > 0) {
    item.toolsCalled = { SS: [...entry.toolsCalled] };
  }

  await dynamoClient.send(new PutItemCommand({
    TableName: tableName,
    Item: item,
  }));
}