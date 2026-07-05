import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('SETTINGS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

// 保存形式: base64(iv(12byte) + authTag(16byte) + ciphertext)
export function encryptSetting(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSetting(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
