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

export const TOOL_TO_LINK: Record<string, string> = {
  'get_cv': 'link-cv',
  'get_linkedin_profile': 'link-linkedin',
  'get_github_readme': 'link-github',
  'list_repo_files': 'link-github',
  'read_repo_file': 'link-github',
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  'get_cv': 'Reading CV',
  'get_linkedin_profile': 'Checking LinkedIn',
  'get_interests': 'Looking up interests',
  'get_github_readme': 'Reading GitHub README',
  'list_repo_files': 'Browsing repository',
  'read_repo_file': 'Reading file',
};
