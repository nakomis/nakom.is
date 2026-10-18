import { buildLogEntry, obfuscateIP, summariseEventForLog } from './chat-logger';

describe('buildLogEntry', () => {
  const baseEvent = {
    headers: {
      'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      'user-agent': 'Mozilla/5.0',
      'cloudfront-viewer-country': 'GB',
    },
    requestContext: {},
  };

  it('stores the /24 of the first IP in X-Forwarded-For', () => {
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

    expect(entry.ip).toBe('203.0.113.0/24');
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
    expect(entry.userAgent).toBe('unknown / unknown');
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

  it('obfuscates only emails and phone numbers in user messages', () => {
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

    expect(entry.ip).toBe('192.168.1.0/24');
    expect(entry.userMessage).toContain('joh***@***.com'); // Email obfuscated
    expect(entry.userMessage).toContain('***-***-4567'); // Phone obfuscated
    expect(entry.userMessage).toContain('John Smith'); // Names NOT obfuscated
    expect(entry.userAgent).toBe('Windows / other'); // Only coarse families kept
  });

  it('reduces the User-Agent to OS and browser families', () => {
    const event = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      },
    };
    const entry = buildLogEntry({ event, conversationId: 'c', userMessage: 'm',
      messageCount: 1, toolsCalled: [], inputTokens: 0, outputTokens: 0,
      durationMs: 0, rateLimited: false });
    expect(entry.userAgent).toBe('iOS / Safari');
  });
});

describe('obfuscateIP', () => {
  it.each([
    ['203.0.113.42', '203.0.113.0/24'],
    ['10.0.0.1', '10.0.0.0/24'],
    ['::ffff:198.51.100.7', '198.51.100.0/24'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::/48'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8:0::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['fe80::1%eth0', 'fe80:0:0::/48'],
    ['unknown', 'unknown'],
    ['999.1.1.1', 'unknown'],
    ['not-an-ip', 'unknown'],
    ['1:2:3', 'unknown'],
  ])('%s → %s', (ip, expected) => {
    expect(obfuscateIP(ip)).toBe(expected);
  });
});
describe('summariseEventForLog', () => {
  const event = {
    httpMethod: 'POST',
    path: '/chat',
    isBase64Encoded: false,
    body: JSON.stringify({ emailAddress: 'visitor@example.com', messages: [] }),
    headers: {
      'x-forwarded-for': '203.0.113.42, 10.0.0.1',
      'user-agent': 'Mozilla/5.0 (Macintosh) Firefox/130.0',
    },
    requestContext: { identity: { sourceIp: '203.0.113.42', userAgent: 'Mozilla/5.0' } },
  };

  it('keeps only non-identifying fields', () => {
    const out = JSON.stringify(summariseEventForLog(event));
    expect(out).not.toContain('203.0.113');
    expect(out).not.toContain('Mozilla');
    expect(out).not.toContain('Firefox');
    expect(out).not.toContain('visitor@example.com');
    expect(summariseEventForLog(event)).toMatchObject({ method: 'POST', path: '/chat' });
  });
});
