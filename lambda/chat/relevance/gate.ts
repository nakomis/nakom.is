// On-topic gate for the CV chatbot (NAKO-34): a two-tier cascade shared by both
// the REST (handler.ts) and streaming (stream-handler.ts) entry points.
//
// Tier 1 is the vector gate (cheap, always). On a miss, Tier 2 rewrites the
// latest message into a standalone query using recent context and re-runs the
// vector gate on it — so contentless follow-ups ("yes", "tell me more") pass
// while off-topic pivots stay blocked.
//
// Fails OPEN on any error (Titan/resolver): this is a scope/UX control, not a
// security boundary, so a dependency outage must never block a visitor. Emits one
// structured JSON log per request (also a future training corpus for a custom
// resolver).
import { isOnTopic } from './relevance';
import { resolveStandaloneQuery, buildContext, type ChatMessage } from './context-resolve';
import { judgeModelId, judgeMsgMaxChars, relevanceLogVerbose } from './judge-config';

// The polite decline. Points back at what the bot is actually for, so a blocked
// visitor knows how to get a useful answer rather than hitting a wall.
export const OFF_TOPIC_MESSAGE =
    "I'm Martin's assistant, so I can only help with questions about him — his work " +
    'experience, skills, projects, and interests (the home lab, the cats, his writing), ' +
    'or how to get in touch. Ask me something along those lines and I\'m all yours!';

export interface GateResult {
    /** True → the caller should return OFF_TOPIC_MESSAGE instead of invoking the agent. */
    block: boolean;
    message: string;
}

function latestUserIndex(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return i;
    }
    return -1;
}

/**
 * Run the two-tier on-topic gate over the conversation. `messages` is the full
 * (already length-capped) turn list; the latest user message is what's screened.
 * Never throws — on any internal error it fails open (block: false).
 */
export async function runOnTopicGate(messages: ChatMessage[]): Promise<GateResult> {
    const startedAt = Date.now();
    const latestIdx = latestUserIndex(messages);
    const query = latestIdx >= 0 ? messages[latestIdx].content : '';

    try {
        const tier1 = await isOnTopic(query);
        let onTopic = tier1.onTopic;
        let decidedBy: 'vector' | 'resolver' = 'vector';
        let resolveLog: Record<string, unknown> | undefined;

        if (!tier1.onTopic) {
            const rewrite = await resolveStandaloneQuery(messages);
            const tier2 = await isOnTopic(rewrite);
            onTopic = tier2.onTopic;
            decidedBy = 'resolver';
            resolveLog = {
                invoked: true,
                model: judgeModelId(),
                rewrite,
                rewriteScore: Number(tier2.score.toFixed(3)),
                rewriteMatched: tier2.matched,
            };
            if (relevanceLogVerbose()) {
                resolveLog.context = buildContext(messages, latestIdx, judgeMsgMaxChars());
            }
        }

        console.log(
            JSON.stringify({
                event: 'relevance',
                finalOnTopic: onTopic,
                decidedBy,
                query,
                vector: {
                    score: Number(tier1.score.toFixed(3)),
                    threshold: tier1.threshold,
                    pass: tier1.onTopic,
                    matched: tier1.matched,
                },
                resolve: resolveLog,
                totalLatencyMs: Date.now() - startedAt,
            }),
        );

        return { block: !onTopic, message: OFF_TOPIC_MESSAGE };
    } catch (err) {
        console.error('relevance gate failed open:', err);
        return { block: false, message: OFF_TOPIC_MESSAGE };
    }
}
