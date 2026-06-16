/**
 * Глобальный патч локального форматирования времени в Asia/Dushanbe.
 *
 * Зачем: CRM используется FOUNDER'ом и сотрудниками компании Javonon,
 * базирующейся в Душанбе. Бизнес-время — Asia/Dushanbe (UTC+5).
 * По коду много `Date.toLocaleString('ru-RU', { ... })` без явной
 * timeZone — они подхватывают зону браузера и при открытии CRM из
 * Москвы / Стамбула / другой страны время съезжает на часы.
 *
 * Этот патч ставит дефолт `timeZone: 'Asia/Dushanbe'` для всех методов
 * Date#toLocaleString / toLocaleDateString / toLocaleTimeString, если
 * вызов не указал свою зону. Также пропатчивает Intl.DateTimeFormat
 * аналогично — на случай прямого использования.
 *
 * Если где-то нужно ПОКАЗАТЬ зону браузера (например для разработчика
 * в DEBUG-панели), нужно явно передать `timeZone: ...` в options.
 */

const TJ_TZ = 'Asia/Dushanbe';

function patched<T extends 'toLocaleString' | 'toLocaleDateString' | 'toLocaleTimeString'>(method: T) {
  const orig = Date.prototype[method] as (locales?: any, options?: Intl.DateTimeFormatOptions) => string;
  // Sentinel — позволяет понять, что мы уже патчили (HMR в Vite вызовет
  // патч несколько раз). Без проверки — стек оригиналов растёт каждый
  // HMR-цикл (не корректно, но потенциально работает).
  if ((orig as any).__tjPatched) return;
  const next = function (this: Date, locales?: any, options?: Intl.DateTimeFormatOptions) {
    if (options && options.timeZone) {
      return orig.call(this, locales, options);
    }
    return orig.call(this, locales, { ...(options || {}), timeZone: TJ_TZ });
  };
  (next as any).__tjPatched = true;
  Date.prototype[method] = next as any;
}

let patchedOnce = false;
export function installTjLocalePatch(): void {
  if (patchedOnce) return;
  patchedOnce = true;
  patched('toLocaleString');
  patched('toLocaleDateString');
  patched('toLocaleTimeString');

  // Intl.DateTimeFormat constructor — точно так же дефолт TJT, если
  // вызывающий не передал свою timeZone. Использует прокси над
  // оригинальным конструктором.
  const OrigFmt = Intl.DateTimeFormat;
  if ((OrigFmt as any).__tjPatched) return;
  const Wrapped: any = function (this: any, locales?: any, options?: Intl.DateTimeFormatOptions) {
    const opts: Intl.DateTimeFormatOptions =
      options && options.timeZone ? options : { ...(options || {}), timeZone: TJ_TZ };
    // Поддерживаем как `new Intl.DateTimeFormat(...)`, так и
    // `Intl.DateTimeFormat(...)` без `new`.
    if (!(this instanceof Wrapped)) return new OrigFmt(locales, opts);
    return new OrigFmt(locales, opts);
  };
  Wrapped.prototype = OrigFmt.prototype;
  Wrapped.supportedLocalesOf = OrigFmt.supportedLocalesOf.bind(OrigFmt);
  (Wrapped as any).__tjPatched = true;
  // Переопределяем именованный конструктор в namespace Intl —
  // приходится тегать as any, иначе TS считает свойство read-only.
  (Intl as any).DateTimeFormat = Wrapped;
}
