/** Worker 入口：路由 + CORS + R2 待审区落盘 + PR 开具 + webhook/cron 对账。 */

import { MARKET_DEFAULT_INDEX_URL, MARKET_MAX_INDEX_BYTES, MARKET_MAX_ZIP_BYTES, type MarketIndex, type MarketIndexEntry, type PackManifest } from './schema';
import { REJECT_TEXT } from './reject';
import { issueDeviceToken, verifyDeviceToken } from './token';
import { verifyZipPack, indexConflict } from './verify';
import { unzipFileEntries } from './zip';
import { publishToRegistry, type FileContents, GithubError } from './github';
import { extractMergedPublish, indexBytesExceeded, mergeIndexEntry, verifyWebhookSignature } from './webhook';

export interface Env {
  MARKET_BUCKET: R2Bucket;
  GITHUB_TOKEN: string;
  DEVICE_TOKEN_SECRET: string;
  /** 可选：不配则 /hook/pr-merged 返回 503（cron 兜底仍在） */
  WEBHOOK_SECRET?: string;
  GITHUB_REPO?: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
} as const;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

/** 结构化拒绝：作者只看 message（人话），code 只进日志与结构化字段 */
const reject = (status: number, code: keyof typeof REJECT_TEXT, detail?: string, extraLog?: unknown): Response => {
  console.error(`[reject] ${code}${detail ? ` detail=${detail}` : ''}${extraLog !== undefined ? ` extra=${JSON.stringify(extraLog)}` : ''}`);
  return json(status, { rejected: { code, message: REJECT_TEXT[code], ...(detail !== undefined ? { detail } : {}) } });
};

const bearer = (req: Request): string | null => {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
};

/** R2 索引缓存（miss 回源 gh-pages 权威并写回；回源失败给 null，调用方降级） */
async function loadIndex(env: Env): Promise<MarketIndex | null> {
  const hit = await env.MARKET_BUCKET.get('index.json');
  if (hit !== null) {
    try {
      return JSON.parse(await hit.text()) as MarketIndex;
    } catch {
      /* 缓存坏了走回源 */
    }
  }
  try {
    const res = await fetch(MARKET_DEFAULT_INDEX_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const idx = (await res.json()) as MarketIndex;
    if (idx?.schema === 1 && Array.isArray(idx.packs)) {
      await env.MARKET_BUCKET.put('index.json', JSON.stringify(idx), { httpMetadata: { contentType: 'application/json' } });
      return idx;
    }
  } catch {
    /* 出网失败 = 无索引可查 */
  }
  return null;
}

async function handlePublish(req: Request, env: Env): Promise<Response> {
  const token = bearer(req);
  if (!token) return reject(401, 'token-invalid', '缺 Authorization: Bearer');
  const verdict = await verifyDeviceToken(env.DEVICE_TOKEN_SECRET, token);
  if (verdict !== 'ok') return reject(401, verdict);

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return reject(400, 'zip-unreadable', '请求体为空');
  if (bytes.length > MARKET_MAX_ZIP_BYTES) return reject(413, 'payload-too-large', `${bytes.length} > ${MARKET_MAX_ZIP_BYTES}`);

  const result = await verifyZipPack(bytes);
  if (!result.ok) {
    return reject(400, result.rejected.code, result.rejected.detail, result.rejected.code);
  }
  const { manifest, report } = result;

  // 注册表对账（R2 索引缺席时降级跳过——CI merge 前还有一道 validate）
  const conflict = indexConflict(await loadIndex(env), manifest);
  if (conflict) return reject(409, conflict.code, conflict.detail, conflict.code);

  // 校验通过 → R2 待审区（zip + 元数据各一份）；先落盘再开 PR：webhook 归档要靠待审区有货
  const key = `pending/${manifest.id}-${manifest.version}-${Date.now()}`;
  const meta = {
    manifest,
    report,
    indexEntry: {
      kind: manifest.kind,
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      author: manifest.author,
      license: manifest.license,
      ...(manifest.summary !== undefined ? { summary: manifest.summary } : {}),
      minAppVersion: manifest.minAppVersion,
      ...(manifest.gameId !== undefined ? { gameId: manifest.gameId } : {}),
      ...(manifest.sourceUrl !== undefined ? { sourceUrl: manifest.sourceUrl } : {}),
      zip: { url: `https://github.com/${env.GITHUB_REPO}/releases/download/${manifest.id}-v${manifest.version}/${manifest.id}-${manifest.version}.zip`, sha256: report.containerSha256, bytes: report.zipBytes },
      fileCount: report.fileCount,
      unpackedBytes: report.unpackedBytes,
    } satisfies MarketIndexEntry,
    submittedAt: new Date().toISOString(),
  };
  try {
    await env.MARKET_BUCKET.put(`${key}.zip`, bytes, { httpMetadata: { contentType: 'application/zip' } });
    await env.MARKET_BUCKET.put(`${key}.json`, JSON.stringify(meta, null, 2), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) {
    console.error(`[r2] 写待审区失败 key=${key}`, e);
    return reject(502, 'r2-failed');
  }

  // GitHub PR：包内容以明文树形态进注册表仓（跟随现状，zip 资产由 CI 打 release），PR 由维护者网页 merge 放行
  const repoPath = `packs/${manifest.kind}/${manifest.id}/${manifest.version}`;
  const entries = unzipFileEntries(bytes);
  const contents: FileContents = {
    [`${repoPath}/pack.json`]: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'),
    ...Object.fromEntries(report.files.map((f) => [`${repoPath}/${f.path}`, entries[f.path]!] as const)),
  };

  try {
    const outcome = await publishToRegistry(
      { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO ?? 'Poboking/kojo-market' },
      manifest,
      report,
      contents,
    );
    console.log(`[publish] ${manifest.id}@${manifest.version} -> ${outcome.prUrl}${outcome.created ? '' : ' (idempotent)'}`);
    return json(200, { ok: true, prUrl: outcome.prUrl, pendingKey: key });
  } catch (e) {
    if (e instanceof GithubError) {
      console.error(`[github] ${e.endpoint}\n${e.body}`);
      return reject(502, 'github-failed', e.status === 409 ? '该版本已在注册表' : undefined, { status: e.status, endpoint: e.endpoint });
    }
    console.error('[github] 未知错误', e);
    return reject(502, 'github-failed');
  }
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    console.warn('[webhook] WEBHOOK_SECRET 未配置 -> 503（cron 兜底对账仍在）');
    return reject(503, 'internal', 'webhook 未启用');
  }
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, raw, req.headers.get('x-hub-signature-256')))) {
    return reject(401, 'token-invalid', 'webhook 签名不符');
  }
  const merged = extractMergedPublish(JSON.parse(new TextDecoder().decode(raw)));
  if (!merged) return json(200, { ok: true, skipped: '非 merge 的 publish PR，不处理' });

  // 待审区按 <id>-<version>- 前缀找（取时间戳最大的那份）
  const listing = await env.MARKET_BUCKET.list({ prefix: `pending/${merged.id}-${merged.version}-`, limit: 1000 });
  const zipKeys = listing.objects.filter((o) => o.key.endsWith('.zip')).map((o) => o.key).sort();
  const zipKey = zipKeys.at(-1);
  if (!zipKey) return reject(404, 'not-found', `待审区找不到 ${merged.id}-${merged.version}`);
  const metaKey = `${zipKey.slice(0, -'.zip'.length)}.json`;
  const metaObj = await env.MARKET_BUCKET.get(metaKey);
  if (metaObj === null) return reject(404, 'not-found', `待审元数据缺失 ${metaKey}`);
  const meta = (await metaObj.json()) as { indexEntry: MarketIndexEntry };

  // 归档：pending/ → packs/（zip 本体），元数据留在归档名下；待审区清干净
  const zipObj = await env.MARKET_BUCKET.get(zipKey);
  if (zipObj === null) return reject(404, 'not-found', `待审 zip 缺失 ${zipKey}`);
  await env.MARKET_BUCKET.put(`packs/${merged.id}-${merged.version}.zip`, zipObj.body, { httpMetadata: { contentType: 'application/zip' } });
  await env.MARKET_BUCKET.put(`packs/${merged.id}-${merged.version}.json`, JSON.stringify(meta, null, 2), { httpMetadata: { contentType: 'application/json' } });
  await env.MARKET_BUCKET.delete(zipKey);
  await env.MARKET_BUCKET.delete(metaKey);

  // 索引镜像：gh-pages 权威为基 + 新条目（CI 可能还没跑完，新条目先补上；cron 对账最终一致）
  const base = (await loadIndex(env)) ?? { schema: 1, generatedAt: new Date().toISOString(), packs: [] };
  const mergedIndex = mergeIndexEntry(base, meta.indexEntry, new Date().toISOString());
  if (indexBytesExceeded(mergedIndex)) {
    console.error('[webhook] 索引镜像超 512 KiB，不写回（注册表该减肥了）');
  } else {
    await env.MARKET_BUCKET.put('index.json', JSON.stringify(mergedIndex), { httpMetadata: { contentType: 'application/json' } });
  }
  console.log(`[webhook] ${merged.id}@${merged.version} 已归档并镜像索引`);
  return json(200, { ok: true, archived: `packs/${merged.id}-${merged.version}.zip` });
}

