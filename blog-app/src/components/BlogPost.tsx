import React from 'react';
import { BlogPost } from '../types';

interface BlogPostProps {
  post: BlogPost;
}

export default function BlogPost({ post }: BlogPostProps) {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  return (
    <article className="blog-post">
      <header className="post-header">
        <h1>{post.frontmatter.title}</h1>
        <div className="post-meta">
          <span className="post-date">{formatDate(post.frontmatter.date)}</span>
          <span className="post-author">by {post.frontmatter.author}</span>
        </div>
        {post.frontmatter.tags.length > 0 && (
          <div className="post-tags">
            {post.frontmatter.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>

      <div
        className="post-content"
        dangerouslySetInnerHTML={{ __html: post.html }}
      />

      <footer className="post-footer">
        <div className="canonical-link">
          <p>
            <strong>Canonical URL:</strong>{' '}
            <a href={post.frontmatter.canonical}>{post.frontmatter.canonical}</a>
          </p>
        </div>
      </footer>
    </article>
  );
}