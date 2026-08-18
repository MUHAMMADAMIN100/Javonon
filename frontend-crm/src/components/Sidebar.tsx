import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useAuth } from '../store/auth';
import Icon from '../Icon';
import ChangePasswordModal from './ChangePasswordModal';
import { queryClient } from '../lib/queryClient';
import { keys } from '../lib/queryKeys';
import { listChatRooms, chatUnread } from '../api/chat';
import { listApplications } from '../api/applications';
import { listStudents, studentStats } from '../api/students';
import { listPrograms } from '../api/programs';
import { listTasks } from '../api/tasks';
import { listUsers } from '../api/users';
import { listCourses } from '../api/lms';
import { financeSummary, listTransactions } from '../api/finance';
import { listSalaries } from '../api/salary';
import { displayRoleLabel } from '../lib/roles';
import { resolveLandingBaseUrl } from '../lib/landingUrl';
import { LangSwitcher, useT } from '../lib/i18n';
import {
  buildNavCtx,
  visibleGroups,
  resolveRoute,
  PROFILE_ITEM,
  type VisibleGroup,
} from './navGroups';

// Map route → prefetch fn. Срабатывает по hover/touchstart на nav-link
// и грузит данные ДО клика — экран открывается мгновенно с готовым кешем.
const PREFETCH_MAP: Record<string, () => Promise<void> | void> = {
  '/chat': () => {
    queryClient.prefetchQuery({ queryKey: keys.chat.rooms(), queryFn: () => listChatRooms() });
    queryClient.prefetchQuery({ queryKey: keys.chat.unread(), queryFn: () => chatUnread() });
  },
  '/applications': () => {
    queryClient.prefetchQuery({ queryKey: keys.applications.list({}), queryFn: () => listApplications() });
  },
  '/students': () => {
    queryClient.prefetchQuery({ queryKey: keys.students.list({}), queryFn: () => listStudents() });
    queryClient.prefetchQuery({ queryKey: keys.students.stats(), queryFn: () => studentStats() });
  },
  '/programs': () => {
    queryClient.prefetchQuery({ queryKey: keys.programs.list(), queryFn: () => listPrograms() });
  },
  '/tasks': () => {
    queryClient.prefetchQuery({ queryKey: keys.tasks.list({}), queryFn: () => listTasks() });
  },
  '/users': () => {
    queryClient.prefetchQuery({ queryKey: keys.users.list(), queryFn: () => listUsers() });
  },
  '/lms': () => {
    queryClient.prefetchQuery({ queryKey: keys.lms.courses(), queryFn: () => listCourses() });
  },
  '/finance': () => {
    queryClient.prefetchQuery({ queryKey: keys.finance.summary({}), queryFn: () => financeSummary() });
    queryClient.prefetchQuery({ queryKey: keys.finance.transactions({}), queryFn: () => listTransactions() });
  },
  '/salary': () => {
    queryClient.prefetchQuery({ queryKey: keys.salary.list({}), queryFn: () => listSalaries() });
  },
};

// Дедупликация: если этот роут уже префетчили в текущем mount-цикле,
// игнорируем. Защита от spam-hover (mouseenter/mouseleave/mouseenter
// быстро подряд на одном линке создавал десятки запросов до React Query
// дедупа).
const prefetchedRoutes = new Set<string>();
const prefetchRoute = (route: string) => {
  if (prefetchedRoutes.has(route)) return;
  const fn = PREFETCH_MAP[route];
  if (!fn) return;
  prefetchedRoutes.add(route);
  try { fn(); } catch { /* silent */ }
  // Через 60 секунд разрешаем повторный prefetch (на случай если данные
  // могли устареть в кеше).
  setTimeout(() => { prefetchedRoutes.delete(route); }, 60_000);
};

/** Хендлеры префетча — один и тот же набор для пунктов и для иконок групп. */
const prefetchProps = (route: string) => ({
  onMouseEnter: () => prefetchRoute(route),
  onTouchStart: () => prefetchRoute(route),
  onFocus: () => prefetchRoute(route),
});

/**
 * Префетч ВСЕЙ группы, а не только её «домашнего» пункта.
 *
 * В двухуровневом меню в DOM лежат пункты только одной группы, поэтому
 * hover по самим ссылкам покрывал бы 3–5 роутов из 22. Наведение на
 * иконку rail'а — единственный момент, когда мы точно знаем, что
 * пользователь смотрит в сторону этой группы: греем все её роуты сразу.
 * Дёшево: prefetchRoute дедуплицирует и молча выходит для роутов, которых
 * нет в PREFETCH_MAP.
 */
const prefetchGroup = (g: VisibleGroup) => {
  g.items.forEach((i) => prefetchRoute(i.to));
};

/**
 * ЕДИНСТВЕННЫЙ источник правды для брейкпоинта drawer/rail.
 *
 * В index.css ему соответствуют ДВА взаимодополняющих блока:
 *   @media (max-width: 900px)          — drawer-правила (isMobile === true)
 *   @media not all and (max-width: 900px) — rail + hover-панель оверлеем
 *
 * Второй блок обязан оставаться именно инверсией, а не "(min-width: 901px)":
 * при дробной ширине вьюпорта (зум браузера, дробный DPI) значение попадает
 * строго между 900 и 901, и при "901px" не матчился бы ни один блок —
 * панель вернулась бы в поток и двигала контент на каждый hover.
 */
const MOBILE_MQ = '(max-width: 900px)';

