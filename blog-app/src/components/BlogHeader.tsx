export default function BlogHeader() {
  return (
    <header className="header">
      <div className="header-content">
        <a href="/">
          <img src="/logo-shaded-transparent.png" alt="nakom.is" className="logo" />
        </a>
        <div className="hero-text">
          <h1 className="hero-name">Martin Harris</h1>
          <p className="hero-tagline">
            <em>"Ceci n'est pas une API Gateway"</em>
          </p>
          <p className="hero-description">Making cloud abstractions tangible through physical hardware.</p>
        </div>
      </div>
    </header>
  );
}
