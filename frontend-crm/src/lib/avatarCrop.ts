/**
 * Фото на аватарке: обрезаем квадрат по центру и уменьшаем до 256×256 прямо
 * в браузере — на сервер уходит лёгкий JPEG, а не снимок с телефона на 8 МБ.
 * Подходят JPG, PNG, WEBP (то же проверяет сервер); исходник — до 5 МБ
 * (21.11.2026). Ошибки — понятным текстом для тоста.
 */
export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const OUT = 256;

export class AvatarFileError extends Error {}

export async function cropAvatar(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new AvatarFileError('wrongType');
  }
  if (file.size > AVATAR_MAX_BYTES) throw new AvatarFileError('tooBig');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new AvatarFileError('broken'));
      el.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new AvatarFileError('broken');
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AvatarFileError('broken');
    // Белый фон: у PNG с прозрачностью JPEG иначе даёт чёрные углы.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, OUT, OUT);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new AvatarFileError('broken');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
