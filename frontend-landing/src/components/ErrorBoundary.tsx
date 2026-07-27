import { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

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
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: '#fff5f5',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div
            style={{
              maxWidth: 480,
              background: 'white',
              padding: 32,
              borderRadius: 20,
              boxShadow: '0 12px 32px rgba(0,0,0,0.08)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 56, marginBottom: 8 }}>⚠️</div>
            <h2 style={{ marginBottom: 8 }}>Чизе нодуруст рафт</h2>
            <p style={{ color: '#64748b', marginBottom: 20 }}>
              Саҳифа бор нашуд. Лутфан, аз нав бор кунед.
            </p>
            <button
              onClick={this.reset}
              style={{
                padding: '12px 28px',
                background: '#e72727',
                color: 'white',
                border: 'none',
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Аз нав бор кардан
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
