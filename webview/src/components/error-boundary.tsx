import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../apis/vscode';
import './error-boundary.scss';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Last-resort boundary around the whole app. Without it an uncaught render
 * error unmounts the tree and leaves the panel blank with no clue as to why —
 * and a webview's devtools aren't somewhere users think to look. Show the
 * failure in place and mirror it to the extension's output channel.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? '' });
    log('error', `Webview crashed: ${error.stack ?? error.message}`);
    if (info.componentStack) log('error', `Component stack:${info.componentStack}`);
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h2 className="crash-title">Amulet hit an error</h2>
        <p className="crash-hint">
          The chat view stopped rendering. The details below are also in the
          Amulet output channel (Amulet: Show Log).
        </p>
        <pre className="crash-detail">{error.stack ?? String(error)}</pre>
        {stack && <pre className="crash-detail crash-stack">{stack}</pre>}
        <button
          type="button"
          className="crash-retry"
          onClick={() => this.setState({ error: null, stack: '' })}>
          Try again
        </button>
      </div>
    );
  }
}
