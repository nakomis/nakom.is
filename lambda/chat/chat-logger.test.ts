import { buildLogEntry } from './chat-logger';

describe('buildLogEntry', () => {
  const baseEvent = {
    headers: {
      'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      'user-agent': 'Mozilla/5.0',
      'cloudfront-viewer-country': 'GB',
    },
    requestContext: {},
  };

  it('extracts the first IP from X-Forwarded-For and obfuscates it', () => {
    const entry = buildLogEntry({
      event: baseEvent,
      conversationId: 'conv-123',
      userMessage: 'Hello',
      messageCount: 1,
      toolsCalled: ['get_cv'],
      inputTokens: 150,
      outputTokens: 300,
      durationMs: 1234,
      rateLimited: false,
    });

    expect(entry.ip).toBe('203.0.***.***');
    expect(entry.logType).toBe('CVCHAT');
    expect(entry.userMessage).toBe('Hello');
    expect(entry.toolsCalled).toEqual(new Set(['get_cv']));
    expect(entry.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('handles missing X-Forwarded-For gracefully', () => {
    const event = { headers: {}, requestContext: {} };
    const entry = buildLogEntry({ event, conversationId: 'c', userMessage: 'm',
      messageCount: 1, toolsCalled: [], inputTokens: 0, outputTokens: 0,
      durationMs: 0, rateLimited: false });
    expect(entry.ip).toBe('unknown');
  });

  it('sets ttl to approximately 1 year from now', () => {
    const entry = buildLogEntry({ event: baseEvent, conversationId: 'c',
      userMessage: 'm', messageCount: 1, toolsCalled: [], inputTokens: 0,
      outputTokens: 0, durationMs: 0, rateLimited: false });
    const oneYear = 365 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    expect(entry.ttl).toBeGreaterThanOrEqual(now + oneYear - 5);
    expect(entry.ttl).toBeLessThanOrEqual(now + oneYear + 5);
  });

  it('obfuscates PII in user messages', () => {
    const eventWithPII = {
      headers: {
        'x-forwarded-for': '192.168.1.100',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      requestContext: {},
    };

    const entry = buildLogEntry({
      event: eventWithPII,
      conversationId: 'conv-123',
      userMessage: 'My email is john.doe@company.com and my phone is 555-123-4567. Contact John Smith for details.',
      messageCount: 1,
      toolsCalled: [],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      rateLimited: false,
    });

    expect(entry.ip).toBe('192.168.***.***');
    expect(entry.userMessage).toContain('joh***@***.com');
    expect(entry.userMessage).toContain('***-***-****');
    expect(entry.userMessage).toContain('*** ***');
    expect(entry.userAgent).toContain('x.x.x');
  });
});