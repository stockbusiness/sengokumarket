// 仕様書外の拡張(保守性改善Phase 2): フロント・バックで重複していた定数・型を集約する
// 共有Contractsパッケージ。依存ライブラリを増やさず、TypeScriptの型と`as const`定数のみを
// 提供する(ビルドステップなし。server/tsx・client/vite・vitestのいずれも生TSソースを直接
// 解決できるため、コンパイル済み成果物を経由する必要がない)。
export * from './auth';
export * from './product';
export * from './order';
export * from './payment';
export * from './nft';
export * from './integration';
