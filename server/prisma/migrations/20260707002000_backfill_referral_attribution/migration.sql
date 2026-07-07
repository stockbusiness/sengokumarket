-- 仕様書外の拡張: 「代理店への永久帰属(初回タッチ)」機能を導入する前に発生していた
-- 既存注文をもとに、まだ帰属未設定(referred_by_*が全てNULL)のユーザーへ
-- 最も古い紹介あり注文の代理店/インフルエンサー/紹介リンクを一括で設定する。
--
-- 既に帰属設定済みのユーザー(referred_by_agency_id等がNOT NULL)は対象外のため、
-- 本SQLは何度実行しても安全(冪等)。
UPDATE "users" u
SET
  "referred_by_agency_id" = fo.agency_id,
  "referred_by_influencer_id" = fo.influencer_id,
  "referred_by_referral_link_id" = fo.referral_link_id,
  "referred_by_code" = fo.referral_code,
  "referred_at" = fo.created_at
FROM (
  SELECT DISTINCT ON (user_id)
    user_id,
    agency_id,
    influencer_id,
    referral_link_id,
    referral_code,
    created_at
  FROM "orders"
  WHERE agency_id IS NOT NULL OR influencer_id IS NOT NULL OR referral_link_id IS NOT NULL
  ORDER BY user_id, created_at ASC
) fo
WHERE u.id = fo.user_id
  AND u."referred_by_agency_id" IS NULL
  AND u."referred_by_influencer_id" IS NULL
  AND u."referred_by_referral_link_id" IS NULL;
