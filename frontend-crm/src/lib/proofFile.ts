/**
 * Проверка файла-подтверждения ДО отправки (QA-3, BUG-29): раньше форма
 * ставила «✓» любому файлу (.html, .exe), а сервер отвечал отказом только
 * после нажатия «Начать работу». Список видов — тот же, что на сервере
 * (backend/src/time-tracking/time-tracking.controller.ts).
 *
 *  presence — подтверждение присутствия: фото или видео, снятые сейчас;
 *  excuse   — файл к причине опоздания: фото, видео или PDF-справка.
 */
export type ProofKind = 'presence' | 'excuse';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', '3gp'];
const MAX_BYTES = 50 * 1024 * 1024;
/** Снимок для подтверждения присутствия должен быть свежим. */
const FRESH_MS = 15 * 60 * 1000;

const ACCEPT_MEDIA =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm,' +
  [...IMAGE_EXT, ...VIDEO_EXT].map((e) => `.${e}`).join(',');

export const PROOF_ACCEPT: Record<ProofKind, string> = {
  presence: ACCEPT_MEDIA,
  excuse: `${ACCEPT_MEDIA},application/pdf,.pdf`,
};

export type ProofFileError = 'type' | 'size' | 'stale';

/** null — файл подходит; иначе причина отказа (ключ текста — `time.file.<причина>`). */
export function checkProofFile(file: File, kind: ProofKind, now = Date.now()): ProofFileError | null {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const allowed = kind === 'excuse' ? [...IMAGE_EXT, ...VIDEO_EXT, 'pdf'] : [...IMAGE_EXT, ...VIDEO_EXT];
  if (!allowed.includes(ext)) return 'type';
  const mime = (file.type || '').toLowerCase();
  // Пустой тип бывает у HEIC в некоторых браузерах — тогда верим расширению.
  if (mime && !(mime.startsWith('image/') || mime.startsWith('video/') || (kind === 'excuse' && mime === 'application/pdf'))) {
    return 'type';
  }
  if (file.size > MAX_BYTES) return 'size';
  if (kind === 'presence' && file.lastModified && now - file.lastModified > FRESH_MS) return 'stale';
  return null;
}
