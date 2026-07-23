// Domain Policy層が投げる共通エラー(指示書11.4「APIエラーコードを定義」)。
// HTTPステータスへのマッピングは呼び出し元(Route)が行う(Domain Policy自体はExpressに依存しない)。
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
