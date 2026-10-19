/** Worker 入口：路由 + CORS + R2 待审区落盘 + PR 开具 + webhook/cron 对账。 */

import { MARKET_DEFAULT_INDEX_URL, MARKET_MAX_INDEX_BYTES, SHA256_HEX_RE, type MarketIndex, type MarketIndexEntry, type PackManifest } from './schema';
import { REJECT_TEXT } from './reject';
import { issueDeviceToken, verifyDeviceToken } from './token';
import { verifyZipPack, indexConflict } from './verify';
import { type ZipWindowReader } from './zip';
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
  // x-market-zip-sha256：包体 sha256 锚（编辑器本地计算、浏览器预检必须放行）
  'access-control-allow-headers': 'authorization, content-type, x-market-zip-sha256',
  'access-control-max-age': '86400',
} as const;

/**
 * 上传硬上限 = 95_000_000 字节（十进制 95 MB）。CF 免费档请求体边缘上限是
 * 100,000,000 字节：99MiB≈103,809,024 会被边缘直接 413（Worker 代码根本收不到），
 * 95_000_000 留 5MB 余量——余量越大，边缘 413 与本地拒因之间的空窗越窄。
 * 这与 MARKET_MAX_ZIP_BYTES（64 MiB，注册表 CI 给自己打的 release zip 的口径）无关。
 */
const MARKET_MAX_UPLOAD_BYTES = 95_000_000;

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

/**
 * 有界体流：R2 put 要求已知长度，请求的 Content-Length 已在闸门确认过。
 * Workers 运行时用 FixedLengthStream（超收/短读原生报错中止）；测试等非 Workers 环境
 * 退化为计数变换流——同一语义：实际字节一旦越过声明值立即报错，流式接收中止。
 */
function boundedBody(
  body: ReadableStream<Uint8Array>,
  declared: number,
): { readable: ReadableStream<Uint8Array>; done: Promise<void> } {
  if (typeof FixedLengthStream === 'function') {
    const fls = new FixedLengthStream(declared);
    return { readable: fls.readable, done: body.pipeTo(fls.writable) };
  }
  let total = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      total += chunk.byteLength;
      if (total > declared) throw new Error(`body exceeds declared content-length (>${declared})`);
      ctrl.enqueue(chunk);
    },
  });
  return { readable: counting.readable, done: body.pipeTo(counting.writable) };
}

