import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import Icon from '../Icon';

const NAV_ITEMS = [
  { href: '/#services', label: 'Услуги' },
  { href: '/#countries', label: 'Страны' },
  { href: '/#how', label: 'Как это работает' },
  { href: '/knowledge', label: 'База знаний' },
  { href: '/#apply', label: 'Заявка' },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <motion.header
      className={`header${scrolled ? ' scrolled' : ''}`}
      initial={{ y: -40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="container header-row">
        <a href="#" className="brand brand-img" aria-label="Javonon">
          <img src="/javonon-logo.svg" alt="Javonon" />
        </a>

        <nav className="nav">
          {NAV_ITEMS.map((i) => (
            <a key={i.href} href={i.href}>{i.label}</a>
          ))}
        </nav>

        <div className="header-cta">
          <Link to="/login" className="btn-pill ghost">
            <Icon name="lock" size={14} />
            Вход
          </Link>
          <Link to="/register" className="btn-pill solid">
            Регистрация
            <Icon name="arrow_outward" size={16} />
          </Link>
          <button
            type="button"
            className="burger"
            aria-label="Открыть меню"
            onClick={() => setOpen(true)}
          >
            <Icon name="menu" size={20} />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            style={{
              position: 'fixed', inset: 0, zIndex: 200,
              background: 'rgba(5, 7, 6, 0.96)',
              backdropFilter: 'blur(20px)',
              padding: 32,
              display: 'flex', flexDirection: 'column',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="brand brand-img brand-img-light" aria-label="Javonon">
                <img src="/javonon-logo.svg" alt="Javonon" />
              </span>
              <button
                type="button"
                className="burger"
                onClick={() => setOpen(false)}
                aria-label="Закрыть меню"
              >
                <Icon name="close" size={20} />
              </button>
            </div>
            <nav
              style={{
                marginTop: 64,
                display: 'flex', flexDirection: 'column', gap: 4,
                fontFamily: 'var(--display)',
              }}
            >
              {NAV_ITEMS.map((i, idx) => (
                <motion.a
                  key={i.href}
                  href={i.href}
                  onClick={() => setOpen(false)}
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 + 0.1 }}
                  style={{
                    fontSize: 48,
                    color: 'white',
                    padding: '12px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {i.label}
                </motion.a>
              ))}
            </nav>
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Link to="/login" className="btn btn-ghost-dark" onClick={() => setOpen(false)}>
                <Icon name="lock" size={18} /> Личный кабинет
              </Link>
              <a href="#apply" className="btn btn-primary" onClick={() => setOpen(false)}>
                Подать заявку
                <Icon name="arrow_outward" size={18} />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
