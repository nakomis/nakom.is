import DOMPurify from 'dompurify';
import type { ChatMessage as ChatMessageType } from '../types';

const ALLOWED_TAGS = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'code', 'pre'];

interface ChatMessageProps {
  message: ChatMessageType;
}

function ChatMessage({ message }: ChatMessageProps) {
  if (message.role === 'assistant') {
    const clean = DOMPurify.sanitize(message.content, { ALLOWED_TAGS, ALLOWED_ATTR: [] });
    return (
      <div
        className="chat-message assistant"
        dangerouslySetInnerHTML={{ __html: clean }}
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
