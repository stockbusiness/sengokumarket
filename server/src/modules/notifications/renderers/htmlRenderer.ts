// 指示書12.2「HTMLエスケープ」・12.3「顧客名・商品名・銀行情報をエスケープ」。
// 顧客が自由入力する値(customerName・explainerName等)や商品名・振込先情報をメール本文へ
// 差し込む際は必ずこれを通す(従来はエスケープなしで直接埋め込まれており、悪意ある入力値に
// よるHTMLインジェクションが可能な状態だった)。
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 指示書12.2「共通レイアウト」。現行メールの見た目(装飾のないシンプルなp/ul構成)を
// 大きく変えないため(指示書12.3「現行メール内容を大きく変更しない」)、現時点では素通しする。
// 将来ブランド共通のヘッダー・フッターを追加する場合は、この関数のみを変更すればよい。
export function renderHtmlLayout(bodyHtml: string): string {
  return bodyHtml;
}
