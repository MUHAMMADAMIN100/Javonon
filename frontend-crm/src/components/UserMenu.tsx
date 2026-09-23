import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Меню пользователя внизу сайдбара: вместо шести значков в узком rail —
 * один аватар, по клику меню с профилем, базой знаний, языком, сменой
 * пароля и выходом. Одно и то же меню на компьютере (rail, меню справа от
 * аватара) и в выезжающей панели телефона (строка с именем, меню над ней).
 * Рендерится в body: сайдбар обрезает всё, что вылезает за его край.
 */
export default function UserMenu({
  variant,
  initials,
  fullName,
  roleLabel,
  profileTo,
  profileLabel,
  profileLinkProps,
  knowledgeHref,
  onChangePassword,
  onLogout,
}: {
  variant: 'rail' | 'mobile';
  initials: string;
  fullName: string;
  roleLabel: string;
  profileTo: string;
  profileLabel: string;
  /** Подогрев кеша профиля при наведении (как у пунктов меню). */
  profileLinkProps?: HTMLAttributes<HTMLAnchorElement>;
  knowledgeHref: string;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const { t, lang, setLang } = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();

  // Место меню: справа от аватара (rail) или над строкой пользователя (телефон).
  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const bottom = Math.max(8, window.innerHeight - (variant === 'rail' ? r.bottom : r.top - 8));
    if (variant === 'rail') setPos({ left: r.right + 12, bottom });
    else setPos({ left: Math.max(8, r.left), bottom, width: Math.min(r.width, window.innerWidth - 16) });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => place();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Перешли на другую страницу — меню закрываем.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`user-menu-trigger is-${variant}${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${fullName} · ${roleLabel}`}
        data-testid="user-menu-trigger"
      >
        <span className="user-avatar">{initials}</span>
        {variant === 'mobile' && (
          <>
            <span className="user-menu-trigger-text">
              <span className="user-name">{fullName}</span>
              <span className="user-role">{roleLabel}</span>
            </span>
            <Icon name={open ? 'expand_more' : 'expand_less'} size={20} />
          </>
        )}
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menuRef}
              className={`user-menu is-${variant}`}
              role="menu"
              data-testid="user-menu"
              style={pos}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ duration: 0.14 }}
            >
              <div className="user-menu-head">
                <span className="user-avatar">{initials}</span>
                <span className="user-menu-head-text">
                  <span className="user-menu-name">{fullName}</span>
                  <span className="user-menu-role">{roleLabel}</span>
                </span>
              </div>
              <NavLink to={profileTo} className="user-menu-item" role="menuitem" onClick={close} data-testid="user-menu-profile" {...profileLinkProps}>
                <Icon name="person" size={20} /> {profileLabel}
              </NavLink>
              <a href={knowledgeHref} target="_blank" rel="noreferrer" className="user-menu-item" role="menuitem" onClick={close} data-testid="user-menu-knowledge">
                <Icon name="library_books" size={20} /> {t('sidebar.knowledge')}
                <Icon name="open_in_new" size={14} className="user-menu-ext" />
              </a>
              <div className="user-menu-lang" data-testid="user-menu-lang">
                <Icon name="translate" size={20} />
                <span>{t('userMenu.language')}</span>
                <span className="user-menu-seg">
                  <button type="button" className={lang === 'ru' ? 'is-on' : ''} onClick={() => setLang('ru')} title="Русский" data-testid="user-menu-lang-ru">RU</button>
                  <button type="button" className={lang === 'tg' ? 'is-on' : ''} onClick={() => setLang('tg')} title="Тоҷикӣ" data-testid="user-menu-lang-tj">TJ</button>
                </span>
              </div>
              <button
                type="button"
                className="user-menu-item"
                role="menuitem"
                onClick={() => { close(); onChangePassword(); }}
                data-testid="user-menu-password"
              >
                <Icon name="lock_reset" size={20} /> {t('auth.changePassword')}
              </button>
              <div className="user-menu-sep" />
              <button
                type="button"
                className="user-menu-item is-danger"
                role="menuitem"
                onClick={() => { close(); onLogout(); }}
                data-testid="user-menu-logout"
              >
                <Icon name="logout" size={20} /> {t('auth.logout')}
              </button>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