/** cron 兜底：gh-pages 权威索引 → R2（webhook 晚到/丢失时自愈） */
async function reconcileIndex(env: Env): Promise<void> {
  const res = await fetch(MARKET_DEFAULT_INDEX_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`gh-pages index 拉取 ${res.status}`);
  const idx = (await res.json()) as MarketIndex;
  const body = JSON.stringify(idx);
  if (new TextEncoder().encode(body).length > MARKET_MAX_INDEX_BYTES) {
    throw new Error('gh-pages index 超 512 KiB');
  }
  await env.MARKET_BUCKET.put('index.json', body, { httpMetadata: { contentType: 'application/json' } });
  console.log(`[cron] 索引已对账：${idx.packs.length} 条`);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/health' && req.method === 'GET') return json(200, { ok: true });
      if (path === '/device-token' && req.method === 'POST') return json(200, { token: await issueDeviceToken(env.DEVICE_TOKEN_SECRET) });
      if (path === '/publish' && req.method === 'POST') return await handlePublish(req, env);
      if (path === '/hook/pr-merged' && req.method === 'POST') return await handleWebhook(req, env);
      if (path === '/index.json') {
        if (req.method !== 'GET') return reject(405, 'method-not-allowed');
        const idx = await loadIndex(env);
        if (idx === null) return reject(502, 'internal', '索引暂不可用（源与缓存都拉不到）');
        return json(200, idx);
      }
      return reject(404, 'not-found', undefined, `${req.method} ${path}`);
    } catch (e) {
      console.error('[internal]', e);
      return reject(500, 'internal');
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await reconcileIndex(env);
  },
} satisfies ExportedHandler<Env>;

export type { PackManifest };
