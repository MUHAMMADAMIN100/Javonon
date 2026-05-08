import { useEffect, useRef, useState, createElement } from 'react';
import type { ReactElement } from 'react';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';

/**
 * Защита от потери несохранённых данных формы.
 *
 * Когда `when=true`:
 *  1. beforeunload — браузер показывает нативное предупреждение при
 *     закрытии вкладки или перезагрузке страницы (это политика безопасности
 *     браузера — кастомный UI здесь невозможен).
 *  2. click capture — перехватывает клики по внутренним ссылкам (<a> /
 *     <Link>) и показывает кастомную модалку <UnsavedChangesDialog>.
 *  3. popstate — кнопка "назад" / "вперёд" в браузере: возвращает history
 *     на текущий URL и показывает ту же модалку.
 *
 * Возвращает `{ modal }` — JSX модалки, который нужно отрендерить в JSX
 * компонента, например `<>...{modal}</>`.
 *
 * Не перехватывает программный navigate() из react-router внутри кода —
 * переопределение history.pushState ломает внутреннее состояние router.
 */
export function useUnsavedChangesGuard(
  when: boolean,
  message?: string,
): { modal: ReactElement } {
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const lastHrefRef = useRef<string>(typeof window !== 'undefined' ? window.location.href : '');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      lastHrefRef.current = window.location.href;
    }
  }, []);

  useEffect(() => {
    if (!when) return;

    // Раньше тут был window.addEventListener('beforeunload') —
    // но он показывает страшный native-диалог браузера ("Закрыть сайт?
    // Изменения могут не сохраниться"), который НЕЛЬЗЯ стилизовать
    // (security restriction). Кастомная модалка перехватывает
    // внутреннюю навигацию (клики по <a> и popstate) — этого достаточно.

    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (!anchor || !anchor.href) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      try {
        const url = new URL(anchor.href);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === window.location.pathname) {
          if (url.search === window.location.search) return;
        }
      } catch {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      setPendingHref(anchor.href);
    };

    const onPopState = () => {
      if (window.location.href === lastHrefRef.current) return;
      const goingTo = window.location.href;
      window.history.pushState(null, '', lastHrefRef.current);
      setPendingHref(goingTo);
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);

    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [when]);

  useEffect(() => {
    if (!when && typeof window !== 'undefined') {
      lastHrefRef.current = window.location.href;
    }
  }, [when]);

  const onConfirm = () => {
    if (pendingHref) {
      window.location.href = pendingHref;
    }
    setPendingHref(null);
  };

  const onCancel = () => setPendingHref(null);

  const modal = createElement(UnsavedChangesDialog, {
    open: pendingHref !== null,
    onConfirm,
    onCancel,
    message,
  });

  return { modal };
}
