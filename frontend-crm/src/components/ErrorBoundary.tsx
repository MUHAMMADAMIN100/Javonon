import { Component, ReactNode, ErrorInfo } from 'react';
import { useT } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function FallbackUI({ error, reset }: { error: Error | null; reset: () => void }) {
  const { t } = useT();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#f8fafc',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          background: 'white',
          padding: 32,
          borderRadius: 16,
          boxShadow: '0 12px 32px rgba(0,0,0,0.08)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 48, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ marginBottom: 8 }}>{t('error.title')}</h2>
        <p style={{ color: '#64748b', marginBottom: 20 }}>{t('error.message')}</p>
        {error?.message && (
          <pre
            style={{
              background: '#f1f5f9',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              textAlign: 'left',
              overflowX: 'auto',
              marginBottom: 20,
            }}
          >
            {error.message}
          </pre>
        )}
        <button
          onClick={reset}
          style={{
            padding: '10px 24px',
            background: '#0a0f0d',
            color: 'white',
            border: 'none',
            borderRadius: 100,
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
            letterSpacing: '-0.01em',
          }}
        >
          {t('error.reload')}
        </button>
      </div>
    </div>
  );
}

/**
 * Глобальный ErrorBoundary CRM. Показывает резервный UI вместо белого экрана,
 * когда любой нижестоящий компонент бросает ошибку при рендере.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return <FallbackUI error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}
