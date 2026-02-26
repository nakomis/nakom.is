import React from 'react';

export default function BlogFooter() {
  return (
    <footer className="blog-footer">
      <div className="container">
        <div className="footer-content">
          <div className="ethical-ads">
            <div className="ad-placeholder">
              {/* EthicalAds placement - no intrusive/animated ads */}
              <div className="ethical-ad">
                <small>Advertisement</small>
              </div>
            </div>
          </div>

          <div className="footer-info">
            <p>
              <strong>Martin Harris</strong> — Hardware meets cloud.
            </p>
            <p>
              All code is <a href="https://creativecommons.org/public-domain/cc0/">CC0</a> unless otherwise noted.
              Knowledge shared freely.
            </p>
            <p>
              <a href="https://github.com/sponsors/nakomis">GitHub Sponsors</a> •
              <a href="https://nakom.is">nakom.is</a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}