/**
 * Сенсорный экран (телефон, планшет): курсор в поле поиска сам не ставим —
 * иначе при открытии списка выскакивает экранная клавиатура и закрывает
 * половину вариантов. Клавиатура появится, когда человек сам нажмёт на поле.
 * На компьютере фокус в поиске остаётся: экранной клавиатуры нет, а печатать
 * сразу удобно.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}
