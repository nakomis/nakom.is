import React from 'react';

export default function BlogFooter() {
  return (
    <footer className="blog-footer">
      <div className="container">
        <p>
          © 2026 Martin Harris. All content licensed under{' '}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">
            CC0
          </a>
          .
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