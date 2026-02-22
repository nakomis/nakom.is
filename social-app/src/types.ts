export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  message: string;
  remaining: number;
  requestEmail?: boolean;
}

export interface ChatError {
  error: string;
}
