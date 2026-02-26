// This will be populated at build time
declare const BLOG_POSTS: BlogPost[];

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import matter from 'gray-matter';
import { BlogPost, BlogPostListItem } from '../types';

export async function getBlogPosts(): Promise<BlogPost[]> {
  // In development, return empty array - posts loaded at build time
  if (import.meta.env.DEV) {
    return [];
  }
  return BLOG_POSTS;
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  const posts = await getBlogPosts();
  return posts.find(post => post.slug === slug) || null;
}

export function getBlogPostList(posts: BlogPost[]): BlogPostListItem[] {
  return posts
    .map(post => ({
      slug: post.slug,
      title: post.frontmatter.title,
      date: post.frontmatter.date,
      excerpt: post.frontmatter.excerpt,
      tags: post.frontmatter.tags,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function processMarkdown(markdownContent: string, slug: string): Promise<BlogPost> {
  const { data: frontmatter, content } = matter(markdownContent);

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkRehype)
    .use(rehypeHighlight)
    .use(rehypeStringify);

  const result = await processor.process(content);

  return {
    slug,
    frontmatter: frontmatter as BlogPost['frontmatter'],
    content,
    html: result.toString(),
  };
}