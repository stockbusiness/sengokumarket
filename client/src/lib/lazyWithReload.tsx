import { lazy, type ComponentType } from 'react';

// 仕様書外の拡張: デプロイ直後等でチャンクのファイル名が変わり、古いindex.htmlを開いたままの
// ブラウザがJSチャンクの読み込みに失敗すると、Suspenseのフォールバック(「読み込み中です...」)が
// 永久に表示されたままになってしまう。1回だけ自動リロードして復旧を試みる。
export function lazyWithReload<T extends { default: ComponentType<unknown> }>(factory: () => Promise<T>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (error) {
      const key = 'chunk-reload-attempted';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
        // リロードが実行されるまでの間、Suspenseのフォールバックを表示させ続ける
        return new Promise<T>(() => {});
      }
      throw error;
    }
  });
}
