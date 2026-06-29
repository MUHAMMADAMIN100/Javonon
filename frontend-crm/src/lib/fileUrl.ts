/**
 * Сборка абсолютного URL для файлов из /uploads/* которые лежат на бэкенде
 * (Railway), а не на фронте (Vercel).
 *
 * Audit fix #11: /uploads/* теперь защищён JWT-middleware на бэке —
 * UploadsAuthMiddleware принимает токен из Authorization header ИЛИ из
 * query-параметра ?token=. <a href> и <img src> кастомные заголовки слать
 * не умеют, поэтому мы подставляем токен в URL прямо здесь.
 *
 * Risk note: токен попадает в Referer header и server-access logs.
 * Это осознанная плата за обратную совместимость со старыми uploads.
 * Для нового кода предпочтительнее: POST /files/sign → одноразовый
 * URL с short-lived signed payload, но это другой PR.
 */
export function absFileUrl(u: string | null | undefined): string {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  const apiBase = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');
  const base = `${apiBase}${u}`;
  // Защищённые uploads → дописываем токен в query.
  if (u.startsWith('/uploads/')) {
    const token = (() => {
      try { return localStorage.getItem('javonon_token') || ''; } catch { return ''; }
    })();
    if (token) {
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}token=${encodeURIComponent(token)}`;
    }
  }
  return base;
}
