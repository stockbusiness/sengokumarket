import { useEffect } from 'react';

// 残課題指示書Stage10: 2ページ目の最後の1件がフィルター変更・状態変更で消えると、
// 一覧が空(items.length=0)のままpage=2に留まり、呼び出し元のtotal件数を見ないと
// 前のページへ戻る手段が無くなってしまう。ここでpage > totalPagesを検知したら
// 呼び出し元へ最終ページへの補正を伝える(呼び出し元は通常どおりpageを更新して再取得する)。
export default function Pagination({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  useEffect(() => {
    if (page > totalPages) onPageChange(totalPages);
  }, [page, totalPages, onPageChange]);

  // total=0の場合は「1 / 1ページ(0件)」を表示する意味が無いため何も表示しない。
  if (total === 0) return null;

  return (
    <div className="admin-pagination">
      <button type="button" className="btn-secondary btn-small" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        前へ
      </button>
      <span>
        {page} / {totalPages}ページ({total}件)
      </span>
      <button type="button" className="btn-secondary btn-small" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        次へ
      </button>
    </div>
  );
}