/**
 * Тип указателя берём ИЗ СОБЫТИЯ, а не из медиа-запроса.
 *
 * Здесь жил HOVER_MQ = '(hover: hover) and (pointer: fine)', которым
 * гасились hover-обработчики на тач-устройствах. Медиа-запрос описывает
 * только ОСНОВНОЙ указатель устройства, поэтому ноутбук с тачскрином и
 * трекпадом (и iPad с Magic Keyboard) отвечал «hover есть» даже в тот
 * момент, когда пользователь тыкал пальцем в экран. А один тап там
 * разворачивается в pointerenter(touch) → touchstart → mouseover →
 * mouseenter → click, то есть ОДИН палец запускал и hover-обработчик, и
 * клик: повторный тап снимал пин, но тем же движением возвращал hover —
 * панель не закрывалась, точка «.pinned» при этом гасла, и картинка
 * противоречила сама себе. mouseleave палец не шлёт никогда, так что
 * отложенное закрытие тоже не срабатывало.
 *
 * Отсюда правило: «мышь ли это» — свойство КОНКРЕТНОГО взаимодействия
 * (PointerEvent.pointerType), а не устройства.
 */

/** Задержка закрытия панели. Курсор идёт из rail'а в панель по диагонали и
 *  на пару кадров оказывается вне hover-региона — без паузы панель мигала бы. */
