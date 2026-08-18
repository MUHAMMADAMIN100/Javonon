import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * useUrlListState — состояние списка (фильтры + номер страницы) живёт
 * в query-string, а не в useState.
 *
 * Зачем. Баг от основателя: открыть /applications, пролистать на 3-ю
 * страницу, кликнуть по строке — это push в историю, компонент списка
 * размонтируется — и нажать «назад». Список открывался с 1-й страницы
 * и без фильтров, потому что весь useState умер вместе с компонентом.
 * Если то же состояние лежит в URL, «назад» восстанавливает его бесплатно
 * (браузер просто возвращает предыдущий location и хук перечитывает
 * параметры), F5 не сбрасывает выборку, а отфильтрованный список можно
 * скинуть коллеге ссылкой.
 *
 * Правила, зашитые в хук:
 *
 * 1. Дефолты в URL НЕ пишутся. `?page=1`, `?status=` и прочий шум не
 *    появляются: параметр сериализуется, только если отличается от своего
 *    fallback'а. Пустой фильтр = чистый `/applications`.
 *
 * 2. Чтение параноидальное. Query-string правится руками, живёт в
 *    закладках и переживает релизы, поэтому `?page=abc`, `?page=-4`,
 *    `?page=99999`, `?status=ЧУШЬ` не должны ни ронять страницу, ни
 *    уезжать в API. parse() возвращает undefined на любом мусоре, и
 *    значение молча откатывается к дефолту — так же, как если бы
 *    параметра не было вовсе.
 *
 * 3. История: смена ФИЛЬТРА — replace, смена СТРАНИЦЫ — push.
 *
 *    Фильтр replace'ится, потому что поиск дебаунсится, и каждое
 *    «устаканившееся» значение иначе клало бы запись в историю: после
 *    ввода «Ахмад» кнопка «назад» пять раз возвращала бы «Ахма», «Ахм»,
 *    «Ах»… вместо выхода со страницы. Плюс уточнение фильтра — это
 *    правка текущего экрана, а не переход на другой.
 *
 *    Страница push'ится, потому что листание — осознанный переход:
 *    «назад» с 3-й страницы должно возвращать на 2-ю, ровно как ждёт
 *    пользователь от кнопки браузера. Разовые технические коррекции
 *    (кламп страницы под сократившийся список) передают { replace: true }
 *    явно — это не действие человека, и в истории ему не место.
 */

/** Описание одного параметра списка. */
export type UrlParam<T> = {
  /** Значение по умолчанию. В URL НЕ сериализуется (правило 1). */
  fallback: T;
  /**
   * Разбор сырого значения из URL. Вернуть `undefined` на любом мусоре —
   * хук подставит fallback. Бросать исключения не нужно, но и не страшно:
   * хук ловит их и трактует как мусор.
   */
  parse: (raw: string) => T | undefined;
  /** Обратное преобразование. По умолчанию `String(value)`. */
  serialize?: (value: T) => string;
  /** Смена параметра кладёт запись в историю (правило 3). По умолчанию replace. */
  push?: boolean;
};

export type UrlSpec = Record<string, UrlParam<any>>;

export type UrlValues<S extends UrlSpec> = {
  [K in keyof S]: S[K] extends UrlParam<infer T> ? T : never;
};

/** Опции одной записи в URL. */
type CommitOptions = {
  /** Перебить решение push/replace из spec (нужно техническим коррекциям). */
  replace?: boolean;
};

/**
 * Потолок для номера страницы. Списки в CRM клиентские (пагинация режет
 * уже загруженный массив), так что `?page=999999` — это опечатка или
 * краулер; честнее показать первую страницу, чем пустую таблицу.
 */
const MAX_PAGE = 10_000;

/** Верхний предел длины текстового параметра — чтобы вручную вставленный
 *  `?search=<10 КБ>` не уехал в API и не раздул queryKey. */
const MAX_TEXT_LENGTH = 200;

const defaultSerialize = (value: unknown) => String(value);

const owns = (spec: UrlSpec, key: string) =>
  Object.prototype.hasOwnProperty.call(spec, key);

