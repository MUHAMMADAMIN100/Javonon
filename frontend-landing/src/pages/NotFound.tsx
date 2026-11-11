/**
 * Неизвестный адрес сайта — понятная страница вместо пустого серого экрана (QA-2).
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
        background: '#F5F7FB',
        fontFamily: 'Inter, system-ui, sans-serif',
        color: '#0A0D1A',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: '#FFFFFF',
          border: '1px solid #E4E9F1',
          borderRadius: 18,
          padding: '32px 24px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <span style={{ font: '800 44px Manrope, Inter, sans-serif', color: '#01368B', letterSpacing: '-0.02em' }}>404</span>
        <h1 style={{ margin: 0, font: '800 22px Manrope, Inter, sans-serif' }}>Саҳифа ёфт нашуд</h1>
        <p style={{ margin: 0, fontSize: 15, color: '#3D4558', lineHeight: 1.5 }}>
          Такой страницы нет — возможно, ссылка устарела.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 8 }}>
          <a
            href="/"
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 18px', borderRadius: 12, background: '#01368B', color: '#FFFFFF', fontWeight: 600, textDecoration: 'none' }}
          >
            Ба саҳифаи асосӣ · На главную
          </a>
          <a
            href="/login"
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 18px', borderRadius: 12, border: '1px solid #D5DDE8', color: '#0A0D1A', fontWeight: 600, textDecoration: 'none' }}
          >
            Кабинет · Войти
          </a>
        </div>
      </div>
    </main>
  );
}
