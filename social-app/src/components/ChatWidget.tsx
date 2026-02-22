import { useState, useRef, useEffect } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { TOOL_DESCRIPTIONS } from '../types';
import ChatMessage from './ChatMessage';

const MAX_TURNS = 10;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Minimum time (ms) a tool stays visually active so the blob animation is visible
// even when tool_start and tool_end arrive in the same CloudFront chunk.
const MIN_TOOL_DISPLAY_MS = 1500;

interface ChatWidgetProps {
  activeTools: Set<string>;
  onActiveToolsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
}

function ChatWidget({ activeTools, onActiveToolsChange }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmailInput, setShowEmailInput] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track when each tool was activated so we can enforce a minimum visible duration
  const toolStartTimes = useRef<Map<string, number>>(new Map());

  const userMessageCount = messages.filter(m => m.role === 'user').length;
  const isAtLimit = userMessageCount >= MAX_TURNS;
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput);

  // Dynamic "Thinking" text based on active tools
  const thinkingText = (() => {
    for (const tool of activeTools) {
      if (TOOL_DESCRIPTIONS[tool]) return TOOL_DESCRIPTIONS[tool] + '...';
    }
    return 'Thinking';
  })();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || isAtLimit) return;

    const userMessage: ChatMessageType = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setError(null);
    setIsLoading(true);

    try {
      const body = JSON.stringify({ messages: updatedMessages });
      const hash = await sha256Hex(body);
      const response = await fetch('/chat-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-amz-content-sha256': hash,
        },
        body,
      });

      if (!response.ok || !response.body) {
        setError('Something went wrong. Please try again.');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantMessage: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on SSE event boundaries (double newline)
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const lines = block.split('\n');
          let eventType = '';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!eventType || !dataStr) continue;

          try {
            const data = JSON.parse(dataStr);

            if (eventType === 'tool_start') {
              toolStartTimes.current.set(data.tool, Date.now());
              onActiveToolsChange(prev => new Set([...prev, data.tool]));
            } else if (eventType === 'tool_end') {
              const startTime = toolStartTimes.current.get(data.tool) || 0;
              const elapsed = Date.now() - startTime;
              const delay = Math.max(0, MIN_TOOL_DISPLAY_MS - elapsed);
              toolStartTimes.current.delete(data.tool);
              setTimeout(() => {
                onActiveToolsChange(prev => {
                  const next = new Set(prev);
                  next.delete(data.tool);
                  return next;
                });
              }, delay);
            } else if (eventType === 'message') {
              assistantMessage = data.message;
              setMessages([...updatedMessages, { role: 'assistant', content: data.message }]);
              if (data.requestEmail) setShowEmailInput(true);
            } else if (eventType === 'error') {
              setError(data.error || 'Something went wrong. Please try again.');
            }
          } catch {
            // Ignore malformed SSE data lines
          }
        }
      }

      if (assistantMessage === null) {
        setError('No response received. Please try again.');
      }
    } catch {
      setError('Failed to connect. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
      onActiveToolsChange(new Set());
    }
  };

  const submitEmail = async () => {
    if (!isEmailValid || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, emailAddress: emailInput }),
      });

      if (response.status === 429) {
        setError('Rate limit reached. Please try again later.');
        return;
      }

      if (!response.ok) {
        setError('Something went wrong. Please try again.');
        return;
      }

      const data = await response.json();
      setMessages([...messages, { role: 'assistant', content: data.message }]);
      setShowEmailInput(false);
      setEmailInput('');
    } catch {
      setError('Failed to connect. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && isEmailValid) {
      e.preventDefault();
      submitEmail();
    }
    if (e.key === 'Escape') {
      setShowEmailInput(false);
    }
  };

  return (
    <div className="chat-column">
      {!isOpen && (
        <button className="chat-toggle" onClick={() => setIsOpen(true)} aria-label="Open chat">
          {'\uD83D\uDCAC'}
        </button>
      )}

      {isOpen && (
        <div id="chat-panel" className="chat-panel">
          <div className="chat-header">
            <span className="chat-header-dot"></span>
            <span className="chat-header-title">Ask me anything</span>
            <button className="chat-close" onClick={() => setIsOpen(false)} aria-label="Close chat">
              {'\u2715'}
            </button>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-message assistant">
                Hi, I'm Martin Harris: coder, maker, and cat dad. Ask me anything about my work experience and interests!
              </div>
            )}
            {messages.map((msg, i) => (
              <ChatMessage key={i} message={msg} />
            ))}
            {error && <div className="chat-message error">{error}</div>}
            {isLoading && <div className="chat-typing">{thinkingText}</div>}
            <div ref={messagesEndRef} />
          </div>

          {isAtLimit ? (
            <div className="chat-limit">Conversation limit reached. Refresh to start a new chat.</div>
          ) : showEmailInput ? (
            <div className="chat-input-area">
              <i className="fas fa-envelope email-icon"></i>
              <div className={`email-input-wrapper${isEmailValid ? ' valid' : ''}`}>
                <input
                  className="email-input"
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={handleEmailKeyDown}
                  placeholder="your@email.com"
                  disabled={isLoading}
                  autoFocus
                />
                <span className="email-valid-icon">✓</span>
              </div>
              <button className="chat-send" onClick={submitEmail} disabled={isLoading || !isEmailValid}>
                Send
              </button>
              <button className="email-skip" onClick={() => setShowEmailInput(false)} disabled={isLoading}>
                Skip
              </button>
            </div>
          ) : (
            <div className="chat-input-area">
              <input
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                disabled={isLoading}
              />
              <button className="chat-send" onClick={sendMessage} disabled={isLoading || !input.trim()}>
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatWidget;
