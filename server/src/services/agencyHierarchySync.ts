import { prisma } from '../lib/prisma';
import { generateAgencyCode } from './referralCodeGenerator';
import { fetchExternalAgencyHierarchy, type ExternalAgencyNode } from './externalAgencySystem';

export interface AgencyHierarchySyncResult {
  agenciesSynced: number;
  applicationsApproved: number;
}

// 仕様書外の拡張: 外部代理店システム(sengoku-ai.com)の階層取得APIから最新の代理店階層を取得し、
// 本システム側のagenciesテーブルへ反映する(sengoku-ai.comを代理店階層のマスターとして扱う)。
// あわせて、会員が代理店申請中(agency_application_submitted_at設定済み)のユーザーについて、
// 先方で承認され連絡先メールが一致する代理店が見つかった場合、そのユーザーをagencyロールへ昇格させる。
export async function syncAgencyHierarchyFromExternalSystem(): Promise<AgencyHierarchySyncResult> {
  const nodes = await fetchExternalAgencyHierarchy();

  // 1st pass: 代理店本体をexternalId(=先方のcode)でupsertする。
  for (const node of nodes) {
    const existing = await prisma.agency.findUnique({ where: { externalId: node.code } });
    const status = node.status === 'active' ? 'active' : 'inactive';

    if (existing) {
      await prisma.agency.update({
        where: { id: existing.id },
        data: {
          name: node.name,
          contactName: node.name,
          contactEmail: node.contactEmail,
          status,
        },
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const code = await generateAgencyCode(tx);
        return tx.agency.create({
          data: {
            name: node.name,
            code,
            externalId: node.code,
            contactName: node.name,
            contactEmail: node.contactEmail,
            status,
            defaultCommissionRate: 0,
          },
        });
      });
    }
  }

  // 2nd pass: parentCodeを見て親子関係を反映する(1st passで親子とも作成済みである前提)。
  for (const node of nodes) {
    if (!node.parentCode) continue;
    const [self, parent] = await Promise.all([
      prisma.agency.findUnique({ where: { externalId: node.code } }),
      prisma.agency.findUnique({ where: { externalId: node.parentCode } }),
    ]);
    if (self && parent && self.parentAgencyId !== parent.id) {
      await prisma.agency.update({ where: { id: self.id }, data: { parentAgencyId: parent.id } });
    }
  }

  // 代理店申請中の会員を、連絡先メールの一致で自動承認する。
  const pendingUsers = await prisma.user.findMany({
    where: { role: 'user', agencyApplicationSubmittedAt: { not: null } },
  });

  let applicationsApproved = 0;
  for (const user of pendingUsers) {
    const approvedNode = findApprovedNodeByEmail(nodes, user.email);
    if (!approvedNode) continue;

    const agency = await prisma.agency.findUnique({ where: { externalId: approvedNode.code } });
    if (!agency) continue;

    // 残課題指示書Stage11: role・agencyIdはJWTペイロードにスナップショットされるため、
    // 変更後は旧Cookieを即座に無効化できるようsessionVersionも合わせてインクリメントする。
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'agency', agencyId: agency.id, agencyApplicationSubmittedAt: null, sessionVersion: { increment: 1 } },
    });
    applicationsApproved += 1;
  }

  return { agenciesSynced: nodes.length, applicationsApproved };
}

function findApprovedNodeByEmail(nodes: ExternalAgencyNode[], email: string): ExternalAgencyNode | null {
  return nodes.find((n) => n.status === 'active' && n.contactEmail?.toLowerCase() === email.toLowerCase()) ?? null;
}
