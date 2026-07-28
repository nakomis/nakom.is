// Build-time generator for the CV chatbot's on-topic relevance gate (NAKO-34).
//
// Embeds each sentence in TOPIC_EXEMPLARS with Titan Text Embeddings V2 and
// writes relevance/topic-vectors.json. The vectors are COMMITTED, so this never
// runs in CI — run it locally when you edit topic-exemplars.ts:
//
//   AWS_PROFILE=nakom.is-admin npm run gen:topic-vectors
//
// Each entry stores { text, vector } so the JSON is self-documenting: you can see
// exactly which sentence a vector came from. Duplicate exemplars are REJECTED so
// the baked set stays clean. Vectors are L2-normalised (normalize: true) so the
// runtime gate's cosine similarity is a plain dot product; the runtime query MUST
// be embedded with the same model + settings (see relevance.ts).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { TOPIC_EXEMPLARS } from '../relevance/topic-exemplars';
import { EMBED_MODEL_ID, EMBED_DIMS, BEDROCK_REGION } from '../relevance/embed-config';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? BEDROCK_REGION });

function assertNoDuplicates(exemplars: string[]): void {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    exemplars.forEach((raw, i) => {
        const key = raw.trim().toLowerCase();
        if (seen.has(key)) {
            dupes.push(`  "${raw}" (lines ${seen.get(key)! + 1} and ${i + 1})`);
        } else {
            seen.set(key, i);
        }
    });
    if (dupes.length) {
        throw new Error(`Duplicate exemplars found — remove them first:\n${dupes.join('\n')}`);
    }
}

async function embed(text: string): Promise<number[]> {
    const res = await client.send(
        new InvokeModelCommand({
            modelId: EMBED_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({ inputText: text, dimensions: EMBED_DIMS, normalize: true }),
        }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIMS) {
        throw new Error(`unexpected embedding for "${text}": len=${parsed.embedding?.length}`);
    }
    return parsed.embedding;
}

async function main(): Promise<void> {
    assertNoDuplicates(TOPIC_EXEMPLARS);
    console.error(`Embedding ${TOPIC_EXEMPLARS.length} exemplars with ${EMBED_MODEL_ID} (${EMBED_DIMS}d)…`);
    const entries: { text: string; vector: number[] }[] = [];
    for (let i = 0; i < TOPIC_EXEMPLARS.length; i++) {
        entries.push({ text: TOPIC_EXEMPLARS[i], vector: await embed(TOPIC_EXEMPLARS[i]) });
        if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${TOPIC_EXEMPLARS.length}`);
    }
    const out = {
        model: EMBED_MODEL_ID,
        dims: EMBED_DIMS,
        normalized: true,
        count: entries.length,
        entries,
    };
    const outPath = join(__dirname, '..', 'relevance', 'topic-vectors.json');
    writeFileSync(outPath, JSON.stringify(out) + '\n');
    console.error(`Wrote ${entries.length} vectors → ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
