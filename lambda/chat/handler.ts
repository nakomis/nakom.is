import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createToolCallingAgent, AgentExecutor } from 'langchain/agents';
import { checkRateLimit } from './rate-limiter';
import { fetchGitHubRepos } from './github';
import { buildSystemPrompt } from './system-prompt';
import { TOOLS } from './tools';

const ssmClient = new SSMClient({});
const sesClient = new SESClient({});

// Initialised once at cold start; reused across warm invocations
let modelReady = false;
let cachedModel: ChatAnthropic | null = null;

async function getModel(): Promise<ChatAnthropic> {
  if (cachedModel) return cachedModel;

  const result = await ssmClient.send(new GetParameterCommand({
    Name: '/nakom.is/anthropic-api-key',
    WithDecryption: true,
  }));

  // LangChain's ChatAnthropic reads ANTHROPIC_API_KEY from env if not passed directly
  cachedModel = new ChatAnthropic({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    apiKey: result.Parameter!.Value!,
  });

  modelReady = true;
  return cachedModel;
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

    // Cap at 10 user turns (20 messages total)
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

    // --- Normal chat path (LangChain tool-calling agent) ---
    const githubUser = process.env.GITHUB_USER || 'nakomis';
    const repos = await fetchGitHubRepos(githubUser);
    const repoNames = repos.map(r => r.name);
    const systemPromptText = buildSystemPrompt(repoNames);

    // Separate the last user message (agent input) from prior history
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'user') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Last message must be from user' }) };
    }

    const chatHistory: BaseMessage[] = messages.slice(0, -1).map(m =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );

    // Build LangChain prompt template
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', systemPromptText],
      new MessagesPlaceholder('chat_history'),
      ['human', '{input}'],
      new MessagesPlaceholder('agent_scratchpad'),
    ]);

    const model = await getModel();
    const agent = createToolCallingAgent({ llm: model, tools: TOOLS, prompt });
    const executor = new AgentExecutor({
      agent,
      tools: TOOLS,
      maxIterations: 10,
      verbose: false,
    });

    const result = await executor.invoke({
      input: lastMsg.content,
      chat_history: chatHistory,
    });

    let assistantMessage: string;
    if (typeof result.output === 'string') {
      assistantMessage = result.output;
    } else if (Array.isArray(result.output)) {
      // LangChain may return Anthropic content blocks: [{type:'text',text:'...'}]
      assistantMessage = result.output
        .filter((block: { type: string }) => block.type === 'text')
        .map((block: { text: string }) => block.text)
        .join('');
    } else {
      assistantMessage = JSON.stringify(result.output);
    }

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
