import DOMPurify from 'dompurify';
import type { ChatMessage as ChatMessageType } from '../types';

const ALLOWED_TAGS = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'code', 'pre', 'a'];

interface ChatMessageProps {
  message: ChatMessageType;
}

function ChatMessage({ message }: ChatMessageProps) {
  if (message.role === 'assistant') {
    const clean = DOMPurify.sanitize(message.content, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ['href', 'target', 'rel'],
    });
    // Force all links to open in a new tab safely
    const withTargets = clean.replace(/<a\s+href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
    return (
      <div
        className="chat-message assistant"
        dangerouslySetInnerHTML={{ __html: withTargets }}
      />
    );
  }
  return (
    <div className={`chat-message ${message.role}`}>
      {message.content}
    </div>
  );
}

export default ChatMessage;
