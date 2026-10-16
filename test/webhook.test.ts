import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, parseMergedPublish, extractMergedPublish, mergeIndexEntry, indexBytesExceeded } from '../src/webhook';
import type { MarketIndex, MarketIndexEntry } from '../src/schema';

const SECRET = 'whsec-0123456789abcdef';

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

describe('webhook 验签', () => {
  it('正确签名 → true；密钥不对 / 头缺段 / 无头 → false', async () => {
    const raw = new TextEncoder().encode('{"action":"closed"}');
    const sig = await sign(SECRET, new TextDecoder().decode(raw));
    expect(await verifyWebhookSignature(SECRET, raw, sig)).toBe(true);
    expect(await verifyWebhookSignature(SECRET, raw, await sign('wrong', 'x'))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, raw, sig.replace('sha256=', ''))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, raw, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, raw, 'sha256=' + '0'.repeat(64))).toBe(false);
  });
});

describe('merged publish 解析', () => {
  it('publish/<id>-<version> 贪婪前缀反解（id 可含 . _ -）', () => {
    expect(parseMergedPublish('publish/demo.era-tw-1.0.1')).toEqual({ id: 'demo.era-tw', version: '1.0.1' });
    expect(parseMergedPublish('publish/weird.id_1-2.3.4')).toEqual({ id: 'weird.id_1', version: '2.3.4' });
  });
  it('非 publish 分支 / 缺版本 → null', () => {
    expect(parseMergedPublish('master')).toBeNull();
    expect(parseMergedPublish('publish/demo.era-tw')).toBeNull();
    expect(parseMergedPublish(undefined)).toBeNull();
  });
  it('extractMergedPublish：只有 closed+merged=true 才放行', () => {
    const pr = (action: string, merged: boolean, ref = 'publish/demo.era-tw-1.0.1') => ({
      action,
      pull_request: { merged, head: { ref } },
    });
    expect(extractMergedPublish(pr('closed', true))).toEqual({ id: 'demo.era-tw', version: '1.0.1' });
    expect(extractMergedPublish(pr('closed', false))).toBeNull();
    expect(extractMergedPublish(pr('opened', true))).toBeNull();
    expect(extractMergedPublish(pr('closed', true, 'master'))).toBeNull();
    expect(extractMergedPublish('garbage')).toBeNull();
  });
});

describe('索引镜像合并', () => {
  const entry = (id: string, version: string, kind = 'kojo-pack'): MarketIndexEntry =>
    ({ kind, id, version, name: id, author: 'a', license: 'CC0', minAppVersion: '0.4.0', zip: { url: 'https://x', sha256: 'a'.repeat(64), bytes: 1 }, fileCount: 1, unpackedBytes: 1 }) as MarketIndexEntry;
  const base: MarketIndex = { schema: 1, generatedAt: '2026-01-01T00:00:00Z', packs: [entry('b.pack', '1.0.0'), entry('a.pack', '0.9.0', 'dict-pack')] };

  it('新 id 追加并按 kind,id 排序', () => {
    const out = mergeIndexEntry(base, entry('a.pack', '1.0.0'), 'now');
    expect(out.packs.map((p) => `${p.kind}/${p.id}`)).toEqual(['dict-pack/a.pack', 'kojo-pack/a.pack', 'kojo-pack/b.pack']);
  });
  it('同 id 同 kind 更高版本 → 替换', () => {
    const out = mergeIndexEntry(base, entry('b.pack', '1.1.0'), 'now');
    expect(out.packs.find((p) => p.id === 'b.pack')!.version).toBe('1.1.0');
    expect(out.packs.length).toBe(2);
  });
  it('同 id 同 kind 更低/等版本 → 原样返回（不降级）', () => {
    expect(mergeIndexEntry(base, entry('b.pack', '0.9.0'), 'now')).toBe(base);
    expect(mergeIndexEntry(base, entry('b.pack', '1.0.0'), 'now')).toBe(base);
  });
  it('indexBytesExceeded：512KiB 闸', () => {
    expect(indexBytesExceeded({ schema: 1, generatedAt: 'x', packs: [] })).toBe(false);
    const big: MarketIndex = { schema: 1, generatedAt: 'x', packs: Array.from({ length: 2000 }, (_, i) => entry(`pack-${i}-` + 'x'.repeat(200), '1.0.0')) };
    expect(indexBytesExceeded(big)).toBe(true);
  });
});
