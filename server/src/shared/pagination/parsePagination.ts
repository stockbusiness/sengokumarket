export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

// 管理画面一覧のページネーション(指示書13.2)。既存のadmin/auditLogs.tsと同じ規約
// (page=1始まり、pageSizeの既定値・上限値、不正値は既定値にフォールバック)を踏襲する。
export function parsePagination(
  query: { page?: unknown; pageSize?: unknown },
  defaultPageSize = 50,
  maxPageSize = 100,
): PaginationParams {
  const page = Math.max(Number.parseInt(String(query.page ?? '1'), 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(String(query.pageSize ?? ''), 10) || defaultPageSize, 1), maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
