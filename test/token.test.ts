import { describe, expect, it } from 'vitest';
import { issueDeviceToken, verifyDeviceToken, timingSafeEqualStr, sha256Hex } from '../src/token';

const SECRET = 'test-secret-0123456789abcdef';

describe('设备 token', () => {
  it('签发→验证 roundtrip = ok；重复签发每次都是新值', async () => {
    const t1 = await issueDeviceToken(SECRET);
    const t2 = await issueDeviceToken(SECRET);
    expect(t1).not.toBe(t2);
    expect(await verifyDeviceToken(SECRET, t1)).toBe('ok');
    expect(await verifyDeviceToken(SECRET, t2)).toBe('ok');
  });
  it('换密钥验签 = token-invalid（跨部署不通用）', async () => {
    const t = await issueDeviceToken(SECRET);
    expect(await verifyDeviceToken('another-secret-aaaaaaaaaaaaaaaa', t)).toBe('token-invalid');
  });
  it('篡改 payload 或签名任一字节 = token-invalid', async () => {
    const t = await issueDeviceToken(SECRET);
    const [body, sig] = t.split('.');
    const flip = (s: string): string => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    expect(await verifyDeviceToken(SECRET, `${flip(body!)}.${sig}`)).toBe('token-invalid');
    expect(await verifyDeviceToken(SECRET, `${body}.${flip(sig!)}`)).toBe('token-invalid');
  });
  it('形态坏（双点/缺段/非法字符）= token-invalid', async () => {
    expect(await verifyDeviceToken(SECRET, 'a.b.c')).toBe('token-invalid');
    expect(await verifyDeviceToken(SECRET, 'nodot')).toBe('token-invalid');
    expect(await verifyDeviceToken(SECRET, 'b@d.m@e')).toBe('token-invalid');
  });
  it('iat 超过 30 天 = token-expired', async () => {
    const t = await issueDeviceToken(SECRET);
    const monthLater = Date.now() + 31 * 24 * 60 * 60 * 1000;
    expect(await verifyDeviceToken(SECRET, t, monthLater)).toBe('token-expired');
    const edge = Date.now() + 29 * 24 * 60 * 60 * 1000;
    expect(await verifyDeviceToken(SECRET, t, edge)).toBe('ok');
  });
  it('timingSafeEqualStr 常数时间比较：等长同文 true、异文 false、异长 false', () => {
    expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
  it('sha256Hex 与已知向量对平', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
