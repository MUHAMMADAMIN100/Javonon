/**
 * Реферальный трекинг на лендинге.
 *
 *  - На первом визите парсим ?ref=CODE из URL → сохраняем в localStorage
 *    (cookie был бы лучше для cross-subdomain, но localStorage достаточно
 *    для MVP — все наши лендинги на одном домене).
 *  - При регистрации студента / отправке заявки — берём сохранённый ref
 *    и пробрасываем в backend.
 *  - Длительность: 90 дней (matches backend attribution TTL).
 */

const KEY = 'javonon_ref';
const TTL_MS = 90 * 24 * 3600 * 1000;

interface RefRecord {
  code: string;
  capturedAt: number;
}

function read(): RefRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as RefRecord;
    if (!r.code) return null;
    if (Date.now() - r.capturedAt > TTL_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

function write(code: string) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ code: code.toUpperCase(), capturedAt: Date.now() }),
    );
  } catch {}
}

/** Вызывается один раз при загрузке приложения. */
export function captureReferralFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref') || params.get('r');
    if (ref && /^[A-Z0-9]{4,16}$/i.test(ref)) {
      write(ref);
      // Логируем клик на backend — для статистики переходов партнёра.
      // Не ждём ответа (fire-and-forget).
      const apiUrl =
        (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001';
      fetch(`${apiUrl}/api/referrals/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ref.toUpperCase(), source: 'SITE' }),
        credentials: 'omit',
      }).catch(() => undefined);
    }
  } catch {}
}

/** Возвращает текущий сохранённый ref-код (или null). */
export function getReferral(): string | null {
  return read()?.code ?? null;
}

/** Очистить сохранённый ref (вызывается после успешного "конверсии"). */
export function clearReferral() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
