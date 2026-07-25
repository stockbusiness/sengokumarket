import { adminFetch } from '../../shared/api/adminClient';
import type { AdminProductIntegrationRule } from '../admin-products/api';

// 本番安定化指示書Stage11(14.1「Product Integration Rules」画面): 全商品横断の一覧。
// 編集は商品編集画面(/admin/products/:id/edit)へ委ねる(9.5)ため、ここでは閲覧のみ。
export interface AdminProductIntegrationRuleWithProduct extends AdminProductIntegrationRule {
  product: { id: string; name: string };
}

export function fetchAdminProductIntegrationRulesOverview() {
  return adminFetch<{ rules: AdminProductIntegrationRuleWithProduct[] }>('/product-integration-rules');
}
