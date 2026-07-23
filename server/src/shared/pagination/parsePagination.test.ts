import { describe, expect, it } from 'vitest';
import { parsePagination } from './parsePagination';

describe('parsePagination', () => {
  it('未指定時は1ページ目・既定pageSizeになる', () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 50, skip: 0, take: 50 });
  });

  it('page/pageSizeを指定するとskip/takeが計算される', () => {
    expect(parsePagination({ page: '3', pageSize: '20' })).toEqual({ page: 3, pageSize: 20, skip: 40, take: 20 });
  });

  it('pageSizeの上限を超える指定は上限値にクランプされる', () => {
    expect(parsePagination({ pageSize: '9999' })).toEqual({ page: 1, pageSize: 100, skip: 0, take: 100 });
  });

  it('0以下やNaNのpageは1にフォールバックする', () => {
    expect(parsePagination({ page: '0' }).page).toBe(1);
    expect(parsePagination({ page: 'abc' }).page).toBe(1);
  });
});
