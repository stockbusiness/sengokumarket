// 指示書12.2「text/plain生成」。各テンプレートが用意する行(段落)の配列を空行区切りで
// 連結するだけの単純な実装とする。HTMLからの自動変換は行わない(タグの解釈違いによる
// 表示崩れを避けるため、各テンプレート側でHTML版と対になる文面を明示的に用意する)。
export function renderTextLayout(lines: string[]): string {
  return lines.join('\n\n');
}
