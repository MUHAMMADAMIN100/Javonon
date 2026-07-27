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

import { API_URL } from './api';

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

// Результат захвата мемоизируется на весь page load: capture зовут дважды —
// из main.tsx (до рендера, чтобы роутер не успел съесть ?ref=) и из App
// (после монтирования, чтобы решить, скроллить ли к форме). Второй вызов
// НЕ должен слать второй POST /referrals/click, иначе один переход
// засчитался бы партнёру дважды и статистика кликов врала бы вдвое.
let captureDone = false;
let capturedCode: string | null = null;

/**
 * Вызывается при загрузке приложения. Идемпотентна.
 * @returns захваченный ref-код в верхнем регистре или null, если ?ref= в URL
 *          не было (или он не прошёл валидацию формата).
 */
export function captureReferralFromUrl(): string | null {
  if (captureDone) return capturedCode;
  captureDone = true;

  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref') || params.get('r');
    if (ref && /^[A-Z0-9]{4,16}$/i.test(ref)) {
      const code = ref.toUpperCase();
      capturedCode = code;
      write(code);
      // Логируем клик на backend — для статистики переходов партнёра.
      // Не ждём ответа (fire-and-forget): счётчик кликов не стоит того, чтобы
      // задерживать первый рендер или ронять захват ref при офлайне.
      // API_URL уже содержит префикс /api — путь дописываем от ресурса.
      fetch(`${API_URL}/referrals/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, source: 'SITE' }),
        credentials: 'omit',
      })
        .then((res) => {
          // Ответ не ждём, но и не глотаем молча: раньше URL был собран
          // неверно (/api/api/...), 404 уходил в пустой catch, и статистика
          // кликов вечно показывала 0 без единого следа в консоли.
          if (!res.ok) {
            console.warn(
              `[referral] click ping failed: ${res.status} ${res.statusText}`,
            );
          }
        })
        .catch(() => undefined);
    }
  } catch {}

  return capturedCode;
}

// ---------------------------------------------------------------------------
// Автоскролл к форме заявки (#apply)
// ---------------------------------------------------------------------------

const APPLY_ID = 'apply';
const HIGHLIGHT_CLASS = 'apply-highlight';
/** Синхронизировано с длительностью анимации .apply-highlight в index.css. */
const HIGHLIGHT_MS = 2000;
/** 20 попыток × 100ms ≈ 2s — потолок ожидания монтирования секции. */
const MAX_TRIES = 20;
const RETRY_MS = 100;

/** Как часто пересматриваем абсолютную позицию секции после старта скролла. */
const SETTLE_INTERVAL_MS = 150;
/**
 * Бюджет «досматривания» после первого scrollIntoView. Покрывает самый
 * долгий реалистичный ответ /programs/public на 3G — секция программ
 * (PublicProgramsSection) до него отдаёт null и вообще не занимает высоту.
 */
const SETTLE_BUDGET_MS = 2400;
/** Сдвиг меньше этого — шум субпиксельной раскладки, не реагируем. */
const SETTLE_EPSILON_PX = 4;

let highlightTimer: number | undefined;
/** Остановка активного settle-цикла: второй вызов отменяет предыдущий. */
let stopSettle: (() => void) | undefined;

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Абсолютная (документная) координата верха элемента.
 *
 * Именно она, а не rect.top, — инвариант для нашей задачи: пока идёт плавный
 * скролл, rect.top меняется каждый кадр просто потому, что едет вьюпорт, и
 * сравнивать его с прошлым замером бессмысленно. Абсолютный же offset стоит
 * на месте — и сдвигается ровно тогда, когда контент НАД секцией изменил
 * высоту. Это единственный сигнал, который нам нужен.
 */
function absoluteTop(el: Element): number {
  return el.getBoundingClientRect().top + window.scrollY;
}

function issueScroll(el: HTMLElement) {
  // 'auto' = поведение из CSS scroll-behavior. В index.css под
  // prefers-reduced-motion глобальный smooth снят, так что для таких
  // пользователей прыжок будет мгновенным.
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
  try {
    el.scrollIntoView({ behavior, block: 'start' });
  } catch {
    // Очень старые движки не понимают объектный аргумент.
    el.scrollIntoView();
  }
}

/**
 * Вешает кольцо подсветки на ~2s. Перезапускается при каждом до-скролле:
 * иначе при позднем сдвиге (медленный /programs/public) анимация успевала бы
 * догореть, пока секция ещё едет, и человек приезжал бы к форме без метки.
 */
function markHighlight(el: HTMLElement) {
  // Класс, а не inline-стиль: инлайн перебил бы тему и не дал бы
  // переопределить подсветку под prefers-reduced-motion в CSS.
  // Снять → форсировать reflow → повесить: повторный add на уже висящий
  // класс CSS-анимацию не перезапускает.
  el.classList.remove(HIGHLIGHT_CLASS);
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);

  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    el.classList.remove(HIGHLIGHT_CLASS);
    highlightTimer = undefined;
  }, HIGHLIGHT_MS);
}

/**
 * Удерживает секцию в цели, пока раскладка над ней не устаканится.
 *
 * Зачем: smooth-скролл вычисляет конечный offset один раз, на старте. А над
 * `#apply` живёт PublicProgramsSection, которая до ответа /programs/public
 * рендерит null и занимает 0px, а потом разворачивается на сотни-тысячи
 * пикселей. Анимация, стартовавшая до этого, доезжает по устаревшей цели —
 * и партнёрский посетитель приземляется посреди списка программ, а кольцо
 * подсветки горит за экраном. Поэтому после старта ещё ~2.4s следим за
 * абсолютной позицией секции и до-скролливаем на каждый заметный сдвиг.
 *
 * Любой жест пользователя (колесо, тач, клавиша, зажатие скроллбара) цикл
 * убивает: молча утащить человека обратно, когда он уже сам куда-то поехал, —
 * хуже, чем не доскроллить.
 */
function keepAlignedWhileLayoutSettles(el: HTMLElement, highlight: boolean) {
  // Отменяем предыдущий цикл, если по какой-то причине их два.
  if (stopSettle) stopSettle();

  let lastTop = absoluteTop(el);
  let elapsed = 0;
  let timer: number | undefined;

  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    window.removeEventListener('wheel', onUserGesture);
    window.removeEventListener('touchstart', onUserGesture);
    window.removeEventListener('keydown', onUserGesture);
    window.removeEventListener('pointerdown', onUserGesture);
    if (stopSettle === stop) stopSettle = undefined;
  };

  function onUserGesture() {
    stop();
  }

  window.addEventListener('wheel', onUserGesture, { passive: true });
  window.addEventListener('touchstart', onUserGesture, { passive: true });
  window.addEventListener('keydown', onUserGesture);
  window.addEventListener('pointerdown', onUserGesture, { passive: true });
  stopSettle = stop;

  timer = window.setInterval(() => {
    elapsed += SETTLE_INTERVAL_MS;

    // Секцию размонтировали (смена роута) — гнаться уже не за чем.
    if (!el.isConnected) {
      stop();
      return;
    }

    const top = absoluteTop(el);
    if (Math.abs(top - lastTop) > SETTLE_EPSILON_PX) {
      lastTop = top;
      issueScroll(el);
      if (highlight) markHighlight(el);
    }

    // Ранний выход по «двум стабильным замерам» здесь был бы ловушкой:
    // 300ms — это как раз окно, в которое ответ /programs/public ещё не
    // пришёл, то есть мы бы выключались ровно перед сдвигом. Досматриваем
    // весь бюджет; стоит это один getBoundingClientRect раз в 150ms.
    if (elapsed >= SETTLE_BUDGET_MS) stop();
  }, SETTLE_INTERVAL_MS);
}

/**
 * Скроллит к секции с формой заявки (`#apply`).
 *
 * Почему не просто getElementById + scrollIntoView: функция вызывается из
 * эффекта App, а сама секция — глубоко внизу дерева и на первом кадре может
 * быть ещё не смонтирована (Suspense/условный рендер/медленный первый paint).
 * Поэтому поллим до ~2s парами rAF + таймер: rAF гарантирует, что мы смотрим
 * на DOM после кадра, а не в середине коммита. Не нашли за 2s — молча
 * сдаёмся: автоскролл это nice-to-have, ронять из-за него ничего нельзя.
 *
 * И симметрично: найти элемент — половина дела. Асинхронные секции ВЫШЕ него
 * доезжают позже и сдвигают цель уже после старта анимации, поэтому дальше
 * работает keepAlignedWhileLayoutSettles (см. комментарий там).
 *
 * @param opts.highlight — на ~2s повесить класс подсветки (мягкое кольцо),
 *        чтобы человек понял, куда именно его увезло.
 */
export function scrollToApplyForm(opts?: { highlight?: boolean }) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const highlight = opts?.highlight === true;
  let tries = 0;

  const attempt = () => {
    tries += 1;
    const el = document.getElementById(APPLY_ID);

    if (!el) {
      if (tries >= MAX_TRIES) return; // тихо сдаёмся
      window.setTimeout(() => window.requestAnimationFrame(attempt), RETRY_MS);
      return;
    }

    issueScroll(el);
    if (highlight) markHighlight(el);

    keepAlignedWhileLayoutSettles(el, highlight);
  };

  window.requestAnimationFrame(attempt);
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
