import { afterEach, describe, expect, it } from 'vitest';
import { buildReferralUrl } from './referralLinkService';

describe('buildReferralUrl', () => {
  const originalAppUrl = process.env.APP_URL;

  afterEach(() => {
    process.env.APP_URL = originalAppUrl;
  });

  it('APP_URLに末尾スラッシュが無い場合はそのまま連結する', () => {
    process.env.APP_URL = 'https://sengoku-rr.com';
    expect(buildReferralUrl('/products/council-nft', 'SGI004')).toBe(
      'https://sengoku-rr.com/products/council-nft?ref=SGI004',
    );
  });

  it('APP_URLに末尾スラッシュがあってもURLが二重スラッシュにならない', () => {
    process.env.APP_URL = 'https://sengoku-rr.com/';
    expect(buildReferralUrl('/products/council-nft', 'SGI004')).toBe(
      'https://sengoku-rr.com/products/council-nft?ref=SGI004',
    );
  });

  it('landingPathが既に?を含む場合は&で連結する', () => {
    process.env.APP_URL = 'https://sengoku-rr.com';
    expect(buildReferralUrl('/products/council-nft?variant=gold', 'SGI004')).toBe(
      'https://sengoku-rr.com/products/council-nft?variant=gold&ref=SGI004',
    );
  });
});
