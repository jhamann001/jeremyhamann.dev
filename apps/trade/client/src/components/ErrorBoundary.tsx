import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  pathname: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, pathname: window.location.pathname };

  private origPushState: typeof history.pushState | null = null;
  private origReplaceState: typeof history.replaceState | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidMount() {
    window.addEventListener('popstate', this.handleNavigation);

    this.origPushState = history.pushState.bind(history);
    this.origReplaceState = history.replaceState.bind(history);

    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      this.origPushState!(...args);
      this.handleNavigation();
    };
    history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
      this.origReplaceState!(...args);
      this.handleNavigation();
    };
  }

  componentWillUnmount() {
    window.removeEventListener('popstate', this.handleNavigation);
    if (this.origPushState) history.pushState = this.origPushState;
    if (this.origReplaceState) history.replaceState = this.origReplaceState;
  }

  private handleNavigation = () => {
    if (this.state.hasError && window.location.pathname !== this.state.pathname) {
      this.setState({ hasError: false, error: null, pathname: window.location.pathname });
    }
  };

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.reportError(error, info);
  }

  private reportError(error: Error, info: ErrorInfo) {
    try {
      const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]*)/);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfMatch?.[1]) headers['x-csrf-token'] = csrfMatch[1];
      fetch('/api/client-errors', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          error: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
          url: window.location.href,
        }),
      }).catch(() => {});
    } catch {
      // best-effort
    }
  }

  private handleTryAgain = () => {
    this.setState({ hasError: false, error: null, pathname: window.location.pathname });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[var(--bg-page)] flex items-center justify-center p-8">
          <div className="bg-[var(--bg-card)] rounded-2xl border border-[var(--border)] shadow-sm p-8 max-w-lg w-full text-center">
            <h1 className="font-serif text-xl font-medium text-[var(--text-primary)] mb-2">Something went wrong</h1>
            <p className="text-sm text-[var(--text-muted)] mb-6">
              An unexpected error occurred. Please try again. If the issue persists, contact support.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleTryAgain}
                className="px-6 py-2.5 bg-[var(--bg-pill)] text-white rounded-lg text-sm font-semibold hover:bg-[var(--bg-pill-hover)] transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm font-medium transition-colors"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
