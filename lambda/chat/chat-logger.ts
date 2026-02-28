import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const dynamoClient = new DynamoDBClient({});

// PII obfuscation functions
function obfuscateIP(ip: string): string {
  if (ip === 'unknown') return ip;

  // IPv4: 192.168.1.100 → 192.168.***.***
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
  }

  // IPv6: 2001:db8::1 → 2001:db8::***
  if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length >= 3) {
      return `${parts[0]}:${parts[1]}::***`;
    }
  }

  return '***';
}

function obfuscateEmail(email: string): string {
  const emailRegex = /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  return email.replace(emailRegex, (match, localPart, domain) => {
    const obfuscatedLocal = localPart.length <= 3
      ? localPart.charAt(0) + '***'
      : localPart.substring(0, 3) + '***';

    const domainParts = domain.split('.');
    const obfuscatedDomain = domainParts.length >= 2
      ? '***.' + domainParts[domainParts.length - 1]
      : '***';

    return `${obfuscatedLocal}@${obfuscatedDomain}`;
  });
}

function obfuscatePhoneNumber(text: string): string {
  // Common phone patterns: +44 123 456 7890, (555) 123-4567, 555-123-4567, etc.
  const phoneRegex = /(?:\+\d{1,3}\s?)?(?:\(\d{3}\)|\d{3})[\s\-.]?\d{3}[\s\-.]?(\d{4})/g;
  return text.replace(phoneRegex, (match, lastFour) => `***-***-${lastFour}`);
}

function obfuscateUserMessage(message: string): string {
  if (!message || message.length === 0) return message;

  let obfuscated = message;

  // Obfuscate emails
  obfuscated = obfuscateEmail(obfuscated);

  // Obfuscate phone numbers
  obfuscated = obfuscatePhoneNumber(obfuscated);

  // Obfuscate potential names (sequences of 2+ capitalized words)
  obfuscated = obfuscated.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/g, '*** ***');

  // If message is very long, truncate with indicator
  if (obfuscated.length > 500) {
    obfuscated = obfuscated.substring(0, 500) + '... [TRUNCATED]';
  }

  return obfuscated;
}

function obfuscateUserAgent(userAgent: string): string {
  if (userAgent === 'unknown') return userAgent;

  // Keep browser/OS info but remove version details that could be identifying
  return userAgent
    .replace(/\d+\.\d+(?:\.\d+)*/g, 'x.x.x') // Version numbers (2 or 3+ parts)
    .replace(/[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}/ig, 'XXXX-XXXX') // UUIDs
    .substring(0, 200); // Truncate very long UAs
}

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
  const rawIP = forwarded.split(',')[0]?.trim() || 'unknown';
  const rawUserAgent: string = headers['user-agent'] ?? headers['User-Agent'] ?? 'unknown';
  const country: string = headers['cloudfront-viewer-country'] ?? headers['CloudFront-Viewer-Country'] ?? 'unknown';

  const now = new Date();
  const timestamp = now.toISOString();
  const requestId = randomUUID();
  const ttl = Math.floor(now.getTime() / 1000) + 365 * 24 * 60 * 60;

  return {
    logType: 'CVCHAT',
    sk: `${timestamp}#${requestId}`,
    conversationId: input.conversationId,
    ip: obfuscateIP(rawIP),
    userAgent: obfuscateUserAgent(rawUserAgent),
    country,
    userMessage: obfuscateUserMessage(input.userMessage),
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