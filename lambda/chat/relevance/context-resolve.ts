// Tier-2 on-topic resolver (NAKO-34).
//
// When the Tier-1 vector gate misses (relevance.ts), the miss doesn't mean
// "off-topic" — a contentless follow-up ("yes", "tell me more") scores ~0.15 on
// its own. This rewrites the latest user message into a STANDALONE query using
// recent context; the caller then re-runs that rewrite through the vector gate.
//
// The resolver is deliberately DOMAIN-AGNOSTIC: it does coreference/ellipsis
// resolution, NOT an on/off decision. That keeps the CV domain defined in exactly
// one place — the exemplars — so it can't drift out of sync. A faithful rewrite
// of an off-topic pivot ("now write me a novel") stays off-topic and is still
// blocked when re-vectored.
//
// Uses the Bedrock Converse API so the backend model is a config choice
// (Nova Micro by default; Claude Haiku or a SageMaker model via the same
// interface — see judge-config.ts). Bedrock errors PROPAGATE so the caller can
// fail open (a resolver outage must never block a user).
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { judgeModelId, judgeMsgMaxChars } from './judge-config';
import { BEDROCK_REGION } from './embed-config';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });

const SYSTEM_PROMPT = `You rewrite the user's latest message into a single standalone search query, using the conversation only for context.

Rules:
- Resolve pronouns and short replies ("yes", "that one", "tell me more") into what they refer to, using the previous turns.
- Be FAITHFUL: never introduce a topic the user did not reference. If the latest message is already self-contained, return it unchanged.
- Output ONLY the rewritten query as one line of plain text: no preamble, no explanation of what you changed, no quotes, no markdown.`;

/** Truncate a message: assistant → keep the TAIL (the question a "yes" answers); user → keep the HEAD (their ask). */
function truncate(role: 'user' | 'assistant', text: string, max: number): string {
    const t = text.trim();
    if (t.length <= max) return t;
    return role === 'assistant' ? '…' + t.slice(t.length - max) : t.slice(0, max) + '…';
}

/** The most recent 2 user + 2 assistant turns BEFORE the latest user message, in original order, truncated. */
export function buildContext(messages: ChatMessage[], latestIdx: number, max: number): string {
    const prior = messages.slice(0, latestIdx);
    const keep = new Set<ChatMessage>([
        ...prior.filter((m) => m.role === 'user').slice(-2),
        ...prior.filter((m) => m.role === 'assistant').slice(-2),
    ]);
    return prior
        .filter((m) => keep.has(m))
        .map((m) => `${m.role === 'assistant' ? 'AI' : 'User'}: ${truncate(m.role, m.content, max)}`)
        .join('\n');
}

/** Strip a chatty model's wrapping so the bare query survives to be embedded verbatim. */
export function cleanRewrite(raw: string): string {
    let s = (raw || '').trim();
    const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) s = lines[lines.length - 1]; // last non-empty line (drop any preamble line)
    s = s.replace(/^["'`]+|["'`]+$/g, '').trim(); // surrounding quotes/backticks
    s = s.replace(/^[A-Za-z ]{0,24}:\s*/, '').trim(); // leading "Query:" / "Rewritten query:" label
    return s;
}

/**
 * Rewrite the latest user message into a standalone query using recent context.
 * Returns the rewrite, or the original latest message if the model returns
 * nothing usable (re-vectoring the original is the conservative fallback).
 * THROWS on a Bedrock error so the caller can fail open.
 */
export async function resolveStandaloneQuery(messages: ChatMessage[]): Promise<string> {
    let latestIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            latestIdx = i;
            break;
        }
    }
    const latest = latestIdx >= 0 ? messages[latestIdx].content : '';
    const max = judgeMsgMaxChars();
    const context = buildContext(messages, latestIdx, max);
    const latestTrunc = truncate('user', latest, max);

    const userMsg = context
        ? `Conversation so far:\n${context}\n\nLatest user message: ${latestTrunc}\n\nRewrite the latest message as a standalone query:`
        : `Rewrite as a standalone query: ${latestTrunc}`;

    const res = await client.send(
        new ConverseCommand({
            modelId: judgeModelId(),
            system: [{ text: SYSTEM_PROMPT }],
            messages: [{ role: 'user', content: [{ text: userMsg }] }],
            inferenceConfig: { maxTokens: 60, temperature: 0 },
        }),
    );

    const block = res.output?.message?.content?.[0];
    const text = block && 'text' in block ? block.text ?? '' : '';
    return cleanRewrite(text) || latest;
}
