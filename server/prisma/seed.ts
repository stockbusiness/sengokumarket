import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD が未設定です');
  }

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: '管理者',
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      role: 'admin',
    },
  });

  const product = await prisma.product.upsert({
    where: { slug: 'council-nft' },
    update: {},
    create: {
      name: 'インフルエンサー評議員NFT',
      slug: 'council-nft',
      category: '評議員NFT',
      itemType: 'nft',
      description: '戦国経済圏に参加する評議員向けの限定NFTです。',
      basePrice: 25000,
      status: 'published',
    },
  });

  await prisma.productVariant.upsert({
    where: { sku: 'council-nft-black' },
    update: {},
    create: {
      productId: product.id,
      name: 'Black',
      sku: 'council-nft-black',
      price: 25000,
      stock: 100,
    },
  });

  await prisma.productVariant.upsert({
    where: { sku: 'council-nft-red' },
    update: {},
    create: {
      productId: product.id,
      name: 'RED',
      sku: 'council-nft-red',
      price: 25000,
      stock: 100,
    },
  });

  const agency = await prisma.agency.upsert({
    where: { code: 'AG001' },
    update: {},
    create: {
      name: '戦国インフルエンサー代理店サンプル',
      code: 'AG001',
      defaultCommissionRate: 20,
    },
  });

  const influencer = await prisma.influencer.upsert({
    where: { code: 'INF001' },
    update: {},
    create: {
      agencyId: agency.id,
      name: 'サンプルインフルエンサー',
      code: 'INF001',
    },
  });

  await prisma.referralLink.upsert({
    where: { code: 'SGI001' },
    update: {},
    create: {
      code: 'SGI001',
      agencyId: agency.id,
      influencerId: influencer.id,
      landingPath: '/products/council-nft',
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
