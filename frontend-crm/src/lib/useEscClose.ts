import { useEffect, useRef } from 'react';

/**
 * Esc закрывает окно — одно правило для всех окон CRM (QA-3, BUG-01: окно
 * «Новый сотрудник» по Esc не закрывалось, потому что каждая страница
 * рисовала своё окно и про клавишу забывала).
 *
 *  • срабатывает только верхнее окно: открыто подтверждение поверх формы —
 *    Esc закрывает подтверждение, форма остаётся;
 *  • если поверх окна открыт календарь или выпадающий список, Esc относится
 *    к ним, окно не закрывается;
 *  • `busy` — идёт сохранение, закрывать нельзя.
 *
 * Новое окно = один вызов `useEscClose(open, close)`.
 */
const stack: symbol[] = [];

const POPUPS = '.crm-datepicker-popover, .crm-select-popover, .phone-dropdown';

export function useEscClose(open: boolean, onClose: () => void, busy = false) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const id = Symbol('dialog');
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (stack[stack.length - 1] !== id) return;
      if (document.querySelector(POPUPS)) return;
      if (busyRef.current) return;
      // Помечаем событие обработанным: окно ниже по стеку (и FormModal со
      // своим обработчиком) на этот же Esc не закроется.
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
