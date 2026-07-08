import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// 仕様書外の拡張: ページ読み込み中の予期しないエラー(チャンク読み込み失敗の再試行後も
// 失敗した場合等)を捕まえ、画面が固まったように見えるのを防ぐ。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('画面の表示中にエラーが発生しました', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-load-error">
          <p>ページの表示に失敗しました。通信環境をご確認のうえ、再読み込みをお試しください。</p>
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            再読み込みする
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
