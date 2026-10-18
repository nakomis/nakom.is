import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import { parseUserAgent } from '../shortener/hits';

const dynamoClient = new DynamoDBClient({});

// PII obfuscation functions

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Network(ip: string): string | null {
  const m = IPV4.exec(ip);
  if (!m || m.slice(1).some((octet) => Number(octet) > 255)) return null;
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}.0/24`;
}

/** The first three hextets of an IPv6 address, with `::` expanded, or null if it isn't one. */
function ipv6Prefix(ip: string): string[] | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const hextets = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  if (!hextets.every((h) => /^[0-9a-f]{1,4}$/i.test(h))) return null;
  return hextets.slice(0, 3).map((h) => parseInt(h, 16).toString(16));
}

/**
 * Reduces the visitor's IP to its network (NAKIS-38): a /24 for IPv4 and a /48
 * for IPv6, written as CIDR. Enough to group abusive traffic, not enough to
 * identify a household. Anything unparseable is dropped.
 */
export function obfuscateIP(ip: string): string {
  if (ip === 'unknown') return ip;

  const v4 = ipv4Network(ip);
  if (v4) return v4;

  // IPv4-mapped IPv6 (::ffff:203.0.113.42) is really an IPv4 address.
  const mapped = /^::ffff:(.+)$/i.exec(ip);
  if (mapped) {
    const inner = ipv4Network(mapped[1]);
    if (inner) return inner;
  }

  const v6 = ipv6Prefix(ip.split('%')[0]);
  if (v6) return `${v6.join(':')}::/48`;

  return 'unknown';
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

  // Note: Name obfuscation removed - only emails and phone numbers should be obfuscated

  // If message is very long, truncate with indicator
  if (obfuscated.length > 500) {
    obfuscated = obfuscated.substring(0, 500) + '... [TRUNCATED]';
  }

  return obfuscated;
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
  // Reduced to coarse OS and browser families, as the HAND-22 hit events are; the raw string is not kept.
  const { os, browser } = parseUserAgent(headers['user-agent'] ?? headers['User-Agent'] ?? null);
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
    userAgent: `${os ?? 'unknown'} / ${browser ?? 'unknown'}`,
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