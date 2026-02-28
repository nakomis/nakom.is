export default function BlogHeader() {
  return (
    <header className="header">
      <div className="header-content">
        <img src="/logo.svg" alt="nakom.is" className="logo" />
        <a href="/" className="site-title">
          blog.nakom.is
        </a>
        <div className="site-subtitle">
          Hardware meets cloud
        </div>
      </div>
    </header>
  );
}