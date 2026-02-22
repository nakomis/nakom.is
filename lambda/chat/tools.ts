import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readPrivateFile } from './s3-reader';
import { fetchRepoReadme, listRepoFiles, readRepoFile } from './github';

function githubUser(): string {
  return process.env.GITHUB_USER || 'nakomis';
}

export const TOOLS = [
  tool(
    async () => readPrivateFile('cv.md'),
    {
      name: 'get_cv',
      description: "Read Martin's full CV/resume in Markdown format. Use this when asked about his work history, skills, qualifications, or career.",
      schema: z.object({}),
    }
  ),

  tool(
    async () => readPrivateFile('linkedin.md'),
    {
      name: 'get_linkedin_profile',
      description: "Read Martin's LinkedIn profile data (generated from LinkedIn export). Use this when asked about his professional profile, endorsements, or recommendations.",
      schema: z.object({}),
    }
  ),

  tool(
    async () => readPrivateFile('interests.md'),
    {
      name: 'get_interests',
      description: "Read Martin's interests, hobbies, and personal details. Use this when asked about what he enjoys outside of work.",
      schema: z.object({}),
    }
  ),

  tool(
    async ({ repo_name }: { repo_name: string }) => fetchRepoReadme(githubUser(), repo_name),
    {
      name: 'get_github_readme',
      description: "Fetch the README for one of Martin's GitHub repositories. Use this to give a detailed description of a specific project.",
      schema: z.object({
        repo_name: z.string().describe("The repository name (e.g. 'nakom.is')"),
      }),
    }
  ),

  tool(
    async ({ repo_name, path }: { repo_name: string; path?: string }) =>
      listRepoFiles(githubUser(), repo_name, path ?? ''),
    {
      name: 'list_repo_files',
      description: "List files and directories in a GitHub repository. Use this to explore a project's structure.",
      schema: z.object({
        repo_name: z.string().describe("The repository name"),
        path: z.string().optional().describe("Directory path within the repo (defaults to root)"),
      }),
    }
  ),

  tool(
    async ({ repo_name, path }: { repo_name: string; path: string }) =>
      readRepoFile(githubUser(), repo_name, path),
    {
      name: 'read_repo_file',
      description: "Read the contents of a specific file in a GitHub repository. Capped at 20KB.",
      schema: z.object({
        repo_name: z.string().describe("The repository name"),
        path: z.string().describe("File path within the repo (e.g. 'lib/chat-stack.ts')"),
      }),
    }
  ),
];
