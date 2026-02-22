const links = [
  { id: 'link-cv', href: 'https://nakom.is/cv', icon: 'fas fa-file-alt', colorClass: 'cv', label: 'CV / Resume', connected: true },
  { id: 'link-linkedin', href: 'https://www.linkedin.com/in/nakomis', icon: 'fab fa-linkedin', colorClass: 'linkedin', label: 'LinkedIn', connected: true },
  { id: 'link-github', href: 'https://github.com/nakomis/', icon: 'fab fa-github', colorClass: 'github', label: 'GitHub', connected: true },
  { id: 'link-bluesky', href: 'https://bsky.app/profile/nakomis.com', icon: 'fas fa-cloud', colorClass: 'bluesky', label: 'Bluesky', connected: false },
  { id: 'link-facebook', href: 'https://www.facebook.com/Nakomis/', icon: 'fab fa-facebook', colorClass: 'facebook', label: 'Facebook', connected: false },
  { id: 'link-twitter', href: 'https://x.com/nakomis', icon: 'fab fa-twitter', colorClass: 'twitter', label: '(fka) Twitter', connected: false },
];

function SocialLinks() {
  return (
    <div className="social-column">
      <div className="social-links">
        {links.map((link) => (
          <a
            key={link.href}
            id={link.id}
            href={link.href}
            className={`social-link${link.connected ? ' connected' : ''}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <i className={`${link.icon} ${link.colorClass}`}></i>
            <span>{link.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export default SocialLinks;
