import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { syncAgencyHierarchyFromExternalSystem } from './agencyHierarchySync';
import type { ExternalAgencyNode } from './externalAgencySystem';

const fetchExternalAgencyHierarchy = vi.fn<() => Promise<ExternalAgencyNode[]>>();

vi.mock('./externalAgencySystem', () => ({
  fetchExternalAgencyHierarchy: () => fetchExternalAgencyHierarchy(),
}));

describe('syncAgencyHierarchyFromExternalSystem(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'agency-hierarchy-sync-test' } } });
    await prisma.agency.deleteMany({ where: { externalId: { contains: 'sync-test-' } } });
    await prisma.$disconnect();
  });

  it('親→子の順で階層を同期し、親子関係が反映される', async () => {
    fetchExternalAgencyHierarchy.mockResolvedValueOnce([
      {
        id: 1,
        code: 'sync-test-parent',
        name: '同期テスト親代理店',
        person_name: '親担当者',
        level: 1,
        status: 'active',
        parent_id: null,
        parent_code: null,
        contact: { email: 'agency-hierarchy-sync-test-parent@example.com', phone: null, line_url: null },
      },
      {
        id: 2,
        code: 'sync-test-child',
        name: '同期テスト子代理店',
        person_name: '子担当者',
        level: 2,
        status: 'active',
        parent_id: 1,
        parent_code: 'sync-test-parent',
        contact: { email: 'agency-hierarchy-sync-test-child@example.com', phone: null, line_url: null },
      },
    ]);

    const result = await syncAgencyHierarchyFromExternalSystem();
    expect(result.agenciesSynced).toBe(2);

    const parent = await prisma.agency.findUniqueOrThrow({ where: { externalId: 'sync-test-parent' } });
    const child = await prisma.agency.findUniqueOrThrow({ where: { externalId: 'sync-test-child' } });
    expect(child.parentAgencyId).toBe(parent.id);
    expect(parent.name).toBe('同期テスト親代理店');
  });

  it('既存の代理店は名前・状態が更新される(再同期で二重作成されない)', async () => {
    fetchExternalAgencyHierarchy.mockResolvedValueOnce([
      {
        id: 1,
        code: 'sync-test-parent',
        name: '名前変更後の親代理店',
        person_name: '親担当者',
        level: 1,
        status: 'inactive',
        parent_id: null,
        parent_code: null,
        contact: null,
      },
    ]);

    await syncAgencyHierarchyFromExternalSystem();

    const count = await prisma.agency.count({ where: { externalId: 'sync-test-parent' } });
    expect(count).toBe(1);

    const parent = await prisma.agency.findUniqueOrThrow({ where: { externalId: 'sync-test-parent' } });
    expect(parent.name).toBe('名前変更後の親代理店');
    expect(parent.status).toBe('inactive');
  });

  it('代理店申請中のユーザーは、連絡先メールが一致するactiveな代理店が見つかると自動承認される', async () => {
    const email = `agency-hierarchy-sync-test-applicant-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: {
        name: '申請太郎',
        email,
        passwordHash: 'x',
        role: 'user',
        agencyApplicationSubmittedAt: new Date(),
      },
    });

    const externalCode = `sync-test-approved-${Date.now()}`;
    fetchExternalAgencyHierarchy.mockResolvedValueOnce([
      {
        id: 99,
        code: externalCode,
        name: '申請太郎の代理店',
        person_name: '申請太郎',
        level: 3,
        status: 'active',
        parent_id: null,
        parent_code: null,
        contact: { email, phone: null, line_url: null },
      },
    ]);

    const result = await syncAgencyHierarchyFromExternalSystem();
    expect(result.applicationsApproved).toBe(1);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updatedUser.role).toBe('agency');
    expect(updatedUser.agencyApplicationSubmittedAt).toBeNull();

    const agency = await prisma.agency.findUniqueOrThrow({ where: { externalId: externalCode } });
    expect(updatedUser.agencyId).toBe(agency.id);

    await prisma.agency.delete({ where: { id: agency.id } });
  });

  it('連絡先メールが一致しない、または未承認(inactive)の場合は昇格しない', async () => {
    const email = `agency-hierarchy-sync-test-notmatched-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: { name: '未承認太郎', email, passwordHash: 'x', role: 'user', agencyApplicationSubmittedAt: new Date() },
    });

    fetchExternalAgencyHierarchy.mockResolvedValueOnce([
      {
        id: 100,
        code: `sync-test-pending-${Date.now()}`,
        name: '無関係の代理店',
        person_name: '別人',
        level: 3,
        status: 'inactive',
        parent_id: null,
        parent_code: null,
        contact: { email, phone: null, line_url: null },
      },
    ]);

    const result = await syncAgencyHierarchyFromExternalSystem();
    expect(result.applicationsApproved).toBe(0);

    const stillPending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillPending.role).toBe('user');
    expect(stillPending.agencyApplicationSubmittedAt).not.toBeNull();
  });
});
