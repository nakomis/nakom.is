// Config for the Tier-2 on-topic resolver (NAKO-34), kept separate from
// embed-config so these are runtime-tunable via env without a code change.
//
// The resolver runs ONLY when the Tier-1 vector gate misses (relevance.ts). It
// rewrites the latest user message into a standalone query using recent context,
// which is then re-run through the vector gate. See context-resolve.ts.

// Bedrock model id for the resolver. Default Amazon Nova Micro (cheapest sensible
// option), invoked via the same BedrockRuntimeClient the embeddings use (us-east-1)
// — no inference profile needed. One env flip to Claude Haiku (`claude-haiku-4-5`)
// or any Converse-capable model, or a SageMaker-served custom model, behind the
// same resolveStandaloneQuery() interface.
export function judgeModelId(): string {
    return process.env.JUDGE_MODEL_ID || 'amazon.nova-micro-v1:0';
}

// Per-message truncation cap for the resolver's context window, so a long pasted
// log or a verbose assistant turn can't balloon the resolver's input tokens.
export function judgeMsgMaxChars(): number {
    const v = Number(process.env.JUDGE_MSG_MAXCHARS);
    return Number.isFinite(v) && v > 0 ? v : 500;
}

// When on, the structured relevance log additionally includes the exact
// (truncated) context the resolver saw — for deep dives. Off by default so
// routine logs stay lean and less conversation content lands in CloudWatch.
export function relevanceLogVerbose(): boolean {
    const v = process.env.RELEVANCE_LOG_VERBOSE;
    return v === '1' || v?.toLowerCase() === 'true';
}
