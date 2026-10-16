/**
 * 设备 token：`b64url(payloadJSON).b64url(HMAC-SHA256(secret, payload))`。
 * payload = { v:1, jti: uuid, iat: epoch 秒 }。无状态、无存储——同一设备重复领发新值，
 * 旧值在 TTL 内仍有效（客户端存 localStorage，丢了重新领即可）。
 */

const TOKEN_TTL_S = 30 * 24 * 60 * 60;

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (s: string): Uint8Array => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const raw = atob(std + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 常数时间字符串比较（跨环境自持：Workers/Node 的 subtle 都未必有 timingSafeEqual） */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** 签发新设备 token（每次调用都是新 jti） */
export async function issueDeviceToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ v: 1, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) });
  const body = b64url(new TextEncoder().encode(payload));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

/** 验证结果三态：ok / 形态或签名不符 / 签名对但过了时效 */
export type TokenVerify = 'ok' | 'token-invalid' | 'token-expired';

export async function verifyDeviceToken(secret: string, token: string, now = Date.now()): Promise<TokenVerify> {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return 'token-invalid';
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return 'token-invalid';
  const expected = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body))));
  if (!timingSafeEqualStr(expected, sig)) return 'token-invalid';
  let payload: { v?: unknown; iat?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as { v?: unknown; iat?: unknown };
  } catch {
    return 'token-invalid';
  }
  if (payload.v !== 1 || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return 'token-invalid';
  if (now / 1000 - payload.iat > TOKEN_TTL_S) return 'token-expired';
  return 'ok';
}

/** hex 摘要（webcrypto）——发布链路唯一一处 SHA-256 实现 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}
