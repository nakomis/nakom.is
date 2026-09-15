// Tier-2 resolver tests (NAKO-34). Bedrock is mocked — the resolver's *logic*
// (context window, truncation, defensive parse, fallback, error propagation) is
// what's under test; Nova's actual rewriting quality is proven by the live smoke
// test on the PR.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
    ConverseCommand: jest.fn((input) => ({ input })),
}));

import type { ChatMessage } from './context-resolve';
import { buildContext, cleanRewrite, resolveStandaloneQuery } from './context-resolve';

const converseReply = (text: string) => ({ output: { message: { content: [{ text }] } } });

describe('cleanRewrite', () => {
    it('strips surrounding quotes and backticks', () => {
        expect(cleanRewrite('"what is your AWS experience"')).toBe('what is your AWS experience');
        expect(cleanRewrite('`tell me about the cats`')).toBe('tell me about the cats');
    });
    it('drops a leading label preamble', () => {
        expect(cleanRewrite('Query: what is your AWS experience')).toBe('what is your AWS experience');
    });
    it('takes the last non-empty line when the model prepends waffle', () => {
        expect(cleanRewrite('Sure, here is the query:\nwhat is your AWS experience')).toBe('what is your AWS experience');
    });
    it('returns empty for empty/whitespace', () => {
        expect(cleanRewrite('   ')).toBe('');
        expect(cleanRewrite('')).toBe('');
    });
});

describe('buildContext', () => {
    const msgs: ChatMessage[] = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: 'latest' }, // index 6
    ];

    it('keeps only the last 2 user + 2 assistant turns before the latest, in order', () => {
        expect(buildContext(msgs, 6, 500)).toBe('User: u2\nAI: a2\nUser: u3\nAI: a3');
    });

    it('truncates assistant to the tail and user to the head at the cap', () => {
        const long: ChatMessage[] = [
            { role: 'user', content: 'U'.repeat(20) },
            { role: 'assistant', content: 'A'.repeat(20) },
            { role: 'user', content: 'latest' },
        ];
        const ctx = buildContext(long, 2, 5);
        expect(ctx).toContain('User: UUUUU…'); // head kept
        expect(ctx).toContain('AI: …AAAAA'); // tail kept
    });
});

describe('resolveStandaloneQuery', () => {
    afterEach(() => mockSend.mockReset());

    it('returns the cleaned rewrite from the model', async () => {
        mockSend.mockResolvedValue(converseReply('"What is your experience with AWS?"'));
        const out = await resolveStandaloneQuery([
            { role: 'assistant', content: 'Want to hear about my AWS experience?' },
            { role: 'user', content: 'yes' },
        ]);
        expect(out).toBe('What is your experience with AWS?');
    });

    it('falls back to the original latest message when the model returns nothing usable', async () => {
        mockSend.mockResolvedValue(converseReply('   '));
        const out = await resolveStandaloneQuery([{ role: 'user', content: 'yes' }]);
        expect(out).toBe('yes');
    });

    it('propagates a Bedrock error so the caller can fail open', async () => {
        mockSend.mockRejectedValue(new Error('bedrock down'));
        await expect(resolveStandaloneQuery([{ role: 'user', content: 'yes' }])).rejects.toThrow('bedrock down');
    });
});
