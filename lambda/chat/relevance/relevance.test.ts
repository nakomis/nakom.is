import { bestMatch, relevanceThreshold, isOnTopic } from './relevance';
import topicVectors from './topic-vectors.json';

const entries = (topicVectors as { entries: { text: string; vector: number[] }[] }).entries;

describe('bestMatch', () => {
    it('is ~1 and returns the matching text for a query identical to an exemplar', () => {
        const first = entries[0];
        const { score, text } = bestMatch(first.vector);
        expect(score).toBeCloseTo(1, 4);
        expect(text).toBe(first.text);
    });

    it('is well below threshold for a query pointing away from the exemplars', () => {
        // Negate an exemplar: it now points opposite the (clustered) exemplars,
        // so the best cosine is low/negative — clearly off-topic.
        const away = entries[0].vector.map((x) => -x);
        expect(bestMatch(away).score).toBeLessThan(0.22);
    });
});

describe('relevanceThreshold', () => {
    const orig = process.env.RELEVANCE_THRESHOLD;
    afterEach(() => {
        if (orig === undefined) delete process.env.RELEVANCE_THRESHOLD;
        else process.env.RELEVANCE_THRESHOLD = orig;
    });

    it('defaults to 0.22 when unset or invalid', () => {
        delete process.env.RELEVANCE_THRESHOLD;
        expect(relevanceThreshold()).toBe(0.22);
        process.env.RELEVANCE_THRESHOLD = 'nonsense';
        expect(relevanceThreshold()).toBe(0.22);
    });

    it('respects a valid numeric override', () => {
        process.env.RELEVANCE_THRESHOLD = '0.5';
        expect(relevanceThreshold()).toBe(0.5);
    });
});

describe('isOnTopic', () => {
    it('treats an empty/whitespace query as on-topic without embedding', async () => {
        // No Bedrock call is made for an empty query, so this needs no mock.
        const r = await isOnTopic('   ');
        expect(r.onTopic).toBe(true);
        expect(r.matched).toBeNull();
    });
});
