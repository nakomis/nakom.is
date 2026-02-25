import './Footer.css';
import versionData from '../../version.json';

function Footer() {
  return (
    <div className="app-footer">
      v{versionData.version} · <a href="https://nakom.is/nakom.is" target="_blank" rel="noreferrer">Open source</a>
    </div>
  );
}

export default Footer;
