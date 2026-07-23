// 仕様書外の拡張(保守性改善Phase 2): フロント・バックで重複していた定数・型を集約する
// 共有Contractsパッケージ。依存ライブラリを増やさず、TypeScriptの型と`as const`定数のみを
// 提供する。CommonJSへコンパイルして`dist/`から配布する(残課題指示書Stage2): serverの
// `node dist/index.js`起動経路がTypeScriptソースを直接requireできないため、`postinstall`で
// 自動ビルドし、コンパイル済み成果物(dist/index.js・dist/index.d.ts)を経由する。
export * from './auth';
export * from './product';
export * from './order';
export * from './payment';
export * from './nft';
export * from './integration';
