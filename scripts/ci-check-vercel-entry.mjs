// 本番安定化指示書Stage12(15.3「Vercel entry import」): api/index.tsが起動時例外なく
// importできることを確認する(server/src/index.tsとは別経路で、必須環境変数のassertが
// 二重に呼ばれるだけで実処理には影響しない)。
import '../api/index.ts';
console.log('api/index.ts loaded OK');
