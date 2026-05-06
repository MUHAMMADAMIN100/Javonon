import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import Icon from '../Icon';

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/#services', label: 'Услуги' },
  { href: '/#directions', label: 'Страны' },
  { href: '/#advantages', label: 'Преимущества' },
  { href: '/#testimonials', label: 'Отзывы' },
  { href: '/#contacts', label: 'Контакты' },
];

export default function Header() {
  const [open, setOpen] = useState(false);

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
      className="header"
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="container header-inner">
        <motion.a
          href="#"
          className="logo"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
        >
          <span className="logo-mark">J</span>
          <span className="logo-text">Javonon</span>
        </motion.a>

        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <motion.a key={item.href} href={item.href} whileHover={{ y: -2 }}>
              {item.label}
            </motion.a>
          ))}
        </nav>

        <div className="header-actions">
          <Link to="/login" className="header-login">
            <Icon name="person" size={18} />
            <span>Вход</span>
          </Link>
          <motion.a
            href="#apply"
            className="btn btn-primary btn-small"
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
          >
            Подать заявку
          </motion.a>
        </div>

        <button
          type="button"
          className="header-burger"
          aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
          onClick={() => setOpen(true)}
        >
          <Icon name="menu" size={24} />
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            className="mobile-drawer open"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <div className="mobile-drawer-inner" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="mobile-drawer-close"
                aria-label="Закрыть меню"
                onClick={() => setOpen(false)}
              >
                <Icon name="close" size={22} />
              </button>
              {NAV_ITEMS.map((item) => (
                <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
                  {item.label}
                </a>
              ))}
              <Link to="/login" className="btn btn-ghost" onClick={() => setOpen(false)}>
                <Icon name="person" size={18} /> Вход в кабинет
              </Link>
              <a href="#apply" className="btn btn-primary" onClick={() => setOpen(false)}>
                Подать заявку
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
