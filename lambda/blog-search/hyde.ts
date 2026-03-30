import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Haiku via Bedrock cross-region inference profile (on-demand requires a profile, not bare model ID)
const HAIKU_MODEL = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

function buildSystemPrompt(tags: string[]): string {
    const tagLine = tags.length > 0
        ? ` The blog uses tags including: ${tags.join(', ')}. Use this vocabulary where relevant.`
        : '';
    return (
        'You are a search assistant. Given a search query, write a short paragraph ' +
        '(2-4 sentences) that a relevant technical blog post might contain as body text. ' +
        'Write in the style of a technical blog — concrete, specific, first-person where natural. ' +
        `Do not answer the query directly or use headings. Just write the hypothetical passage.${tagLine}`
    );
}

/**
 * HyDE (Hypothetical Document Embeddings): generate a hypothetical passage that a
 * relevant blog post might contain, then embed that instead of the raw query.
 * This anchors the query vector in the same space as stored document embeddings,
 * improving recall for concept/synonym queries.
 *
 * Falls back to the original query if the Haiku call fails.
 */
export async function hydeExpand(query: string, tags: string[] = []): Promise<string> {
    try {
        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 256,
            system: buildSystemPrompt(tags),
            messages: [{ role: 'user', content: query }],
        });

        const response = await bedrock.send(new InvokeModelCommand({
            modelId: HAIKU_MODEL,
            contentType: 'application/json',
            accept: 'application/json',
            body: Buffer.from(body),
        }));

        const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
        const hypothetical: string = result.content[0].text.trim();
        console.log(`HyDE expanded "${query}" → "${hypothetical.slice(0, 120)}…"`);
        return hypothetical;
    } catch (err) {
        console.warn('HyDE expansion failed, falling back to raw query:', err);
        return query;
    }
}
