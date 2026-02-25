import './Footer.css';
import versionData from '../../version.json';

function Footer() {
  return (
    <><div className="app-footer">
          v{versionData.version} · Designed and built by Nakomis · Open-source <a href="https://creativecommons.org/public-domain/cc0/" target="_blank" rel="noreferrer">CC0</a> code available on <a href="https://nakom.is/nakom.is" target="_blank" rel="noreferrer">GitHub</a>.
    </div></>
  );
}

export default Footer;
