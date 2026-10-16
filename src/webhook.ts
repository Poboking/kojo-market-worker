/**
 * PR merged webhook：验证 `X-Hub-Signature-256` → 解析 merge 的 publish 分支 →
 * R2 待审区归档（pending/ → packs/）→ 以 gh-pages 权威索引为基追加新条目镜像进 R2。
 * WEBHOOK_SECRET 未配置时整个端点 503（cron 兜底对账仍在跑，不丢功能只丢实时性）。
 */
import { compareVersions, MARKET_MAX_INDEX_BYTES, type MarketIndex, type MarketIndexEntry } from './schema';
import { timingSafeEqualStr } from './token';

/** `sha256=<hex hmac(WEBHOOK_SECRET, rawBody)>`，常数时间比较 */
export async function verifyWebhookSignature(secret: string, rawBody: Uint8Array, header: string | null): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody as BufferSource));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualStr(expected, header.slice('sha256='.length));
}

export interface MergedPublish {
  id: string;
  version: string;
}

/** 从 PR head ref 反解包身份：`publish/<id>-<version>`（version 严格三段、不含 `-`，贪婪前缀安全） */
export function parseMergedPublish(headRef: string | undefined): MergedPublish | null {
  const m = /^publish\/(.+)-(\d+\.\d+\.\d+)$/.exec(headRef ?? '');
  if (!m) return null;
  return { id: m[1]!, version: m[2]! };
}

/** 从 webhook payload 取「真的 merge 了」的 publish 分支；其余动作（closed 未 merge 等）返回 null */
export function extractMergedPublish(payload: unknown): MergedPublish | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['action'] !== 'closed') return null;
  const pr = p['pull_request'];
  if (pr === null || typeof pr !== 'object') return null;
  const head = (pr as Record<string, unknown>)['head'];
  const merged = (pr as Record<string, unknown>)['merged'];
  if (merged !== true || head === null || typeof head !== 'object') return null;
  return parseMergedPublish((head as Record<string, unknown>)['ref'] as string | undefined);
}

/**
 * 把新包条目合进索引镜像（基 = gh-pages 权威索引）：
 * 同 id 已有条目 ⇒ 版本更高的才替换；无 ⇒ 追加。最终按 kind, id 排序（CI 同序）。
 */
export function mergeIndexEntry(base: MarketIndex, entry: MarketIndexEntry, generatedAt: string): MarketIndex {
  // 只摘除同 id 同 kind 的旧条目（待替换）；同 id 异 kind 的条目是注册表自己的冲突，镜像不擅自动
  const packs = base.packs.filter((p) => p.id !== entry.id || p.kind !== entry.kind);
  const prev = base.packs.find((p) => p.id === entry.id && p.kind === entry.kind);
  if (prev && (compareVersions(entry.version, prev.version) ?? 0) <= 0) return base;
  packs.push(entry);
  packs.sort((a, b) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : 1));
  return { schema: 1, generatedAt, packs };
}

export const indexBytesExceeded = (index: MarketIndex): boolean => new TextEncoder().encode(JSON.stringify(index)).length > MARKET_MAX_INDEX_BYTES;
