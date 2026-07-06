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

  const legalDocuments: { slug: string; title: string; body: string }[] = [
    {
      slug: 'tokushoho',
      title: '特定商取引法に基づく表記',
      body: [
        '!本ページは仮の文言です。正式な内容が決まり次第、編集してください。',
        '販売事業者名|○○○○(準備中)',
        '運営統括責任者|○○○○(準備中)',
        '所在地|○○○○(準備中)',
        '電話番号|○○○○(準備中)',
        'メールアドレス|○○○○(準備中)',
        '販売価格|各商品ページに表示する価格(税込)による',
        '商品代金以外の必要料金|○○○○(準備中)',
        'お支払い方法|クレジットカード決済(Stripe)',
        'お支払い時期|ご注文時',
        '商品の引渡し時期|決済完了後、順次デジタル会員証を発行します(詳細はマイページをご確認ください)',
        '返品・キャンセルについて|返金ポリシーページをご確認ください',
      ].join('\n'),
    },
    {
      slug: 'terms',
      title: '利用規約',
      body: [
        '!本ページは仮の文言です。正式な内容が決まり次第、編集してください。',
        '## 第1条(適用)',
        '本規約は、当サービスの利用に関する条件を定めるものです。(準備中)',
        '## 第2条(会員登録)',
        '利用者は本規約に同意の上、会員登録を行うものとします。(準備中)',
        '## 第3条(禁止事項)',
        '利用者は、法令または公序良俗に反する行為等を行ってはならないものとします。(準備中)',
        '## 第4条(デジタル会員証について)',
        'デジタル会員証の性質・特典内容については商品ページの説明によるものとします。(準備中)',
        '## 第5条(免責事項)',
        '当サービスに起因して利用者に生じたトラブルについて、運営者は一切の責任を負わないものとします。(準備中)',
        '## 第6条(規約の変更)',
        '運営者は必要と判断した場合、利用者への事前の通知なく本規約を変更することがあります。(準備中)',
      ].join('\n'),
    },
    {
      slug: 'refund',
      title: '返金ポリシー',
      body: [
        '!本ページは仮の文言です。正式な内容が決まり次第、編集してください。',
        '## 返金の対応について',
        'デジタル会員証の性質上、決済完了後の返金は原則として承っておりません。(準備中)',
        '## 例外的な返金対応',
        'システム上の不備等、当方の責に帰すべき事由がある場合は、個別に返金対応を検討します。(準備中)',
        '## お問い合わせ',
        '返金に関するお問い合わせは、サポート窓口までご連絡ください。(準備中)',
      ].join('\n'),
    },
    {
      slug: 'privacy',
      title: 'プライバシーポリシー',
      body: [
        '!本ページは仮の文言です。正式な内容が決まり次第、編集してください。',
        '## 個人情報の取得',
        '当サービスは、氏名・メールアドレス・電話番号・住所等、サービス提供に必要な範囲で個人情報を取得します。(準備中)',
        '## 個人情報の利用目的',
        '取得した個人情報は、商品の発送・連絡・サポート対応等の目的で利用します。(準備中)',
        '## 個人情報の第三者提供',
        '法令に基づく場合を除き、本人の同意なく第三者に個人情報を提供することはありません。(準備中)',
        '## お問い合わせ窓口',
        '個人情報の取扱いに関するお問い合わせは、サポート窓口までご連絡ください。(準備中)',
      ].join('\n'),
    },
  ];

  for (const doc of legalDocuments) {
    await prisma.legalDocument.upsert({
      where: { slug: doc.slug },
      update: {},
      create: doc,
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
