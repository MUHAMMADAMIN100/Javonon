/**
 * Значки — шрифт Material Symbols с Google Fonts (index.html). Пока он
 * грузится (первый заход, медленный интернет), браузер рисует вместо значка
 * его имя словом — «notifications», «chevron_left», — и слово раздвигает
 * строку: на телефоне шапка вылезала за экран (02.11.2026).
 *
 * Поэтому <html> с самого начала несёт класс icons-loading (index.html), и
 * пока он стоит, значок — пустое место размером 1em (index.css). Шрифт
 * пришёл — класс снимаем, и значки рисуются как обычно, ничего не сдвигается.
 * Дольше ICON_FONT_WAIT_MS не ждём: если шрифт не грузится совсем (Google
 * недоступен), слова полезнее пустоты.
 *
 * Модульный скрипт выполняется после таблиц стилей из <head>, так что
 * @font-face шрифта к этому моменту уже объявлен и load() ждёт сам файл.
 */
export const ICON_FONT_WAIT_MS = 8000;

export function watchIconFont(): void {
  const root = document.documentElement;
  const done = () => root.classList.remove('icons-loading');
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') {
    done();
    return;
  }
  const timer = window.setTimeout(done, ICON_FONT_WAIT_MS);
  const finish = () => {
    window.clearTimeout(timer);
    done();
  };
  fonts.load('24px "Material Symbols Rounded"').then(finish, finish);
}