const PANEL_CLOSE_DELAY_MS = 200;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ mobileOpen = false, onClose }: SidebarProps = {}) {
  const user = useAuth((s) => s.user);
  const hydrated = useAuth((s) => s.hydrated);
  const logout = useAuth((s) => s.logout);
  const { t } = useT();
  const loc = useLocation();
  const isMobile = useMediaQuery(MOBILE_MQ);
  const reduceMotion = useReducedMotion();
  const [pwdOpen, setPwdOpen] = useState(false);
  const initials = user?.fullName?.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

  // Двухшаговый drawer: 'groups' — 6 крупных кнопок, 'items' — пункты
  // выбранной группы. Держим здесь, а не в Layout, чтобы не менять
  // контракт mobileOpen/onClose.
  const [drawerGroup, setDrawerGroup] = useState<string | null>(null);

  // ===== Десктоп: hover-панель =====
  //
  // Два независимых источника «какая группа раскрыта»:
  //   hoverGroupKey  — временный: наведение/фокус, снимается уходом курсора;
  //   pinnedGroupKey — липкий: клик по иконке, живёт до клика по другой
  //                    иконке (или повторного по той же) и переживает
  //                    навигацию.
  // Видимая группа = hover ?? pinned: ЖИВОЕ НАВЕДЕНИЕ СИЛЬНЕЕ ПИНА. Обратный
  // приоритет превращал закреплённый rail в мёртвый: при пине на «Продажах»
  // наведение на «Финансы» не меняло ни заголовок панели, ни её пункты, и
  // сама иконка не получала даже класса .preview — нулевая обратная связь.
  // Пин при этом не теряется: он остаётся фолбэком, к которому панель
  // возвращается по уходу курсора, а какая группа закреплена — видно по
  // точке .rail-btn.pinned, которая по-прежнему висит на pinnedGroupKey.
  // Панель — ОВЕРЛЕЙ (position: absolute поверх контента), в потоке всегда
  // только 64px rail'а: канбан и широкие таблицы не должны перекладываться
  // на каждое движение мыши.
  const [hoverGroupKey, setHoverGroupKey] = useState<string | null>(null);
  const [pinnedGroupKey, setPinnedGroupKey] = useState<string | null>(null);

  // ===== Roving tabindex по rail'у (паттерн WAI-ARIA toolbar) =====
  //
  // Шесть иконок rail'а — ОДНА остановка Tab, а не шесть. Пока табируемы были
  // все, Tab с иконки уводил на СОСЕДНЮЮ иконку, её onFocus подменял
  // содержимое панели — и так до конца rail'а. До пунктов выбранной группы
  // клавиатурой было не добраться в принципе: пройдя весь rail, пользователь
  // падал в пункты ПОСЛЕДНЕЙ иконки, какую бы группу он ни открыл (панель
  // лежит в DOM после всего <nav class="sidebar-rail">, а не после кнопки).
  //
  // Теперь Tab с иконки ведёт прямо в её панель — следующий tabbable в DOM, —
  // а между иконками ходят ↑/↓ (плюс Home/End), см. onRailKeyDown.
  // null ⇒ rail с клавиатуры ещё не трогали: табируемой считается активная по
  // роуту группа (см. railTabKey).
  const [railFocusKey, setRailFocusKey] = useState<string | null>(null);

  // Отложенное закрытие. Ref, а не state: перезапуск таймера не должен
  // ре-рендерить сайдбар.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  // Таймер, доживший до unmount'а, дёрнул бы setState на размонтированном
  // дереве — предупреждение React и утечка. Чистим всегда.
  useEffect(() => cancelClose, [cancelClose]);

  // Кнопки rail'а по ключу группы — Escape возвращает фокус на иконку,
  // с которой панель была открыта (иначе фокус улетал бы в body).
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Весь hover-регион (rail + панель-оверлей). Нужен обработчику Escape,
  // чтобы отличить клавиатурный сценарий (фокус ВНУТРИ сайдбара — фокус
  // возвращаем на иконку) от hover-сценария (фокус в контенте страницы —
  // трогать его нельзя).
  const regionRef = useRef<HTMLDivElement | null>(null);

  // <nav> раскрытой панели. Нужен, чтобы фокус мог ВОЙТИ в панель по
  // Enter/Space/ArrowRight, а не только Tab'ом: раскрыть группу и попасть в
  // её пункты — одно действие, а не два, и работает оно одинаково с любой
  // из трёх клавиш, которыми disclosure открывают.
  const panelNavRef = useRef<HTMLElement | null>(null);

  /** Фокус на первый пункт раскрытой панели.
   *
   *  requestAnimationFrame: панель (или её новое содержимое) монтируется тем
   *  же коммитом React, который планируют setHoverGroupKey/togglePin, — на
   *  момент обработчика узла в DOM ещё нет. preventScroll: первый пункт
   *  всегда наверху свежесмонтированного nav'а, скроллить нечего, а панель
   *  в этот момент ещё едет по x и могла бы спровоцировать сдвиг. */
  const focusPanelFirstItem = useCallback(() => {
    requestAnimationFrame(() => {
      panelNavRef.current
        ?.querySelector<HTMLAnchorElement>('a')
        ?.focus({ preventScroll: true });
    });
  }, []);

  // Escape возвращает фокус на иконку rail'а — а .focus() СИНХРОННО
  // диспатчит focus-событие этой кнопки, то есть внутри того же обработчика
  // отрабатывает onFocus → focusGroupOn → setHoverGroupKey(g.key). React 18
  // батчит оба setState, побеждает последний, и панель, которую Escape
  // только что закрыл, открывается заново в том же тике.
  //
  // Иллюзия рабочего Escape возникала только когда фокус УЖЕ стоял на самой
  // иконке: focus() на активном элементе события не даёт, поэтому «наивный»
  // клавиатурный сценарий проходил, а реальные (фокус на ссылке внутри
  // панели; фокус на одной иконке при курсоре над другой) — нет.
  //
  // Флаг живёт ровно на время программного вызова focus(): ставим перед,
  // снимаем сразу после (обработчик focus'а успевает отработать внутри).
  const suppressFocusOpen = useRef(false);

  // Тип указателя последнего pointerdown по иконке rail'а.
  //
  // У click'а pointerType читать нельзя: в WebKit click приходит обычным
  // MouseEvent, где такого поля нет вовсе, и настоящая мышь определилась бы
  // как палец. pointerdown же — всегда PointerEvent и всегда предшествует
  // click'у (при тапе он приходит ещё до эмулированных mouse-событий).
  const lastPointerType = useRef<string>('mouse');

  // Группы — только разрешённые, уже отфильтрованные по правам.
  const groups = useMemo(
    () => (hydrated ? visibleGroups(buildNavCtx(user)) : []),
    [hydrated, user],
  );

  // Активная группа выводится ИЗ ТЕКУЩЕГО РОУТА — прямая ссылка или
  // deep-link (/submissions/<id>) подсвечивает нужную иконку и открывает
  // нужную панель. Для /me группы нет — панель показывает первую доступную,
  // ни одна иконка не активна.
  const hit = resolveRoute(loc.pathname);
  const activeGroupKey = hit && groups.some((g) => g.key === hit.groupKey) ? hit.groupKey : null;

  // hoverGroupKey/pinnedGroupKey — это СТРОКИ-ключи, а не ссылки на группы,
  // и набор групп пересобирается на каждое обновление `user`: ответ
  // /auth/me, смена custom-роли, вход под другим пользователем. visibleGroups
  // выкидывает группу, у которой не осталось разрешённых пунктов, поэтому
  // закреплённая группа может из набора ИСЧЕЗНУТЬ.
  //
  // Стухший ключ нельзя пускать в `??` напрямую: он не null, значит второй
  // операнд не консультируется вообще, а find по мёртвому ключу даёт
  // undefined — панель просто переставала открываться. Сверяем ОБА ключа с
  // текущим набором прямо в рендере: это срабатывает в том же кадре, до
  // эффектов. Порядок операндов роли не играет — дырявым может оказаться
  // любой из двух.
  const isKnownGroup = (key: string | null) => !!key && groups.some((g) => g.key === key);
  const pinnedValid = isKnownGroup(pinnedGroupKey) ? pinnedGroupKey : null;
  const hoverValid = isKnownGroup(hoverGroupKey) ? hoverGroupKey : null;

  // Раскрытая группа. null ⇒ панели в DOM нет, виден только rail —
  // прежнего фолбэка «|| groups[0]» здесь быть не должно, иначе панель
  // никогда не схлопнется.
  const visibleGroupKey = hoverValid ?? pinnedValid;

  // Единственная иконка rail'а с tabIndex=0. Порядок фолбэков: последняя
  // сфокусированная → активная по роуту → первая доступная. Сверка с groups
  // обязательна по той же причине, что и pinnedValid/hoverValid: группа могла
  // исчезнуть из меню после смены прав, и rail остался бы вообще без
  // остановки Tab — сайдбар выпал бы из клавиатурного обхода целиком.
  const railTabKey =
    (isKnownGroup(railFocusKey) ? railFocusKey : null)
    ?? activeGroupKey
    ?? groups[0]?.key
    ?? null;
  const panelGroup: VisibleGroup | undefined = visibleGroupKey
    ? groups.find((g) => g.key === visibleGroupKey)
    : undefined;

  // WCAG 2.1 SC 1.4.13 (Dismissible): дополнительный контент, раскрытый
  // НАВЕДЕНИЕМ, обязан закрываться без движения указателя и без переноса
  // фокуса. Панель — оверлей шириной 208px поверх страницы (z-index: 80),
  // так что «просто подождать» не вариант: она реально перекрывает контент.
  //
  // Слушатель на самом регионе (onKeyDown у .sidebar-split) этот сценарий
  // не покрывает в принципе: keydown стартует от document.activeElement и
  // всплывает вверх по ЕГО цепочке предков. Открытие по hover фокус никуда
  // не переносит — активным остаётся элемент страницы, сайдбар в цепочке
  // отсутствует, и до обработчика Escape не доходил вообще. «Работало» это
  // только в одном случае — когда фокус уже стоял на иконке rail'а.
  //
  // Поэтому слушаем document, и ровно пока панель раскрыта (иначе лишний
  // глобальный слушатель висел бы всё время жизни сайдбара).
  useEffect(() => {
    if (!visibleGroupKey) return;
    const onKey = (e: KeyboardEvent) => {
      // defaultPrevented — событие уже разобрал вышележащий оверлей
      // (датапикер, диалог): второй смысл одному Escape не навешиваем.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      cancelClose();
      setHoverGroupKey(null);
      setPinnedGroupKey(null);

      // Фокус возвращаем на иконку ТОЛЬКО если он и был внутри сайдбара,
      // т.е. панель открыли с клавиатуры (Tab → onFocus). При открытии
      // наведением фокус стоит в контенте — вырвать его из поля ввода или
      // таблицы значило бы нарушить то же 1.4.13 («without moving pointer
      // hover or keyboard focus») и потерять место, где человек печатал.
      const region = regionRef.current;
      const active = document.activeElement;
      if (!region || !(active instanceof Node) || !region.contains(active)) return;
      // preventScroll: фокус не должен подскроллить rail/страницу — панель
      // оверлейная, контент под ней не имеет права сдвинуться.
      // suppressFocusOpen: .focus() СИНХРОННО диспатчит focus, т.е. внутри
      // этого же обработчика отработал бы focusGroupOn и открыл панель
      // заново в том же тике.
      // Escape вернул фокус на эту иконку — она же становится остановкой
      // Tab, иначе сфокусированная кнопка осталась бы с tabIndex=-1 и
      // следующий Tab прыгнул бы обратно вверх по rail'у.
      setRailFocusKey(visibleGroupKey);
      suppressFocusOpen.current = true;
      try {
        railRefs.current[visibleGroupKey]?.focus({ preventScroll: true });
      } finally {
        suppressFocusOpen.current = false;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visibleGroupKey, cancelClose]);

  // Переключение на мобильный брейкпоинт размонтирует rail вместе с
  // панелью — состояние hover/pin осталось бы висеть и при возврате на
  // десктоп панель открылась бы сама.
  useEffect(() => {
    if (!isMobile) return;
    cancelClose();
    setHoverGroupKey(null);
    setPinnedGroupKey(null);
  }, [isMobile, cancelClose]);

  // Тот же случай, но для смены НАБОРА ГРУПП (обновление прав), а не
  // брейкпоинта: рендер уже защищён pinnedValid/hoverValid, здесь чистим сам
  // state, чтобы мёртвый ключ не жил в нём бесконечно. Без этого повторный
  // клик по вернувшейся группе попал бы в ветку `prev === g.key` в togglePin
  // и «распинил» бы её вместо закрепления.
  //
  // groups.length === 0 пропускаем намеренно: пустой набор бывает только
  // пока hydrated=false (например, на разлогине), и это не повод стирать пин.
  useEffect(() => {
    if (groups.length === 0) return;
    const alive = (prev: string | null) =>
      prev && !groups.some((g) => g.key === prev) ? null : prev;
    setPinnedGroupKey(alive);
    setHoverGroupKey(alive);
  }, [groups]);

  // После навигации табируемой становится иконка ТЕКУЩЕГО раздела: вернувшись
  // в сайдбар Tab'ом, пользователь попадает туда, где находится сейчас, а не
  // туда, где в прошлый раз остановились стрелки.
  useEffect(() => {
    setRailFocusKey(activeGroupKey);
  }, [activeGroupKey]);

  // Открытие drawer'а: если текущий роут принадлежит группе — сразу шаг 2
  // (пользователь скорее всего ходит внутри своего раздела), иначе шаг 1.
  useEffect(() => {
    if (mobileOpen) setDrawerGroup(activeGroupKey);
    // activeGroupKey намеренно вне зависимостей: шаг выбирается один раз
    // на открытие, иначе переход по ссылке дёргал бы drawer обратно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileOpen]);

  const drawerGroupObj = groups.find((g) => g.key === drawerGroup);

  // Bootstrap didn't finish /auth/me (Railway cold-start 5xx / timeout).
  // `user` may hold only a minimal JWT-claims stub — fullName='', no
  // permissions, no customRole, role defaulting to SALES_MANAGER. Computing
  // the menu off that stub silently downgrades a FOUNDER into the
  // SALES_MANAGER menu (loses /settings, /users, /finance, etc.) and
  // renders a custom-role user against the wrong base role. Show a
  // skeleton until the full user lands or logout is chosen — see
  // AuthState.hydrated doc in store/auth.ts.
  if (!hydrated) {
    return (
      <motion.aside
        className={`sidebar sidebar-2l${mobileOpen ? ' mobile-open' : ''}`}
        initial={{ x: -80, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="sidebar-logo">
          <img src="/javonon-logo.svg" alt="Javonon" className="sidebar-brand-img" />
        </div>
        {/* Панели-скелетона нет намеренно: в собранном состоянии сайдбар —
            это только rail, и скелет обязан иметь ту же ширину, иначе на
            переходе «загрузка → меню» сайдбар схлопнулся бы с 248 до 64px
            и весь контент страницы прыгнул бы. */}
        <div className="sidebar-split" aria-busy="true" aria-label={t('common.loading')}>
          <div className="sidebar-rail">
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div
                key={i}
                className="rail-skeleton"
                animate={{ opacity: [0.35, 0.75, 0.35] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }}
              />
            ))}
          </div>
        </div>
        <div className="sidebar-user rail-user">
          <div className="user-avatar" style={{ background: 'rgba(255,255,255,0.08)' }} />
          <div className="user-info">
            <motion.div
              animate={{ opacity: [0.35, 0.75, 0.35] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              style={{ height: 12, width: '70%', borderRadius: 4, background: 'rgba(255,255,255,0.1)' }}
            />
            <motion.div
              animate={{ opacity: [0.35, 0.75, 0.35] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
              style={{ marginTop: 6, height: 10, width: '45%', borderRadius: 4, background: 'rgba(255,255,255,0.08)' }}
            />
          </div>
          {/* Logout is still reachable so a user stuck behind a long backend
              outage can bail out — no menu-shape decisions needed for it. */}
          <button
            className="logout-btn"
            onClick={logout}
            title={t('auth.logout')}
          >
            <Icon name="logout" size={20} />
          </button>
        </div>
      </motion.aside>
    );
  }

  /** Наведение на иконку группы: мгновенно раскрываем панель (задержки на
   *  открытие нет) и греем кеш всей группы. Никакой навигации.
   *
   *  Только настоящая мышь/трекпад: pointerenter от пальца или стилуса —
   *  это первая фаза ТАПА, а не наведение; оставлять после него hover
   *  нельзя, снять его будет нечем. */
  const hoverGroupOn = (e: React.PointerEvent, g: VisibleGroup) => {
    if (isMobile || e.pointerType !== 'mouse') return; // палец/стилус — только клик
    cancelClose();
    setHoverGroupKey(g.key);
    prefetchGroup(g);
  };

  /** Фокус с клавиатуры раскрывает панель независимо от типа указателя:
   *  на тач-планшете с внешней клавиатурой Tab обязан работать. */
  const focusGroupOn = (g: VisibleGroup) => {
    // Программный возврат фокуса по Escape — не пользовательский Tab:
    // раскрывать панель обратно нельзя. Префетч тоже не нужен — группа
    // уже была открыта, её роуты прогреты.
    if (suppressFocusOpen.current) return;
    cancelClose();
    setHoverGroupKey(g.key);
    // Остановка Tab едет за фокусом — иначе Shift+Tab из панели вернулся бы
    // не на ту иконку, с которой пользователь в панель зашёл.
    setRailFocusKey(g.key);
    prefetchGroup(g);
  };

  /** Перенос фокуса на иконку rail'а по индексу, по кругу. Панель раскроется
   *  сама: focus на кнопке дёргает focusGroupOn. preventScroll — по той же
   *  причине, что и в Escape: панель оверлейная, контент под ней не имеет
   *  права сдвинуться. */
  const focusRailAt = (idx: number) => {
    if (groups.length === 0) return;
    const g = groups[(idx + groups.length) % groups.length];
    setRailFocusKey(g.key);
    railRefs.current[g.key]?.focus({ preventScroll: true });
  };

  /** ↑/↓/Home/End ходят между иконками — штатная замена Tab'у при roving
   *  tabindex; → входит в раскрытую панель. Остальные клавиши (в том числе
   *  Escape, который слушает document) не трогаем вообще. */
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, g: VisibleGroup, idx: number) => {
    let next: number;
    switch (e.key) {
      // → — «войти в раскрытый узел», как в дереве. Панель почти всегда уже
      // раскрыта фокусом на этой иконке, но после Escape фокус остаётся на
      // ней при закрытой панели — тогда сначала раскрываем. hover, а не пин:
      // пин остаётся жестом мыши, а hover сильнее его и покажет ровно ту
      // группу, на которой стоит фокус.
      case 'ArrowRight':
        e.preventDefault();
        cancelClose();
        setHoverGroupKey(g.key);
        focusPanelFirstItem();
        return;
      case 'ArrowDown': next = idx + 1; break;
      case 'ArrowUp': next = idx - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = groups.length - 1; break;
      default: return;
    }
    // Без preventDefault ↑/↓ дополнительно проскроллят страницу под сайдбаром.
    e.preventDefault();
    focusRailAt(next);
  };

  /** Курсор ушёл со ВСЕГО региона (rail + панель — панель является DOM-
   *  потомком .sidebar-split, поэтому переезд «rail → панель» mouseleave
   *  не даёт). Закрываем с паузой. Снимается ТОЛЬКО hover: если группа
   *  закреплена, панель не закрывается, а возвращается к закреплённой —
   *  превью другой группы живёт ровно столько, сколько курсор на ней. */
  const scheduleClose = () => {
    // Проверки на «устройство без hover» тут нет намеренно: hover теперь
    // выставляет только мышь (или Tab), поэтому чистить его по mouseleave
    // безопасно на любом устройстве. С прежним !canHover настоящая мышь на
    // устройстве с тач-основным указателем открыла бы панель и уже не
    // закрыла бы её.
    if (isMobile) return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setHoverGroupKey(null);
    }, PANEL_CLOSE_DELAY_MS);
  };

  /** Клик по иконке группы = ПИН/РАСПИН этой группы.
   *
   *  Навигации здесь больше нет: раньше клик уводил на groupHome(g), но с
   *  hover-панелью это конфликтует — мышью иконка всегда уже «наведена»,
   *  так что каждый клик означал бы переход, и закрепить панель было бы
   *  нечем. «Домашний» пункт группы никуда не делся: это первый пункт
   *  раскрытой панели, до него один клик.
   *
   *  Тач на широком экране (планшет > 900px): тап пинит, повторный тап
   *  закрывает — тот же двухшаговый сценарий, что и раньше. */
  const togglePin = (g: VisibleGroup, keepHover: boolean) => {
    cancelClose();
    prefetchGroup(g);
    setPinnedGroupKey((prev) => (prev === g.key ? null : g.key));
    // Распин мышью: курсор всё ещё над иконкой, панель обязана остаться
    // раскрытой и закрыться уже по уходу курсора. То же и для клавиатуры —
    // фокус с кнопки никуда не делся. После тапа пальцем «наведения» не
    // существует: там распин обязан закрыть панель сразу, иначе закрывающий
    // тап не делает ничего видимого.
    setHoverGroupKey(keepHover && !isMobile ? g.key : null);
  };

  /** Клавиатура внутри раскрытой панели.
   *
   *  ← возвращает на иконку группы, НЕ закрывая панель (закрывает Escape —
   *  он на document). ↑/↓/Home/End ходят по пунктам: rail и панель ведут
   *  себя одинаково, а обещание aria-haspopup на иконке подкреплено поведением.
   *  Tab при этом работает штатно — пункты остаются обычными ссылками. */
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLElement>, groupKey: string) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRailFocusKey(groupKey);
      railRefs.current[groupKey]?.focus({ preventScroll: true });
      return;
    }
    let next: number;
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a'));
    const cur = links.indexOf(document.activeElement as HTMLAnchorElement);
    switch (e.key) {
      case 'ArrowDown': next = cur + 1; break;
      case 'ArrowUp': next = cur - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = links.length - 1; break;
      default: return;
    }
    if (links.length === 0) return;
    e.preventDefault();
    // Здесь focus() БЕЗ preventScroll: длинный список пунктов группы
    // скроллится внутри самого nav'а, и пункт, до которого
    // дошли стрелкой, обязан оказаться в поле зрения. Страницу это не
    // двигает — скролл-контейнер здесь сам nav.
    links[(next + links.length) % links.length].focus();
  };

  /** Останется ли указатель «над» иконкой после этого клика.
   *  Мышь/трекпад — да, курсор физически стоит на кнопке. Клавиатура — да:
   *  Enter/Space дают click с detail === 0, фокус остаётся на кнопке.
   *  Палец — нет. */
  const clickKeepsHover = (e: React.MouseEvent) =>
    e.detail === 0 || lastPointerType.current === 'mouse';

  // Обработчика Escape на самом регионе больше нет — он переехал на
  // document (см. эффект выше). Держать оба нельзя: здешний
  // e.stopPropagation() гасил всплытие нативного события на корневом
  // контейнере React, и до слушателя на document оно уже не доходило —
  // клавиатурный сценарий работал бы, а hover-сценарий (основной) нет.

  /**
   * `animated` включает поштучное проявление пунктов (десктопная панель).
   * В мобильном ящике оно не нужно: там панель не выезжает, а список
   * появляется целиком, и задержка на каждом пункте читалась бы как тормоз.
   *
   * Обёртка motion.div безопасна для вёрстки: правила в CSS написаны как
   * `.sidebar-panel-nav a` (потомок, не прямой ребёнок), а flex-gap теперь
   * раскладывает обёртки вместо ссылок — визуально то же самое.
   */
  const itemVariants = {
    hidden: { opacity: 0, x: -10 },
    show: { opacity: 1, x: 0 },
  };

  const renderItems = (g: VisibleGroup, animated = false) => (
    <>
      {g.items.map((it) => {
        const link = (
          <NavLink
            to={it.to}
            onClick={() => onClose?.()}
            {...prefetchProps(it.to)}
          >
            <span className="sidebar-nav-icon">
              <Icon name={it.icon} size={20} />
            </span>
            <span>{t(it.labelKey)}</span>
          </NavLink>
        );
        if (!animated || reduceMotion) {
          return <Fragment key={it.to}>{link}</Fragment>;
        }
        return (
          <motion.div
            key={it.to}
            variants={itemVariants}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {link}
          </motion.div>
        );
      })}
    </>
  );

  // ===== Нижний блок (drawer, <= 900px): /me + База знаний + юзер, язык,
  //       пароль, выход — в полную ширину, с подписями =====
  const footMobile = (
    <div className="sidebar-foot">
      <div className="sidebar-quick">
        <NavLink to={PROFILE_ITEM.to} onClick={() => onClose?.()} {...prefetchProps(PROFILE_ITEM.to)}>
          <span className="sidebar-nav-icon">
            <Icon name={PROFILE_ITEM.icon} size={19} />
          </span>
          <span>{t(PROFILE_ITEM.labelKey)}</span>
        </NavLink>
        {/* База знаний — внешняя ссылка на лендинг (ТЗ §3.1
            "сайт используется ... сотрудниками как база знаний").
            QA-fix #8: базу берём из lib/landingUrl, не из inline-env. */}
        <a href={`${resolveLandingBaseUrl()}/knowledge`} target="_blank" rel="noreferrer">
          <span className="sidebar-nav-icon">
            <Icon name="library_books" size={19} />
          </span>
          <span>{t('sidebar.knowledge')}</span>
          <Icon name="open_in_new" size={13} style={{ marginLeft: 'auto', opacity: 0.45 }} />
        </a>
      </div>
      <motion.div
        className="sidebar-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
      >
        <motion.div
          className="user-avatar"
          whileHover={{ scale: 1.1 }}
          transition={{ type: 'spring', stiffness: 300 }}
        >
          {initials}
        </motion.div>
        <div className="user-info">
          <div className="user-name">{user?.fullName}</div>
          <div className="user-role">{displayRoleLabel(user as any)}</div>
          <div style={{ marginTop: 6 }}>
            <LangSwitcher />
          </div>
        </div>
        <motion.button
          className="logout-btn"
          onClick={() => setPwdOpen(true)}
          title={t('auth.changePassword')}
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="lock_reset" size={20} />
        </motion.button>
        <motion.button
          className="logout-btn"
          onClick={logout}
          title={t('auth.logout')}
          whileHover={{ scale: 1.15, rotate: 15 }}
          whileTap={{ scale: 0.9 }}
        >
          <Icon name="logout" size={20} />
        </motion.button>
      </motion.div>
    </div>
  );

  // ===== Нижний блок (десктоп): тот же набор, но в 64px rail'а —
  //       иконки без подписей, подписи ушли в title/aria-label.
  //       Живёт именно в RAIL'е, а не в панели: панель схлопывается, а
  //       профиль / RU-TJ / смена пароля / выход обязаны оставаться под
  //       рукой всегда. Префетч /me сохранён. =====
  const footRail = (
    <div className="sidebar-foot rail-foot">
      <div className="sidebar-quick">
        <NavLink
          to={PROFILE_ITEM.to}
          title={t(PROFILE_ITEM.labelKey)}
          aria-label={t(PROFILE_ITEM.labelKey)}
          {...prefetchProps(PROFILE_ITEM.to)}
        >
          <span className="sidebar-nav-icon">
            <Icon name={PROFILE_ITEM.icon} size={20} />
          </span>
        </NavLink>
        {/* База знаний — внешняя ссылка на лендинг (ТЗ §3.1). */}
        <a
          href={`${resolveLandingBaseUrl()}/knowledge`}
          target="_blank"
          rel="noreferrer"
          title={t('sidebar.knowledge')}
          aria-label={t('sidebar.knowledge')}
        >
          <span className="sidebar-nav-icon">
            <Icon name="library_books" size={20} />
          </span>
        </a>
      </div>
      <div className="rail-lang">
        <LangSwitcher />
      </div>
      <div className="sidebar-user rail-user">
        <motion.div
          className="user-avatar"
          title={`${user?.fullName ?? ''} · ${displayRoleLabel(user as any)}`}
          whileHover={{ scale: 1.1 }}
          transition={{ type: 'spring', stiffness: 300 }}
        >
          {initials}
        </motion.div>
        <div className="rail-actions">
          <motion.button
            className="logout-btn"
            onClick={() => setPwdOpen(true)}
            title={t('auth.changePassword')}
            aria-label={t('auth.changePassword')}
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.9 }}
          >
            <Icon name="lock_reset" size={18} />
          </motion.button>
          <motion.button
            className="logout-btn"
            onClick={logout}
            title={t('auth.logout')}
            aria-label={t('auth.logout')}
            whileHover={{ scale: 1.15, rotate: 15 }}
            whileTap={{ scale: 0.9 }}
          >
            <Icon name="logout" size={18} />
          </motion.button>
        </div>
      </div>
    </div>
  );

  return (
    <motion.aside
      className={`sidebar sidebar-2l${mobileOpen ? ' mobile-open' : ''}`}
      initial={{ x: -80, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="sidebar-logo"
        whileHover={{ scale: 1.03 }}
        transition={{ type: 'spring', stiffness: 300 }}
      >
        <img src="/javonon-logo.svg" alt="Javonon" className="sidebar-brand-img" />
      </motion.div>

      {isMobile ? (
        // ===== МОБИЛЬНЫЙ DRAWER: два шага =====
        <div className="sidebar-mobile">
          <AnimatePresence mode="wait" initial={false}>
            {!drawerGroupObj ? (
              <motion.div
                key="step-groups"
                className="m-step"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.18 }}
              >
                {groups.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`m-group-btn${g.key === activeGroupKey ? ' active' : ''}`}
                    onClick={() => { prefetchGroup(g); setDrawerGroup(g.key); }}
                    onTouchStart={() => prefetchGroup(g)}
                    onMouseEnter={() => prefetchGroup(g)}
                    onFocus={() => prefetchGroup(g)}
                  >
                    <span className="sidebar-nav-icon"><Icon name={g.icon} size={22} /></span>
                    <span>{t(g.labelKey)}</span>
                    <Icon name="chevron_right" size={20} className="m-chev" />
                  </button>
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="step-items"
                className="m-step"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.18 }}
              >
                <button
                  type="button"
                  className="m-back"
                  onClick={() => setDrawerGroup(null)}
                  aria-label={t('common.back')}
                >
                  <Icon name="arrow_back" size={18} />
                  <span>{t(drawerGroupObj.labelKey)}</span>
                </button>
                <nav className="sidebar-panel-nav">{renderItems(drawerGroupObj)}</nav>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        // ===== ДЕСКТОП: rail с 6 иконками + ВЫЕЗЖАЮЩАЯ панель пунктов =====
        // Один hover-регион на rail и панель: панель — DOM-потомок этого
        // div'а, поэтому переезд курсора «иконка → пункт» не даёт
        // mouseleave и панель не мигает.
        <div
          ref={regionRef}
          className="sidebar-split"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          // Фокус покинул сайдбар — снимаем наведение. Пин переживает:
          // его снимает только повторный клик или Escape.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              cancelClose();
              setHoverGroupKey(null);
            }
          }}
        >
          <nav className="sidebar-rail" aria-label={t('sidebar.menu')}>
            {groups.map((g, idx) => (
              <motion.button
                key={g.key}
                ref={(el) => { railRefs.current[g.key] = el; }}
                type="button"
                // Roving tabindex: табируема ровно одна иконка, поэтому Tab с
                // неё попадает в пункты ЕЁ группы, а не на соседнюю иконку.
                tabIndex={g.key === railTabKey ? 0 : -1}
                onKeyDown={(e) => onRailKeyDown(e, g, idx)}
                className={`rail-btn${g.key === activeGroupKey ? ' active' : ''}${
                  panelGroup?.key === g.key && g.key !== activeGroupKey ? ' preview' : ''
                }${pinnedValid === g.key ? ' pinned' : ''}`}
                onClick={(e) => {
                  togglePin(g, clickKeepsHover(e));
                  // detail === 0 ⇒ click синтезирован клавиатурой (Enter или
                  // Space по кнопке). Мышиный клик фокус из-под курсора не
                  // угоняет — там пин работает ровно как работал.
                  if (e.detail === 0) focusPanelFirstItem();
                }}
                title={t(g.labelKey)}
                aria-label={t(g.labelKey)}
                aria-current={g.key === activeGroupKey ? 'true' : undefined}
                aria-expanded={panelGroup?.key === g.key}
                // Кнопка не навигирует, а раскрывает всплывающий список
                // пунктов — вместе с aria-expanded это единственное, из чего
                // скринридер узнаёт, что Enter/→ здесь ОТКРЫВАЮТ, а не идут.
                aria-haspopup="true"
                aria-controls="sidebar-panel-nav"
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.94 }}
                onPointerDown={(e) => { lastPointerType.current = e.pointerType; }}
                onPointerEnter={(e) => hoverGroupOn(e, g)}
                onFocus={() => focusGroupOn(g)}
                onTouchStart={() => prefetchGroup(g)}
              >
                <Icon name={g.icon} size={22} />
              </motion.button>
            ))}
          </nav>
          <AnimatePresence initial={false}>
            {panelGroup && (
              <motion.div
                // Ключ стабильный (не по группе): смена группы при hover'е
                // меняет содержимое БЕЗ повторного выезда панели, а сам
                // выезд/уезд играется только на открытии и закрытии.
                key="sidebar-panel"
                className="sidebar-panel"
                // Только transform и opacity: ширина в потоке (rail) не
                // анимируется вообще, поэтому контент страницы не дёргается.
                // Выезд из-под рейла: панель начинает целиком слева от своей
                // позиции, поэтому кажется, что она выдвигается из полосы с
                // иконками, а не проявляется на месте. Закрытие быстрее
                // открытия — уходящий элемент не должен задерживать взгляд.
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -28 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -22 }}
                transition={{
                  duration: reduceMotion ? 0.001 : 0.26,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <motion.div
                  className="sidebar-panel-title"
                  initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: reduceMotion ? 0 : 0.04 }}
                >
                  {t(panelGroup.labelKey)}
                </motion.div>
                <motion.nav
                  // Здесь ключ по группе — короткое проявление содержимого
                  // при переходе между иконками. Без AnimatePresence: exit
                  // добавил бы задержку, которой при hover'е быть не должно.
                  key={panelGroup.key}
                  ref={panelNavRef}
                  id="sidebar-panel-nav"
                  className="sidebar-panel-nav"
                  aria-label={t(panelGroup.labelKey)}
                  onKeyDown={(e) => onPanelKeyDown(e, panelGroup.key)}
                  // Контейнер-дирижёр: пункты проявляются друг за другом с
                  // шагом 30мс. Задержка перед первым — чтобы список начинал
                  // появляться, когда панель уже выехала, а не одновременно
                  // с ней (иначе всё сливается в одно пятно).
                  variants={
                    reduceMotion
                      ? undefined
                      : {
                          hidden: {},
                          show: {
                            transition: { staggerChildren: 0.03, delayChildren: 0.06 },
                          },
                        }
                  }
                  initial={reduceMotion ? false : 'hidden'}
                  animate={reduceMotion ? { opacity: 1 } : 'show'}
                >
                  {renderItems(panelGroup, true)}
                </motion.nav>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {isMobile ? footMobile : footRail}
      <ChangePasswordModal
        open={pwdOpen}
        mode={{ kind: 'self' }}
        onClose={() => setPwdOpen(false)}
      />
    </motion.aside>
  );
}
