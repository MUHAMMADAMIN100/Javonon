import Icon from '../Icon';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand">
            <a href="#" className="brand">
              <span className="brand-dot">J</span>
              <span>Javonon</span>
            </a>
            <p>
              International grants platform — Fulbright, DAAD, Chevening,
              GKS, MEXT, CSC, Erasmus and beyond. From application to
              admission, with a real human at every step.
            </p>
            <div className="footer-socials">
              <a href="https://t.me/javonon" target="_blank" rel="noreferrer" aria-label="Telegram">
                <Icon name="send" size={18} />
              </a>
              <a href="https://wa.me/992900000000" target="_blank" rel="noreferrer" aria-label="WhatsApp">
                <Icon name="chat" size={18} />
              </a>
              <a href="https://instagram.com/javonon" target="_blank" rel="noreferrer" aria-label="Instagram">
                <Icon name="photo_camera" size={18} />
              </a>
              <a href="mailto:hello@javonon.com" aria-label="Email">
                <Icon name="mail" size={18} />
              </a>
            </div>
          </div>

          <div>
            <h4>Navigate</h4>
            <ul>
              <li><a href="#services">Process</a></li>
              <li><a href="#countries">Countries</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#voices">Voices</a></li>
              <li><a href="#apply">Apply</a></li>
            </ul>
          </div>

          <div>
            <h4>Grants</h4>
            <ul>
              <li><a href="#countries">🇺🇸 Fulbright</a></li>
              <li><a href="#countries">🇬🇧 Chevening</a></li>
              <li><a href="#countries">🇩🇪 DAAD</a></li>
              <li><a href="#countries">🇰🇷 GKS Korea</a></li>
              <li><a href="#countries">🇨🇳 CSC China</a></li>
              <li><a href="#countries">🇪🇺 Erasmus</a></li>
            </ul>
          </div>

          <div>
            <h4>Contact</h4>
            <ul>
              <li><a href="mailto:hello@javonon.com">hello@javonon.com</a></li>
              <li><a href="https://t.me/javonon">@javonon</a></li>
              <li><a href="tel:+992900000000">+992 900 000 000</a></li>
              <li>Dushanbe, Tajikistan</li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <div>© {year} JAVONON · INTERNATIONAL GRANTS</div>
          <div>BUILT FOR AMBITIOUS MINDS</div>
        </div>
      </div>

      <div className="footer-mega">JAVONON</div>
    </footer>
  );
}
