import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';

/**
 * Окно формы по центру экрана.
 *
 * Зачем один компонент на всё: формы создания раньше разворачивались прямо
 * в странице и сдвигали список вниз — на длинной форме человек терял из
 * виду и список, и кнопку «Сохранить». Каждая страница делала это
 * по-своему, поэтому и поведение (закрытие, предупреждение о потере
 * введённого) везде отличалось. Теперь правила одни:
 *
 *  • закрывается по Esc, крестиком и кликом мимо окна;
 *  • если в форме что-то введено (`dirty`), перед закрытием спрашивает
 *    подтверждение — иначе случайный клик мимо стирает получасовую работу;
 *  • пока идёт сохранение (`busy`), не закрывается вовсе;
 *  • Esc не закрывает окно, когда поверх него открыт календарь или другой
 *    выпадающий список: этот Esc относится к ним.
 */
export default function FormModal({
  open,
  title,
  onClose,
  dirty,
  busy,
  children,
  width,
  testId,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /**
   * Есть ли несохранённые изменения. Если не передать, окно определит это
   * само, сравнив значения полей с теми, что были при открытии.
   */
  dirty?: boolean;
  /** Идёт сохранение — закрывать нельзя. */
  busy?: boolean;
  children: React.ReactNode;
  /** Ширина окна; по умолчанию 720px. */
  width?: number;
  testId?: string;
}) {
  const { t } = useT();
  const { confirm } = useUI();

  /* ------------------------------------------------------------------
   * «В форме что-то введено» без участия самой формы.
   *
   * Снимок значений всех полей окна через 400 мс после открытия (к этому
   * моменту справочники в выпадающих списках уже подгрузились и не дают
   * ложного «изменено»), потом сравнение на закрытии. Так предупреждение
   * о потере данных работает во ВСЕХ формах одинаково, и ни одну из них
   * не пришлось переписывать. Страница может задать `dirty` явно — тогда
   * её ответ главнее.
   * ---------------------------------------------------------------- */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const snapshot = useRef<string[] | null>(null);

  const readFields = () => {
    const root = bodyRef.current;
    if (!root) return [];
    return [...root.querySelectorAll('input, select, textarea')].map((el) => {
      const f = el as HTMLInputElement;
      return f.type === 'checkbox' || f.type === 'radio' ? String(f.checked) : f.value;
    });
  };

  useEffect(() => {
    if (!open) { snapshot.current = null; return; }
    snapshot.current = null;
    const id = setTimeout(() => { snapshot.current = readFields(); }, 400);
    return () => clearTimeout(id);
  }, [open]);

  const isDirty = () => {
    if (dirty !== undefined) return dirty;
    const before = snapshot.current;
    if (!before) return false;      // снимок ещё не снят — трогать не успели
    const now = readFields();
    return now.length !== before.length || now.some((v, i) => v !== before[i]);
  };

  const requestClose = async () => {
    if (busy) return;
    if (isDirty()) {
      const ok = await confirm({
        title: t('form.closeConfirm.title'),
        message: t('form.closeConfirm.message'),
        confirmText: t('form.closeConfirm.ok'),
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  // Ref, а не значение: обработчик вешается один раз на открытие, а
  // requestClose пересоздаётся на каждый рендер (зависит от dirty/busy).
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Поверх формы может быть открыт календарь, список стран или другое
      // окно — Esc тогда принадлежит им, а не нам.
      const popupOpen = [
        ...document.querySelectorAll('.crm-datepicker-popover, .crm-select-popover, .phone-dropdown, .dialog-card'),
      ].some((el) => !el.classList.contains('form-modal-card'));
      if (popupOpen) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // Фон страницы не должен прокручиваться под открытым окном.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <motion.div
      className="dialog-backdrop form-modal"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // mousedown, а не click: выделил текст в поле и отпустил мышь за краем
      // окна — это не «клик мимо», закрывать нельзя.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <motion.div
        className="dialog-card form-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={width ? { maxWidth: width } : undefined}
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="form-modal-head">
          <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>
          <button
            type="button"
            className="form-modal-close"
            aria-label={t('common.close')}
            data-testid="form-modal-close"
            onClick={requestClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="form-modal-body" ref={bodyRef}>{children}</div>
      </motion.div>
    </motion.div>
  );
}
