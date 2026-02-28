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

  it('extracts the first IP from X-Forwarded-For', () => {
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

    expect(entry.ip).toBe('203.0.113.42');
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
});