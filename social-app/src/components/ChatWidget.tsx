import { useState, useRef, useEffect } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import ChatMessage from './ChatMessage';

const MAX_TURNS = 10;

function ChatWidget() {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmailInput, setShowEmailInput] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userMessageCount = messages.filter(m => m.role === 'user').length;
  const isAtLimit = userMessageCount >= MAX_TURNS;
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput);

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
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedMessages }),
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
      setMessages([...updatedMessages, { role: 'assistant', content: data.message }]);
      if (data.requestEmail) {
        setShowEmailInput(true);
      }
    } catch {
      setError('Failed to connect. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
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
            {isLoading && <div className="chat-typing">Thinking</div>}
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