/** Свободная строка (поиск). Пустая/пробельная = дефолт. */
export function stringParam(fallback = '', maxLength = MAX_TEXT_LENGTH): UrlParam<string> {
  return {
    fallback,
    parse: (raw) => raw.trim().slice(0, maxLength) || undefined,
  };
}

/**
 * Значение из белого списка. Всё остальное — опечатка, старый ключ из
 * протухшей закладки, чужая подстановка — откатывается к дефолту, и в API
 * невалидный enum не попадает (бэкенд на такое отвечает 400).
 */
export function enumParam<T extends string, F extends T | '' = ''>(
  allowed: readonly T[],
  fallback: F = '' as F,
): UrlParam<T | F> {
  const allow = new Set<string>(allowed as readonly string[]);
  return {
    fallback,
    parse: (raw) => (allow.has(raw) ? (raw as T) : undefined),
  };
}

/** Целое число в заданных границах. */
export function intParam(opts: {
  fallback: number;
  min?: number;
  max?: number;
  push?: boolean;
}): UrlParam<number> {
  const { fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  return {
    fallback,
    push: opts.push,
    parse: (raw) => {
      // Регулярка, а не parseInt: parseInt('3abc') === 3, и `?page=3abc`
      // тихо стал бы третьей страницей. Требуем, чтобы числом была вся строка.
      if (!/^[+-]?\d+$/.test(raw)) return undefined;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
      return value;
    },
  };
}

/** Номер страницы: push в историю + защита от `?page=abc | -4 | 99999`. */
export function pageParam(): UrlParam<number> {
  return intParam({ fallback: 1, min: 1, max: MAX_PAGE, push: true });
}

/**
 * Календарный день `YYYY-MM-DD` (границы «свой период», значение
 * CrmDatePicker). Всё остальное — дефолт: `?from=вчера`, `?from=2026-13-40`
 * и `?from=2026-02-31` не должны ни ронять экран, ни уезжать в API,
 * который на такое отвечает 400.
 */
export function dateParam(fallback = ''): UrlParam<string> {
  return {
    fallback,
    parse: (raw) => {
      const value = raw.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
      const [y, m, d] = value.split('-').map(Number);
      // Round-trip: движок не отбраковывает несуществующие даты, а молча
      // перекатывает их (2026-02-31 → 3 марта). Для границы периода это
      // тихо другой период, поэтому такой вход считаем мусором.
      const probe = new Date(Date.UTC(y, m - 1, d));
      if (
        probe.getUTCFullYear() !== y ||
        probe.getUTCMonth() !== m - 1 ||
        probe.getUTCDate() !== d
      ) {
        return undefined;
      }
      return value;
    },
  };
}

/** Флажок. В URL — компактные `1`/`0`. */
export function boolParam(fallback = false): UrlParam<boolean> {
  return {
    fallback,
    serialize: (value) => (value ? '1' : '0'),
    parse: (raw) => {
      if (raw === '1' || raw === 'true') return true;
      if (raw === '0' || raw === 'false') return false;
      return undefined;
    },
  };
}

/**
 * Параметр, который для текущего пользователя не применяется: контрол
 * скрыт (например, фильтр по менеджеру виден только админу), поэтому
 * пришедшее из чужой ссылки значение нельзя было бы снять — оно осталось
 * бы невидимым фильтром. Всегда отдаём дефолт.
 */
export function ignoredParam<T>(fallback: T): UrlParam<T> {
  return { fallback, parse: () => undefined };
}

/**
 * Собирает новый набор параметров: применяет патч, выкидывает дефолты и
 * приводит порядок ключей к порядку объявления в spec (одинаковая выборка
 * → одинаковый URL). Чужие параметры (не описанные в spec) не трогает.
 */
function applyPatch(
  current: URLSearchParams,
  spec: UrlSpec,
  patch: Record<string, unknown>,
  pageKey?: string,
): URLSearchParams {
  const next = new URLSearchParams(current);

  for (const key of Object.keys(patch)) {
    const param = spec[key];
    if (!param) continue;
    const value = patch[key];
    const serialize = (param.serialize ?? defaultSerialize) as (v: unknown) => string;
    if (value === undefined || value === null || serialize(value) === serialize(param.fallback)) {
      next.delete(key);
    } else {
      next.set(key, serialize(value));
    }
  }

  // Любая смена фильтра сбрасывает пагинацию: остаться на 7-й странице
  // выборки, в которой после фильтра всего две, — это пустая таблица.
  if (pageKey && !Object.prototype.hasOwnProperty.call(patch, pageKey)) {
    next.delete(pageKey);
  }

  const ordered = new URLSearchParams();
  next.forEach((value, key) => {
    if (!owns(spec, key)) ordered.append(key, value);
  });
  for (const key of Object.keys(spec)) {
    const value = next.get(key);
    if (value !== null) ordered.set(key, value);
  }
  return ordered;
}

export function useUrlListState<S extends UrlSpec>(
  spec: S,
  options: { pageKey?: Extract<keyof S, string> } = {},
) {
  const { pageKey } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  // spec пересобирается каждый рендер (в нём стрелки parse/serialize), а
  // setSearchParams из react-router меняет идентичность после каждой
  // навигации. Держим и то и другое в ref'ах, чтобы возвращаемые setValue/
  // reset были стабильными: иначе они попадают в deps дебаунса поиска и
  // любое изменение URL перезапускало бы его таймер.
  const specRef = useRef(spec);
  specRef.current = spec;
  const paramsRef = useRef(searchParams);
  paramsRef.current = searchParams;
  const setParamsRef = useRef(setSearchParams);
  setParamsRef.current = setSearchParams;

  // Разбор на каждый рендер: ключей единицы, а результат обязан быть
  // синхронен с searchParams (после «назад» ничего досчитывать нельзя).
  const values = {} as UrlValues<S>;
  for (const key of Object.keys(spec)) {
    const param = spec[key];
    const raw = searchParams.get(key);
    let parsed: unknown;
    if (raw !== null && raw !== '') {
      try {
        parsed = param.parse(raw);
      } catch {
        parsed = undefined;
      }
    }
    (values as Record<string, unknown>)[key] = parsed === undefined ? param.fallback : parsed;
  }

  const setValues = useCallback(
    (patch: Partial<UrlValues<S>>, opts: CommitOptions = {}) => {
      const currentSpec = specRef.current;
      const keys = Object.keys(patch).filter((key) => owns(currentSpec, key));
      if (keys.length === 0) return;

      const next = applyPatch(paramsRef.current, currentSpec, patch, pageKey);
      // Клик по уже активной странице/фильтру не должен плодить записи
      // в истории: «назад» не может стоять на месте.
      if (next.toString() === paramsRef.current.toString()) return;

      const push =
        opts.replace === undefined
          ? keys.some((key) => currentSpec[key].push)
          : !opts.replace;

      setParamsRef.current(next, { replace: !push });
    },
    [pageKey],
  );

  const setValue = useCallback(
    <K extends Extract<keyof S, string>>(
      key: K,
      value: UrlValues<S>[K],
      opts?: CommitOptions,
    ) => {
      setValues({ [key]: value } as Partial<UrlValues<S>>, opts);
    },
    [setValues],
  );

  /**
   * Сброс. Без аргументов чистит все параметры списка; со списком ключей —
   * только их (кнопка «Сбросить» на /applications исторически не трогает
   * переключатель «Мои/Все»). Страница обнуляется в любом случае.
   */
  const reset = useCallback(
    (keysToReset?: Extract<keyof S, string>[]) => {
      const currentSpec = specRef.current;
      const patch: Record<string, unknown> = {};
      for (const key of keysToReset ?? Object.keys(currentSpec)) {
        if (owns(currentSpec, key)) patch[key] = currentSpec[key].fallback;
      }
      if (pageKey) patch[pageKey] = currentSpec[pageKey].fallback;
      setValues(patch as Partial<UrlValues<S>>, { replace: true });
    },
    [pageKey, setValues],
  );

  return { values, setValue, setValues, reset };
}
