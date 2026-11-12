import { Fragment, type ReactNode } from 'react';

/**
 * Простой и безопасный показ Markdown (QA-3, BUG-18): поле «Текст урока
 * (Markdown)» принимало разметку, а показывалась она «сырой» — «**QA**» со
 * звёздочками. Здесь — только то, чем реально пользуются в тексте урока:
 * **жирный**, *курсив*, `код`, [ссылка](https://…), голые ссылки, списки
 * (- / 1.), заголовки (#) и абзацы.
 *
 * HTML из текста НЕ исполняется: всё собирается из React-элементов, поэтому
 * «<script>» остаётся буквами. Ссылки — только http/https/mailto/tel.
 */
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)/i;

const INLINE = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?]))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${i++}`;
    if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key}>{m[2] ?? m[3]}</strong>);
    else if (m[4] !== undefined) out.push(<em key={key}>{m[4]}</em>);
    else if (m[5] !== undefined) out.push(<code key={key}>{m[5]}</code>);
    else if (m[6] !== undefined) {
      out.push(SAFE_URL.test(m[7]) ? <a key={key} href={m[7]} target="_blank" rel="noopener noreferrer">{m[6]}</a> : m[6]);
    } else if (m[8] !== undefined) {
      out.push(<a key={key} href={m[8]} target="_blank" rel="noopener noreferrer">{m[8]}</a>);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Текст без знаков разметки — для короткого превью в списках. */
export function stripMarkdown(text: string | null | undefined): string {
  return (text || '')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

export function MarkdownLite({ text, className }: { text: string | null | undefined; className?: string }) {
  const src = (text || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return null;
  const blocks = src.split(/\n{2,}/);
  return (
    <div className={`md-lite${className ? ` ${className}` : ''}`}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const bullets = lines.every((l) => /^\s*[-*]\s+/.test(l));
        const numbers = lines.every((l) => /^\s*\d{1,3}[.)]\s+/.test(l));
        if (bullets || numbers) {
          const items = lines.map((l, li) => (
            <li key={li}>{inline(l.replace(bullets ? /^\s*[-*]\s+/ : /^\s*\d{1,3}[.)]\s+/, ''), `${bi}-${li}`)}</li>
          ));
          return bullets ? <ul key={bi}>{items}</ul> : <ol key={bi}>{items}</ol>;
        }
        const h = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(lines[0]);
        if (h && lines.length === 1) {
          return <p key={bi} className="md-lite-h"><strong>{inline(h[2], `${bi}-h`)}</strong></p>;
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, `${bi}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
