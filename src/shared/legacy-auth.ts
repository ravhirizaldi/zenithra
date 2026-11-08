import { createCipheriv, createDecipheriv } from 'node:crypto';

export function legacyDirectKey(): string {
  const key = process.env.CONMAS_DIRECT_KEY;
  if (!key) throw new Error('Direct compatibility key is not configured.');
  return key;
}

function resizeKey(source: Buffer): Buffer {
  const result = Buffer.alloc(8);
  for (let index = 0; index < source.length; index++) result[index % 8] ^= source[index];
  return result;
}

export function legacyEncrypt(value: string, key: string): string {
  const desKey = resizeKey(Buffer.from(key, 'utf8'));
  const cipher = createCipheriv('des-ede3-cbc', Buffer.concat([desKey, desKey, desKey]), desKey);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

export function legacyPassword(userId: string, password: string, rootKey: string): string {
  const userKey = legacyEncrypt(`#*${userId}*#`, rootKey);
  return legacyEncrypt(password, userKey);
}

export function legacyDecrypt(value: string, key: string): string {
  const desKey = resizeKey(Buffer.from(key, 'utf8'));
  const cipher = createDecipheriv('des-ede3-cbc', Buffer.concat([desKey, desKey, desKey]), desKey);
  return Buffer.concat([cipher.update(Buffer.from(value, 'base64')), cipher.final()]).toString('utf8');
}
