// A render error in one part of the window shows a notice there instead of blanking the whole window.

import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ui] ${this.props.label ?? 'view'} crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-title">{this.props.label ? `${this.props.label} gặp lỗi` : 'Phần này gặp lỗi'}</div>
        <div className="error-boundary-detail selectable">{this.state.error.message}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Thử lại
        </button>
      </div>
    );
  }
}
