export default function BlogFooter() {
  return (
    <footer className="blog-footer">
      <div className="container">
        <p>
          © 2026 Martin Harris. All rights reserved.{' '}
          <a href="https://github.com/nakomis/nakom.is" target="_blank" rel="noopener">
            Website code
          </a>{' '}
          licensed under CC0.
        </p>
        <p>
          <em>"Ceci n'est pas une API Gateway"</em> — Making cloud abstractions tangible through physical hardware.
        </p>
        {/* EthicalAds placeholder */}
        <div className="ethical-ads-placeholder">
          <div className="ad-notice">Ad space reserved for EthicalAds</div>
        </div>
      </div>
    </footer>
  );
}