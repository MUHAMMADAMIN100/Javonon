import { Fragment, type ReactNode } from 'react';

/**
 * Минималистичный markdown-рендерер без зависимостей. Поддерживает:
 *   **жирный** *курсив* `код` [ссылка](https://)
 *   - маркированный список
 *   1. нумерованный список
 *   ## заголовки
 *   \n\n параграфы
 *
 * Зачем не react-markdown: лишние +60KB в bundle + риск Vercel-build
 * fail на новой зависимости. Этот хватает для описания программы.
 *
 * Безопасность: текст уже прошёл NO_HTML на бэке (запрещены `<>`),
 * сам не вставляю dangerouslySetInnerHTML — рендерим как React-ноды.
 */
export function MiniMarkdown({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => renderBlock(b, i))}
    </>
  );
}

type Block =
  | { kind: 'heading'; level: 2 | 3; content: string }
  | { kind: 'paragraph'; content: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Heading
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { out.push({ kind: 'heading', level: 2, content: h2[1] }); i++; continue; }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) { out.push({ kind: 'heading', level: 3, content: h3[1] }); i++; continue; }
    // Bullet list
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }
    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items });
      continue;
    }
    // Paragraph — собираем подряд идущие непустые строки
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(##?#?\s|\s*-\s|\s*\d+\.\s)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ kind: 'paragraph', content: para.join(' ') });
  }
  return out;
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case 'heading':
      return b.level === 2
        ? <h2 key={key} style={{ marginTop: 16, marginBottom: 8 }}>{renderInline(b.content)}</h2>
        : <h3 key={key} style={{ marginTop: 12, marginBottom: 6 }}>{renderInline(b.content)}</h3>;
    case 'paragraph':
      return <p key={key} style={{ margin: '8px 0', lineHeight: 1.6 }}>{renderInline(b.content)}</p>;
    case 'ul':
      return (
        <ul key={key} style={{ margin: '8px 0', paddingLeft: 24, lineHeight: 1.6 }}>
          {b.items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} style={{ margin: '8px 0', paddingLeft: 24, lineHeight: 1.6 }}>
          {b.items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ol>
      );
  }
}

/** Inline-форматирование: **bold** / *italic* / `code` / [link](url).
 *  Простой scanner — для production-документации хватает; вложенность
 *  не поддерживаем (например **жирный *и курсив*** не получится). */
function renderInline(text: string): ReactNode {
  // Сначала вытаскиваем ссылки чтобы не сломать парсинг bold/italic внутри URL.
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(<Fragment key={key++}>{renderBoldItalic(text.slice(last, m.index))}</Fragment>);
    }
    parts.push(
      <a key={key++} href={m[2]} target="_blank" rel="noreferrer">
        {renderBoldItalic(m[1])}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Fragment key={key++}>{renderBoldItalic(text.slice(last))}</Fragment>);
  }
  return <>{parts}</>;
}

function renderBoldItalic(text: string): ReactNode {
  // **bold** — двойные звёздочки. *italic* — одинарные. `code` — backticks.
  // Простой posession: bold имеет приоритет (длиннее).
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        out.push(<strong key={key++}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        out.push(<em key={key++}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        out.push(<code key={key++}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // Обычный символ — копим в строку
    let chunk = '';
    while (i < text.length && text[i] !== '*' && text[i] !== '`') {
      chunk += text[i];
      i++;
    }
    if (chunk) out.push(<Fragment key={key++}>{chunk}</Fragment>);
  }
  return <>{out}</>;
}
