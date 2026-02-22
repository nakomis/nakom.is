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

let cachedRepos: RepoSummary[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function fetchGitHubRepos(username: string): Promise<RepoSummary[]> {
  const now = Date.now();
  if (cachedRepos && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRepos;
  }

  try {
    const response = await fetch(
      `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=30`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'nakom.is-chat-lambda',
        },
      }
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

    cacheTimestamp = now;
    return cachedRepos;
  } catch (err) {
    console.warn('Failed to fetch GitHub repos:', err);
    return cachedRepos || [];
  }
}
