import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit } from './rate-limiter';
import { fetchGitHubRepos } from './github';
import { buildSystemPrompt } from './system-prompt';

const ssmClient = new SSMClient({});
const sesClient = new SESClient({});
let anthropicClient: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;

  const result = await ssmClient.send(new GetParameterCommand({
    Name: '/nakom.is/anthropic-api-key',
    WithDecryption: true,
  }));

  anthropicClient = new Anthropic({
    apiKey: result.Parameter!.Value!,
  });

  return anthropicClient;
}

interface ChatRequestBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  emailAddress?: string;
}

export const handler = async (event: {
  body?: string;
  isBase64Encoded?: boolean;
  httpMethod?: string;
}): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    if (!event.body) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request body is required' }) };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;

    const body: ChatRequestBody = JSON.parse(rawBody);

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages array is required' }) };
    }

    // Cap at 10 user turns (20 messages total for user+assistant pairs)
    const messages = body.messages.slice(-20);

    // Validate message format
    for (const msg of messages) {
      if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid message format' }) };
      }
      if (typeof msg.content !== 'string' || msg.content.length > 2000) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message content must be a string under 2000 characters' }) };
      }
    }

    // Check rate limit
    const dailyLimit = parseInt(process.env.DAILY_RATE_LIMIT || '100', 10);
    const { allowed, remaining } = await checkRateLimit(dailyLimit);

    if (!allowed) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Daily rate limit exceeded. Please try again tomorrow.' }) };
    }

    // --- Email submission path ---
    if (body.emailAddress) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailAddress)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address' }) };
      }

      const martinEmail = process.env.MARTIN_EMAIL!;
      const fromEmail = process.env.SES_FROM_EMAIL!;

      const conversationSummary = messages
        .slice(-6)
        .map(m => `${m.role === 'user' ? 'Visitor' : 'Martin AI'}: ${m.content}`)
        .join('\n\n');

      try {
        await sesClient.send(new SendEmailCommand({
          Source: fromEmail,
          Destination: { ToAddresses: [martinEmail] },
          Message: {
            Subject: { Data: 'New contact from nakom.is chat', Charset: 'UTF-8' },
            Body: {
              Text: {
                Data: `Someone left their contact details via the AI chat on nakom.is.\n\nEmail: ${body.emailAddress}\n\nRecent conversation:\n\n${conversationSummary}\n\n---\nSent from nakom.is chat AI`,
                Charset: 'UTF-8',
              },
            },
          },
        }));
      } catch (err) {
        console.error('SES send error:', err);
        // Fail gracefully — still confirm to the visitor
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: "Thanks! I've passed your email to Martin — he'll be in touch.",
          remaining,
        }),
      };
    }

    // --- Normal chat path ---
    const githubUser = process.env.GITHUB_USER || 'nakomis';
    const repos = await fetchGitHubRepos(githubUser);
    const systemPrompt = buildSystemPrompt(repos);

    const client = await getAnthropicClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    let assistantMessage = response.content
      .filter(block => block.type === 'text')
      .map(block => 'text' in block ? block.text : '')
      .join('');

    // Detect the [REQUEST_EMAIL] token the AI may include to trigger the email UI
    let requestEmail = false;
    if (assistantMessage.includes('[REQUEST_EMAIL]')) {
      requestEmail = true;
      assistantMessage = assistantMessage.replace(/\[REQUEST_EMAIL\]/g, '').trim();
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: assistantMessage,
        remaining,
        ...(requestEmail && { requestEmail: true }),
      }),
    };
  } catch (err) {
    console.error('Chat handler error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
