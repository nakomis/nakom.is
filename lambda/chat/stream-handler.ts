import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { createToolCallingAgent, AgentExecutor } from 'langchain/agents';
import type { Serialized } from '@langchain/core/load/serializable';
import { checkRateLimit } from './rate-limiter';
import { fetchGitHubRepos } from './github';
import { buildSystemPrompt } from './system-prompt';
import { TOOLS } from './tools';

// Types for the awslambda global (available in Node.js 20 Lambda runtime with RESPONSE_STREAM)
declare global {
  namespace awslambda {
    function streamifyResponse(
      handler: (event: any, responseStream: ResponseStream, context: any) => Promise<void>
    ): any;
    interface ResponseStream {
      write(chunk: string | Buffer): boolean;
      end(): void;
      setContentType(type: string): void;
    }
  }
}

// --- SSE helper ---
// CloudFront buffers small chunks (~1KB threshold before flushing to the viewer).
// Pad each SSE event to ≥1KB so CloudFront flushes it immediately, allowing the
// browser to process tool_start/tool_end events in real time for animations.
const SSE_PAD_TARGET = 1024;

function writeSSE(stream: awslambda.ResponseStream, event: string, data: object): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n`;
  const padding = Math.max(0, SSE_PAD_TARGET - payload.length - 1);
  stream.write(payload + (padding > 0 ? ':' + ' '.repeat(padding) + '\n' : '') + '\n');
}

// --- Cached model (same pattern as handler.ts) ---
const ssmClient = new SSMClient({});
let cachedModel: ChatAnthropic | null = null;

async function getModel(): Promise<ChatAnthropic> {
  if (cachedModel) return cachedModel;

  const result = await ssmClient.send(new GetParameterCommand({
    Name: '/nakom.is/anthropic-api-key',
    WithDecryption: true,
  }));

  cachedModel = new ChatAnthropic({
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    apiKey: result.Parameter!.Value!,
  });

  return cachedModel;
}

// --- SSE Callback Handler ---
class SSECallbackHandler extends BaseCallbackHandler {
  name = 'SSECallbackHandler';
  awaitHandlers = true; // Ensure event ordering
  private stream: awslambda.ResponseStream;
  private runIdToToolName = new Map<string, string>();

  constructor(stream: awslambda.ResponseStream) {
    super();
    this.stream = stream;
  }

  async handleToolStart(
    tool: Serialized,
    _input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const toolName = runName || tool.id?.[tool.id.length - 1] || 'unknown';
    this.runIdToToolName.set(runId, toolName);
    writeSSE(this.stream, 'tool_start', { tool: toolName });
  }

  async handleToolEnd(
    _output: any,
    runId: string,
  ): Promise<void> {
    const toolName = this.runIdToToolName.get(runId) || 'unknown';
    this.runIdToToolName.delete(runId);
    writeSSE(this.stream, 'tool_end', { tool: toolName });
  }
}

interface ChatRequestBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// --- Main streaming handler ---
export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: awslambda.ResponseStream, _context: any) => {
    responseStream.setContentType('text/event-stream');

    try {
      // Parse body — Function URL may send raw JSON or base64-encoded
      let rawBody: string;
      if (event.isBase64Encoded && event.body) {
        rawBody = Buffer.from(event.body, 'base64').toString('utf-8');
      } else {
        rawBody = event.body || '{}';
      }

      const body: ChatRequestBody = JSON.parse(rawBody);

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        writeSSE(responseStream, 'error', { error: 'messages array is required' });
        writeSSE(responseStream, 'done', {});
        responseStream.end();
        return;
      }

      const messages = body.messages.slice(-20);

      // Validate messages
      for (const msg of messages) {
        if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
          writeSSE(responseStream, 'error', { error: 'Invalid message format' });
          writeSSE(responseStream, 'done', {});
          responseStream.end();
          return;
        }
        if (typeof msg.content !== 'string' || msg.content.length > 2000) {
          writeSSE(responseStream, 'error', { error: 'Message content must be a string under 2000 characters' });
          writeSSE(responseStream, 'done', {});
          responseStream.end();
          return;
        }
      }

      // Rate limiting
      const dailyLimit = parseInt(process.env.DAILY_RATE_LIMIT || '100', 10);
      const { allowed, remaining } = await checkRateLimit(dailyLimit);

      if (!allowed) {
        writeSSE(responseStream, 'error', { error: 'Daily rate limit exceeded. Please try again tomorrow.' });
        writeSSE(responseStream, 'done', {});
        responseStream.end();
        return;
      }

      // Build agent
      const githubUser = process.env.GITHUB_USER || 'nakomis';
      const repos = await fetchGitHubRepos(githubUser);
      const repoNames = repos.map(r => r.name);
      const systemPromptText = buildSystemPrompt(repoNames);

      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role !== 'user') {
        writeSSE(responseStream, 'error', { error: 'Last message must be from user' });
        writeSSE(responseStream, 'done', {});
        responseStream.end();
        return;
      }

      const chatHistory: BaseMessage[] = messages.slice(0, -1).map(m =>
        m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
      );

      const prompt = ChatPromptTemplate.fromMessages([
        ['system', systemPromptText],
        new MessagesPlaceholder('chat_history'),
        ['human', '{input}'],
        new MessagesPlaceholder('agent_scratchpad'),
      ]);

      const model = await getModel();
      const sseHandler = new SSECallbackHandler(responseStream);
      const agent = createToolCallingAgent({ llm: model, tools: TOOLS, prompt });
      const executor = new AgentExecutor({
        agent,
        tools: TOOLS,
        maxIterations: 10,
        verbose: false,
      });

      const result = await executor.invoke(
        { input: lastMsg.content, chat_history: chatHistory },
        { callbacks: [sseHandler] },
      );

      // Process final output (same logic as handler.ts)
      let assistantMessage: string;
      if (typeof result.output === 'string') {
        assistantMessage = result.output;
      } else if (Array.isArray(result.output)) {
        assistantMessage = result.output
          .filter((block: { type: string }) => block.type === 'text')
          .map((block: { text: string }) => block.text)
          .join('');
      } else {
        assistantMessage = JSON.stringify(result.output);
      }

      let requestEmail = false;
      if (assistantMessage.includes('[REQUEST_EMAIL]')) {
        requestEmail = true;
        assistantMessage = assistantMessage.replace(/\[REQUEST_EMAIL\]/g, '').trim();
      }

      writeSSE(responseStream, 'message', {
        message: assistantMessage,
        remaining,
        ...(requestEmail && { requestEmail: true }),
      });

      writeSSE(responseStream, 'done', {});
    } catch (err) {
      console.error('Stream handler error:', err);
      writeSSE(responseStream, 'error', { error: 'Internal server error' });
      writeSSE(responseStream, 'done', {});
    } finally {
      responseStream.end();
    }
  },
);
