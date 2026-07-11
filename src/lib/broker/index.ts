// ===== Broker Adapter 팩토리 + API 키 암호화 (서버 전용) =====
// 주의: 이 모듈은 Netlify Functions 에서만 import 한다 (node:crypto 사용).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { BrokerAdapter, BrokerCredentials, TokenCache, TokenPersist } from './types';
import { KISAdapter } from './kis';
import { TossAdapter } from './toss';

export * from './types';

export function getAdapter(
  broker: string,
  creds: BrokerCredentials,
  token: TokenCache,
  persist: TokenPersist,
): BrokerAdapter {
  if (broker === 'toss') return new TossAdapter(creds, token, persist);
  return new KISAdapter(creds, token, persist);
}

// ── API 키 암호화 (AES-256-GCM, BROKER_ENC_KEY 환경변수 기반) ──
// BROKER_ENC_KEY 미설정 시 base64 인코딩(plain:)으로 저장하고 UI에 경고를 띄운다.
const encKey = (): Buffer | null => {
  const k = process.env.BROKER_ENC_KEY;
  return k ? createHash('sha256').update(k).digest() : null;
};

export const encryptionEnabled = () => encKey() != null;

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const k = encKey();
  if (!k) return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  if (!stored.startsWith('enc:')) return stored; // 과거 평문 저장분 호환
  const k = encKey();
  if (!k) throw new Error('BROKER_ENC_KEY 미설정 — 저장된 API 키를 복호화할 수 없습니다.');
  const buf = Buffer.from(stored.slice(4), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** 마스킹된 키 표시용 (앞 4자리만 노출) */
export const maskKey = (stored: string): string => {
  if (!stored) return '';
  try {
    const plain = decryptSecret(stored);
    return plain.length <= 8 ? '****' : plain.slice(0, 4) + '****' + plain.slice(-2);
  } catch {
    return '(암호화됨)';
  }
};
