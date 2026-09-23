import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Большая цифра карточки — всегда в одну строку. Не помещается по ширине —
 * шрифт уменьшается ровно настолько, насколько нужно; помещается — остаётся
 * таким, как задан. Раньше сумма вроде «26 000 TJS» на телефоне рвалась на
 * «26 000 TJ / S».
 *
 * Уменьшение — множителем через CSS-переменную --fit к исходному font-size,
 * поэтому исходный clamp(...) страницы не теряется: при повороте экрана или
 * смене числа цифра снова вырастает до исходного размера.
 */
export default function FitNumber({ children, style, min = 0.35, testId }: {
  children: ReactNode;
  style?: CSSProperties;
  /** Нижняя граница множителя: мельче 35% исходного шрифта не ужимаем. */
  min?: number;
  testId?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const scaleRef = useRef(1);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text) return;
    const fit = () => {
      const have = box.clientWidth;
      const need = text.getBoundingClientRect().width;
      if (!have || !need) return;
      const scale = scaleRef.current;
      // Уменьшаем только при настоящем переполнении, увеличиваем — только
      // при явном запасе места. Иначе в блоке, который берёт ширину по
      // своему тексту (элемент flex без заданной ширины), каждое ужатие
      // сжимало бы и сам блок — и цифра уменьшалась бы по кругу до минимума.
      const overflow = need > have + 0.5;
      const room = scale < 1 && need < have * 0.97;
      if (!overflow && !room) return;
      // Ширина текста пропорциональна шрифту — хватает одного пересчёта;
      // 0.99 — запас на округление, чтобы последняя буква не упиралась в край.
      const next = Math.max(min, Math.min(1, scale * (have / need) * 0.99));
      if (Math.abs(next - scale) < 0.005) return;
      scaleRef.current = next;
      box.style.setProperty('--fit', next.toFixed(3));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    // Шрифт догрузился или число сменилось — ширина текста другая.
    ro.observe(text);
    return () => ro.disconnect();
  }, [children, min]);

  const base = style?.fontSize;
  return (
    <div
      ref={boxRef}
      data-testid={testId}
      className="fit-number"
      style={{
        ...style,
        ...(base != null ? { fontSize: `calc(var(--fit, 1) * ${typeof base === 'number' ? `${base}px` : base})` } : {}),
        whiteSpace: 'nowrap',
      }}
    >
      <span ref={textRef} className="fit-number-text">{children}</span>
    </div>
  );
}
