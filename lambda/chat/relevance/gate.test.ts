// Gate cascade tests (NAKO-34). The two tiers are mocked — this proves the
// *orchestration*: Tier-1 pass short-circuits, a miss escalates to the resolver
// and re-scores, and any error fails open. Tier internals are covered by
// relevance.test.ts / context-resolve.test.ts.
jest.mock('./relevance');
jest.mock('./context-resolve');

import { isOnTopic, type RelevanceResult } from './relevance';
import { resolveStandaloneQuery } from './context-resolve';
import { runOnTopicGate, OFF_TOPIC_MESSAGE } from './gate';

const mockIsOnTopic = isOnTopic as jest.MockedFunction<typeof isOnTopic>;
const mockResolve = resolveStandaloneQuery as jest.MockedFunction<typeof resolveStandaloneQuery>;

const result = (onTopic: boolean, score: number): RelevanceResult => ({
    onTopic,
    score,
    threshold: 0.22,
    matched: onTopic ? 'some exemplar' : null,
});

const messages = [{ role: 'user' as const, content: 'what is your AWS experience?' }];

afterEach(() => jest.clearAllMocks());

describe('runOnTopicGate', () => {
    it('passes on a Tier-1 hit without invoking the resolver', async () => {
        mockIsOnTopic.mockResolvedValueOnce(result(true, 0.8));
        const gate = await runOnTopicGate(messages);
        expect(gate.block).toBe(false);
        expect(mockResolve).not.toHaveBeenCalled();
        expect(mockIsOnTopic).toHaveBeenCalledTimes(1);
    });

    it('escalates on a Tier-1 miss and passes when the rewrite re-scores on-topic', async () => {
        mockIsOnTopic.mockResolvedValueOnce(result(false, 0.15)); // tier 1: miss
        mockResolve.mockResolvedValueOnce('what is your AWS experience?');
        mockIsOnTopic.mockResolvedValueOnce(result(true, 0.79)); // tier 2: re-score pass
        const gate = await runOnTopicGate([
            { role: 'assistant', content: 'Want to hear about my AWS work?' },
            { role: 'user', content: 'yes' },
        ]);
        expect(gate.block).toBe(false);
        expect(mockResolve).toHaveBeenCalledTimes(1);
        expect(mockIsOnTopic).toHaveBeenCalledTimes(2);
    });

    it('blocks when both the vector gate and the rewrite miss', async () => {
        mockIsOnTopic.mockResolvedValueOnce(result(false, 0.10)); // tier 1: miss
        mockResolve.mockResolvedValueOnce('write me a novel about pirates');
        mockIsOnTopic.mockResolvedValueOnce(result(false, 0.09)); // tier 2: still off
        const gate = await runOnTopicGate([{ role: 'user', content: 'now write me a novel' }]);
        expect(gate.block).toBe(true);
        expect(gate.message).toBe(OFF_TOPIC_MESSAGE);
    });

    it('fails open (does not block) when a tier throws', async () => {
        mockIsOnTopic.mockRejectedValueOnce(new Error('titan down'));
        const gate = await runOnTopicGate(messages);
        expect(gate.block).toBe(false);
    });
});
