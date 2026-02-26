import React from 'react';
import { BlogPostListItem } from '../types';

interface BlogHomeProps {
  posts: BlogPostListItem[];
}

export default function BlogHome({ posts }: BlogHomeProps) {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  return (
    <div className="blog-home">
      <section className="hero">
        <div className="container">
          <h1>Hardware Meets Cloud</h1>
          <p className="thesis">
            <em>"Ceci n'est pas une API Gateway"</em>
          </p>
          <p className="description">
            Bridging the physical world of ESP32s and soldering irons with the abstract realm
            of cloud services and CDK stacks. Making the cloud real by wiring something tangible to it.
          </p>
        </div>
      </section>

      <section className="posts-list">
        <div className="container">
          <h2>Latest Posts</h2>

          {posts.length === 0 ? (
            <p className="no-posts">No posts yet. Check back soon!</p>
          ) : (
            <div className="posts-grid">
              {posts.map((post) => (
                <article key={post.slug} className="post-preview">
                  <header>
                    <h3>
                      <a href={`/posts/${post.slug}`}>{post.title}</a>
                    </h3>
                    <div className="post-meta">
                      <span className="post-date">{formatDate(post.date)}</span>
                    </div>
                  </header>

                  <div className="post-excerpt">
                    <p>{post.excerpt}</p>
                  </div>

                  {post.tags.length > 0 && (
                    <footer className="post-tags">
                      {post.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </footer>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}