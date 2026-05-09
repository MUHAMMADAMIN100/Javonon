import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

  // Drawer рендерится через Portal в body — иначе motion.header (с transform
  // от анимации) создаёт containing block, и position:fixed внутри него
  // привязывается к header'у, а не к viewport — drawer "проваливается".
  const drawer = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="land-drawer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="land-drawer-head">
            <span className="brand brand-img" aria-label="Javonon">
              <img src="/javonon-logo.svg" alt="Javonon" />
            </span>
            <button
              type="button"
              className="land-drawer-close"
              onClick={() => setOpen(false)}
              aria-label="Закрыть меню"
            >
              <Icon name="close" size={22} />
            </button>
          </div>
          <nav className="land-drawer-nav">
            {NAV_ITEMS.map((i, idx) => (
              <motion.a
                key={i.href}
                href={i.href}
                onClick={() => setOpen(false)}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04 + 0.05 }}
              >
                {i.label}
              </motion.a>
            ))}
          </nav>
          <div className="land-drawer-cta">
            <Link to="/login" className="btn-pill ghost" onClick={() => setOpen(false)}>
              <Icon name="lock" size={16} /> Личный кабинет
            </Link>
            <Link to="/register" className="btn-pill solid" onClick={() => setOpen(false)}>
              Регистрация
              <Icon name="arrow_outward" size={16} />
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
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
      </motion.header>
      {typeof document !== 'undefined' && createPortal(drawer, document.body)}
    </>
  );
}
