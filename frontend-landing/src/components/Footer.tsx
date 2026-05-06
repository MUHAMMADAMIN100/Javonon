import { motion } from 'framer-motion';
import Icon from '../Icon';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <motion.div
          className="footer-grid"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="footer-brand">
            <a href="#" className="logo">
              <span className="logo-mark">J</span>
              <span className="logo-text">Javonon</span>
            </a>
            <p>
              Международная платформа грантов и стипендий. Помогаем студентам со всего мира
              получить образование в лучших университетах планеты.
            </p>
            <div className="footer-social" style={{ marginTop: 18 }}>
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
            <h4>Навигация</h4>
            <ul>
              <li><a href="#services">Услуги</a></li>
              <li><a href="#directions">Страны</a></li>
              <li><a href="#advantages">Преимущества</a></li>
              <li><a href="#testimonials">Отзывы</a></li>
              <li><a href="#contacts">Контакты</a></li>
              <li><a href="#apply">Подать заявку</a></li>
            </ul>
          </div>

          <div>
            <h4>Гранты</h4>
            <ul>
              <li><a href="#directions">🇺🇸 Fulbright</a></li>
              <li><a href="#directions">🇬🇧 Chevening</a></li>
              <li><a href="#directions">🇩🇪 DAAD</a></li>
              <li><a href="#directions">🇰🇷 GKS Korea</a></li>
              <li><a href="#directions">🇨🇳 CSC China</a></li>
              <li><a href="#directions">🇪🇺 Erasmus Mundus</a></li>
            </ul>
          </div>

          <div>
            <h4>Контакты</h4>
            <ul>
              <li><a href="tel:+992900000000">+992 900 000 000</a></li>
              <li><a href="mailto:hello@javonon.com">hello@javonon.com</a></li>
              <li><a href="https://t.me/javonon">@javonon</a></li>
              <li>Душанбе, ул. Рудаки 55</li>
            </ul>
          </div>
        </motion.div>

        <div className="footer-bottom">
          <div>© {new Date().getFullYear()} Javonon. Международные гранты на образование.</div>
          <div>Made with 💚 for ambitious students worldwide</div>
        </div>
      </div>
    </footer>
  );
}
