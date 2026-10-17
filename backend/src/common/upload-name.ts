/**
 * multer читает имя файла как latin1, и «задание.pdf» превращалось в
 * «Ð·Ð°Ð´Ð°Ð½Ð¸Ðµ.pdf». Перекодируем в UTF-8, если это действительно UTF-8
 * (тот же приём, что в chat.controller.ts).
 */
export function utf8Name(name: string): string {
  if (!name || !/[\u0080-ÿ]/.test(name)) return name;
  const fixed = Buffer.from(name, 'latin1').toString('utf8');
  return fixed.includes('�') ? name : fixed;
}

/**
 * Заголовок Content-Disposition для скачивания с русским/таджикским именем:
 * ASCII-запасное имя + filename* по RFC 5987.
 */
export function contentDisposition(name: string, inline = false): string {
  const safe = (name || 'file').replace(/[\r\n"]/g, '').slice(0, 200) || 'file';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
