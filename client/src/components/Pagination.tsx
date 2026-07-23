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
