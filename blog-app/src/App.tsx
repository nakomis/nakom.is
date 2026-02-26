import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import { BlogPost } from './types/blog';
import { loadBlogPost, loadBlogIndex } from './utils/blogLoader';
import Header from './components/Header';
import Footer from './components/Footer';
import HomePage from './components/HomePage';
import AdPlaceholder from './components/AdPlaceholder';
import './App.css';

const PostPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [post, setPost] = useState<BlogPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPost = async () => {
      if (!slug) {
        setError('No post slug provided');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const postData = await loadBlogPost(slug);
        setPost(postData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load post');
        setPost(null);
      } finally {
        setLoading(false);
      }
    };

    loadPost();
  }, [slug]);

  if (loading) {
    return (
      <div className="container">
        <Header />
        <main className="main-content">
          <div className="loading">Loading post...</div>
        </main>
        <Footer />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container">
        <Header />
        <main className="main-content">
          <div className="error">Error: {error}</div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="container">
        <Header />
        <main className="main-content">
          <div className="error">Post not found</div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="container">
      <Header />
      <main className="main-content">
        <article className="blog-post">
          <header className="post-header">
            <h1 className="post-title">{post.title}</h1>
            <div className="post-meta">
              <time dateTime={post.date}>{new Date(post.date).toLocaleDateString('en-GB', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}</time>
              {post.tags && post.tags.length > 0 && (
                <div className="post-tags">
                  {post.tags.map(tag => (
                    <span key={tag} className="tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          </header>
          <div className="post-content" dangerouslySetInnerHTML={{ __html: post.content }} />
        </article>
        <AdPlaceholder />
      </main>
      <Footer />
    </div>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/:slug" element={<PostPage />} />
      </Routes>
    </Router>
  );
};

export default App;