/** R2 range GET 适配成 zip 字节窗读取器：结构校验只搬窗口字节，不做全量读取 */
const r2WindowReader = (bucket: R2Bucket, key: string): ZipWindowReader => async (start, end) => {
  const obj = await bucket.get(key, { range: { offset: start, length: end - start } });
  if (obj === null) throw new Error(`R2 对象读取失败（暂存可能已消失）: ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
};

async function handlePublish(req: Request, env: Env): Promise<Response> {
  const token = bearer(req);
  if (!token) return reject(401, 'token-invalid', '缺 Authorization: Bearer');
  const verdict = await verifyDeviceToken(env.DEVICE_TOKEN_SECRET, token);
  if (verdict !== 'ok') return reject(401, verdict);

  // 容器完整性锚：编辑器本地算好 sha256 放在请求头。Worker 对 95MB 包体不做任何哈希
  // 循环（免费档 10ms CPU），R2 put 拿它做原生校验——与实际不符直接抛错，零 JS CPU。
  const digest = req.headers.get('x-market-zip-sha256');
  if (!digest || !SHA256_HEX_RE.test(digest)) {
    return reject(400, 'container-digest', '缺 x-market-zip-sha256 头或形态不对');
  }

  // 体积闸第一道：Content-Length 必须在——免费档无法预判无声明长度的大包，分块传输直接拒
  const clHeader = req.headers.get('content-length');
  if (clHeader === null) return reject(411, 'length-required');
  const declared = Number(clHeader);
  if (!Number.isInteger(declared) || declared <= 0) return reject(400, 'zip-unreadable', 'Content-Length 形态不对');
  if (declared > MARKET_MAX_UPLOAD_BYTES) return reject(413, 'payload-too-large', `${declared} > ${MARKET_MAX_UPLOAD_BYTES}`);

  // 体积闸第二道：流式接收落 R2 暂存（中央目录在包尾，必须先有完整对象才能 range 校验）。
  // 实际字节越过声明值由 boundedBody 原生中止，不会白吃流量。
  const body = req.body;
  if (body === null) return reject(400, 'zip-unreadable', '请求体为空');
  const stagingKey = `pending/incoming/${crypto.randomUUID()}.zip`;
  const bounded = boundedBody(body, declared);
  try {
    await Promise.all([
      bounded.done,
      env.MARKET_BUCKET.put(stagingKey, bounded.readable, {
        httpMetadata: { contentType: 'application/zip' },
        sha256: digest, // R2 原生校验：与实际内容不符 → put 抛错
      }),
    ]);
  } catch (e) {
    console.error(`[r2] 暂存失败 key=${stagingKey}`, e);
    const msg = e instanceof Error ? e.message : String(e);
    // 错误文案来自运行时，尽力区分：校验值不符 / 收发不符 / 其它 IO
    if (/checksum|sha256/i.test(msg)) return reject(400, 'container-digest', '声明的 sha256 与实际包体不符');
    if (/fixed.?length|content.?length|exceed/i.test(msg)) {
      return reject(413, 'payload-too-large', '实际接收与声明的 Content-Length 不符');
    }
    return reject(502, 'r2-failed');
  }

  // 结构级两段校验：R2 range GET 只搬窗口字节（中央目录 ≤8MB + pack.json ≤2MB），
  // 不解压内容文件、不重算 sha256——数据级对账推迟到注册表 CI（merge 后复核）+ 人工审核
  const result = await verifyZipPack(r2WindowReader(env.MARKET_BUCKET, stagingKey), declared, digest);
  if (!result.ok) {
    await env.MARKET_BUCKET.delete(stagingKey);
    return reject(400, result.rejected.code, result.rejected.detail, result.rejected.code);
  }
  const { manifest, manifestBytes, report } = result;

  // 注册表对账（R2 索引缺席时降级跳过——CI merge 前还有一道 validate）
  const conflict = indexConflict(await loadIndex(env), manifest);
  if (conflict) {
    await env.MARKET_BUCKET.delete(stagingKey);
    return reject(409, conflict.code, conflict.detail, conflict.code);
  }

  // 暂存 → 待审区正名（R2 无 rename：get 流 → put 流，字节不经 JS 手）；
  // 先落盘再开 PR：webhook 归档要靠待审区有货
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
    const staged = await env.MARKET_BUCKET.get(stagingKey);
    if (staged === null) throw new Error(`暂存对象丢失 ${stagingKey}`);
    await env.MARKET_BUCKET.put(`${key}.zip`, staged.body, { httpMetadata: { contentType: 'application/zip' } });
    await env.MARKET_BUCKET.put(`${key}.json`, JSON.stringify(meta, null, 2), { httpMetadata: { contentType: 'application/json' } });
    await env.MARKET_BUCKET.delete(stagingKey);
  } catch (e) {
    console.error(`[r2] 待审区落盘失败 key=${key}`, e);
    return reject(502, 'r2-failed');
  }

  // GitHub PR：免费档 10ms CPU 不允许解压内容文件——PR 先带 pack.json + 校验报告
  // （含全量逐文件 sha256 声明表）供维护者审；明文树的内容补全（files/** 落库 +
  // 逐文件 sha256 对账）由注册表仓 CI 从 R2 待审 zip 复核完成。merge=放行不变。
  // pack.json 必须提交 zip 内原始字节（不重序列化）：注册表 hydrate 先做字节级对账，
  // 只有格式化差异时才回退语义比较；原样提交能让两道闸都走最快的路径。
  const repoPath = `packs/${manifest.kind}/${manifest.id}/${manifest.version}`;
  const contents: FileContents = {
    [`${repoPath}/pack.json`]: manifestBytes,
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
