import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkExtractFrontmatter from 'remark-extract-frontmatter';
import { parse as parseYaml } from 'yaml';
import { BlogPost, BlogPostListItem } from '../types';

const CONTENT_DIR = join(process.cwd(), 'content', 'blog');

export async function processMarkdown(content: string): Promise<{ html: string; frontmatter: any; content: string }> {
  let frontmatter: any = {};
  let markdownContent = content;

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkExtractFrontmatter, {
      yaml: parseYaml,
      name: 'frontmatter'
    })
    .use(remarkRehype)
    .use(rehypeStringify);

  const result = await processor.process(content);

  // Extract frontmatter from the processed result
  if (result.data && result.data.frontmatter) {
    frontmatter = result.data.frontmatter;
  }

  // Remove frontmatter from content for display
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  markdownContent = content.replace(frontmatterRegex, '');

  return {
    html: String(result),
    frontmatter,
    content: markdownContent
  };
}

export function getBlogPosts(): BlogPost[] {
  if (!existsSync(CONTENT_DIR)) {
    return [];
  }

  const files = readdirSync(CONTENT_DIR).filter(file => file.endsWith('.md'));
  const posts: BlogPost[] = [];

  for (const file of files) {
    try {
      const filePath = join(CONTENT_DIR, file);
      const fileContent = readFileSync(filePath, 'utf-8');
      const slug = file.replace('.md', '');

      // Process the markdown synchronously for this function
      // In a real app, you'd want to cache this or use async processing
      const processor = unified()
        .use(remarkParse)
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkExtractFrontmatter, {
          yaml: parseYaml,
          name: 'frontmatter'
        })
        .use(remarkRehype)
        .use(rehypeStringify);

      const result = processor.processSync(fileContent);
      const frontmatter = (result.data as any)?.frontmatter || {};

      // Remove frontmatter from content
      const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
      const content = fileContent.replace(frontmatterRegex, '');

      posts.push({
        slug,
        frontmatter: {
          title: frontmatter.title || 'Untitled',
          date: frontmatter.date || '',
          excerpt: frontmatter.excerpt || '',
          tags: frontmatter.tags || [],
          author: frontmatter.author || '',
          canonical: frontmatter.canonical || ''
        },
        content,
        html: String(result)
      });
    } catch (error) {
      console.error(`Error processing blog post ${file}:`, error);
    }
  }

  // Sort by date (newest first)
  return posts.sort((a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime());
}

export function getBlogPostBySlug(slug: string): BlogPost | null {
  const posts = getBlogPosts();
  return posts.find(post => post.slug === slug) || null;
}

export function getBlogPostList(): BlogPostListItem[] {
  const posts = getBlogPosts();
  return posts.map(post => ({
    slug: post.slug,
    title: post.frontmatter.title,
    date: post.frontmatter.date,
    excerpt: post.frontmatter.excerpt,
    tags: post.frontmatter.tags
  }));
}