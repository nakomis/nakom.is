interface GitHubRepo {
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  html_url: string;
  fork: boolean;
}

export interface RepoSummary {
  name: string;
  description: string;
  language: string;
  stars: number;
  url: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedRepos: RepoSummary[] | null = null;
let reposCacheTimestamp = 0;

const readmeCache = new Map<string, { content: string; timestamp: number }>();
const filesCache = new Map<string, { content: string; timestamp: number }>();

const GH_HEADERS = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'nakom.is-chat-lambda',
};

export async function fetchGitHubRepos(username: string): Promise<RepoSummary[]> {
  const now = Date.now();
  if (cachedRepos && (now - reposCacheTimestamp) < CACHE_TTL_MS) {
    return cachedRepos;
  }

  try {
    const response = await fetch(
      `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=30`,
      { headers: GH_HEADERS }
    );

    if (!response.ok) {
      console.warn(`GitHub API returned ${response.status}`);
      return cachedRepos || [];
    }

    const repos: GitHubRepo[] = await response.json();

    cachedRepos = repos
      .filter(r => !r.fork)
      .map(r => ({
        name: r.name,
        description: r.description || 'No description',
        language: r.language || 'Unknown',
        stars: r.stargazers_count,
        url: r.html_url,
      }));

    reposCacheTimestamp = now;
    return cachedRepos;
  } catch (err) {
    console.warn('Failed to fetch GitHub repos:', err);
    return cachedRepos || [];
  }
}

export async function fetchRepoReadme(username: string, repoName: string): Promise<string> {
  const cacheKey = `${username}/${repoName}`;
  const now = Date.now();
  const cached = readmeCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/readme`,
      { headers: GH_HEADERS }
    );

    if (response.status === 404) {
      return `No README found for ${repoName}`;
    }
    if (!response.ok) {
      return `GitHub API error ${response.status} fetching README for ${repoName}`;
    }

    const data: { content: string; encoding: string } = await response.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    readmeCache.set(cacheKey, { content, timestamp: now });
    return content;
  } catch (err) {
    console.warn(`Failed to fetch README for ${repoName}:`, err);
    return `Failed to fetch README for ${repoName}`;
  }
}

export async function listRepoFiles(username: string, repoName: string, path: string = ''): Promise<string> {
  const cacheKey = `${username}/${repoName}/${path}`;
  const now = Date.now();
  const cached = filesCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.content;
  }

  try {
    const url = `https://api.github.com/repos/${username}/${repoName}/contents/${path}`;
    const response = await fetch(url, { headers: GH_HEADERS });

    if (response.status === 404) {
      return `Path '${path || '/'}' not found in ${repoName}`;
    }
    if (!response.ok) {
      return `GitHub API error ${response.status} listing files in ${repoName}`;
    }

    const items: Array<{ name: string; type: string; size: number }> = await response.json();
    const listing = items
      .map(item => `${item.type === 'dir' ? '[dir]' : '[file]'} ${item.name}${item.type === 'file' ? ` (${item.size}b)` : ''}`)
      .join('\n');

    const content = `Files in ${repoName}/${path || ''}:\n${listing}`;
    filesCache.set(cacheKey, { content, timestamp: now });
    return content;
  } catch (err) {
    console.warn(`Failed to list files in ${repoName}/${path}:`, err);
    return `Failed to list files in ${repoName}`;
  }
}

export async function readRepoFile(username: string, repoName: string, filePath: string): Promise<string> {
  const MAX_BYTES = 20 * 1024; // 20KB cap

  try {
    const response = await fetch(
      `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`,
      { headers: GH_HEADERS }
    );

    if (response.status === 404) {
      return `File '${filePath}' not found in ${repoName}`;
    }
    if (!response.ok) {
      return `GitHub API error ${response.status} reading ${filePath} in ${repoName}`;
    }

    const data: { content?: string; encoding?: string; type: string } = await response.json();

    if (data.type === 'dir') {
      return `'${filePath}' is a directory, not a file. Use list_repo_files to browse it.`;
    }
    if (!data.content || data.encoding !== 'base64') {
      return `Cannot read ${filePath} — unexpected encoding`;
    }

    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    if (Buffer.byteLength(decoded, 'utf-8') > MAX_BYTES) {
      return decoded.slice(0, MAX_BYTES) + '\n\n[... truncated at 20KB ...]';
    }
    return decoded;
  } catch (err) {
    console.warn(`Failed to read ${filePath} in ${repoName}:`, err);
    return `Failed to read ${filePath} in ${repoName}`;
  }
}
