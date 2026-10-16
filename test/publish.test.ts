/**
 * /publish 处理器级测试：免费档上传链的闸门（凭证 / Content-Length / 99MB / 摘要锚）
 * 与全链路 happy path（暂存 → 结构校验 → 待审区 → PR）。
 * R2 用内存假桶（支持 range 窗口），GitHub/gh-pages 出网全部打桩——零真网依赖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { goodManifest, packZip, withManifestFor, GOOD_FILES } from './helpers';
import { sha256Hex } from '../src/token';
import { MARKET_DEFAULT_INDEX_URL } from '../src/schema';

const enc = (s: string) => new TextEncoder().encode(s);

/** 内存 R2 假桶：put 收流、get 支持 range 窗口（结构校验只走窗口字节的关键依赖） */
function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  const consume = async (v: unknown): Promise<Uint8Array> => {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return new TextEncoder().encode(v); // R2 put 收 string 是合法形态
    if (v instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = v.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    }
    throw new Error(`假桶不支持的价值形态: ${typeof v}`);
  };
  const streamOf = (data: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
  return {
    store,
    async put(key: string, value: unknown, _opts?: { sha256?: string }) {
      const data = await consume(value);
      store.set(key, data);
      return { key, size: data.length, checksums: {} };
    },
    async get(key: string, opts?: { range?: { offset?: number; length?: number } }) {
      const data = store.get(key);
      if (data === undefined) return null;
      const offset = opts?.range?.offset ?? 0;
      const length = opts?.range?.length ?? data.length - offset;
      const slice = data.subarray(offset, offset + length);
      return {
        key,
        size: data.length,
        checksums: {},
        body: streamOf(slice),
        arrayBuffer: async () => slice.slice().buffer,
        text: async () => new TextDecoder().decode(slice),
        json: async () => JSON.parse(new TextDecoder().decode(slice)),
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(_opts?: unknown) {
      return { objects: [...store.keys()].map((key) => ({ key, size: store.get(key)!.length })) };
    },
  };
}
type FakeBucket = ReturnType<typeof fakeBucket>;

/** GitHub / gh-pages 出网桩：gh-pages 404（索引降级跳过）+ PR 开具全链路最小路由 */
function stubNet() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchMock = (async (req: RequestInfo, init?: RequestInit) => {
    const method = (init?.method ?? 'GET') as string;
    const url = typeof req === 'string' ? req : (req as Request).url;
    let body: unknown;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      /* 非字符串体不记账 */
    }
    calls.push({ method, url, body });
    if (url === MARKET_DEFAULT_INDEX_URL) return new Response('not found', { status: 404 });
    const routes: [boolean, { status?: number; body: unknown }][] = [
      [method === 'GET' && url.includes('/pulls?head='), { body: [] }],
      [method === 'GET' && url.endsWith('/repos/Poboking/kojo-market'), { body: { default_branch: 'master' } }],
      [method === 'GET' && url.includes('/git/ref/heads/master'), { body: { object: { sha: 'basesha' } } }],
      [method === 'GET' && url.includes('/contents/'), { status: 404, body: { message: 'Not Found' } }],
      [method === 'GET' && url.includes('/git/commits/basesha'), { body: { tree: { sha: 'basetree' } } }],
      [method === 'POST' && url.includes('/git/blobs'), { body: { sha: 'blob-1' } }],
      [method === 'POST' && url.includes('/git/trees'), { body: { sha: 'newtree' } }],
      [method === 'POST' && url.includes('/git/commits'), { body: { sha: 'newcommit' } }],
      [method === 'GET' && url.includes('/git/refs/heads/publish/'), { status: 404, body: { message: 'Not Found' } }],
      [method === 'POST' && url.endsWith('/git/refs'), { body: {} }],
      [method === 'POST' && url.includes('/pulls') && !url.includes('?'), { body: { html_url: 'https://github.com/Poboking/kojo-market/pull/42' } }],
    ];
    const hit = routes.find(([ok]) => ok);
    if (!hit) return new Response('no route', { status: 500 });
    return new Response(hit[1].body === undefined ? '' : JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const makeEnv = (bucket: FakeBucket = fakeBucket()): { env: Env; bucket: FakeBucket } => ({
  env: {
    MARKET_BUCKET: bucket as unknown as Env['MARKET_BUCKET'],
    GITHUB_TOKEN: 'gh-token',
    DEVICE_TOKEN_SECRET: 'test-secret',
  },
  bucket,
});

const getToken = async (env: Env): Promise<string> => {
  const res = await worker.fetch(new Request('https://worker.test/device-token', { method: 'POST' }), env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
};

/**
 * 手搭请求对象：显式控制 Content-Length 的有无（undici 对流式体会强制 chunked，
 * 测不了「声明长度 + 流式体」的闸门形态，这里按处理器实际消费面 duck-type）。
 */
const rawReq = (headers: Record<string, string>, body: Uint8Array | ReadableStream<Uint8Array> | null): Request => {
  const stream =
    body instanceof Uint8Array
      ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); } })
      : body;
  return {
    method: 'POST',
    url: 'https://worker.test/publish',
    headers: new Headers(headers),
    body: stream,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Request;
};

const codeOf = async (res: Response): Promise<string> => ((await res.json()) as { rejected: { code: string } }).rejected.code;
const storeHas = (bucket: FakeBucket, prefix: string): boolean => [...bucket.store.keys()].some((k) => k.startsWith(prefix));

afterEach(() => vi.unstubAllGlobals());

describe('/publish 处理器级（免费档上传链）', () => {
  it('缺设备凭证 -> 401', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(rawReq({ 'content-type': 'application/zip' }, enc('x')), env);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('token-invalid');
  });

  it('Content-Length 缺失（分块传输）-> 411 length-required，包体根本不接', async () => {
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest());
    const res = await worker.fetch(
      rawReq(
        { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'x-market-zip-sha256': await sha256Hex(zip) },
        zip, // 无 content-length 头
      ),
      env,
    );
    expect(res.status).toBe(411);
    expect(await codeOf(res)).toBe('length-required');
    expect(bucket.store.size).toBe(0);
  });

  it('Content-Length 超 99_000_000 -> 413 payload-too-large（本地闸先行拒因，不收包）', async () => {
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest());
    const res = await worker.fetch(
      rawReq(
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'x-market-zip-sha256': await sha256Hex(zip),
          'content-length': '99000001',
        },
        zip,
      ),
      env,
    );
    expect(res.status).toBe(413);
    expect(await codeOf(res)).toBe('payload-too-large');
    expect(bucket.store.size).toBe(0);
  });

  it('包体 sha256 锚缺失/形态不对 -> 400 container-digest', async () => {
    const { env } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest());
    const base = { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'content-length': String(zip.length) };
    const r1 = await worker.fetch(rawReq(base, zip), env);
    expect(r1.status).toBe(400);
    expect(await codeOf(r1)).toBe('container-digest');
    const r2 = await worker.fetch(rawReq({ ...base, 'x-market-zip-sha256': 'not-a-hash' }, zip), env);
    expect(r2.status).toBe(400);
    expect(await codeOf(r2)).toBe('container-digest');
  });

  it('happy path：暂存 → 结构校验 → 待审区正名 → PR 只带 pack.json', async () => {
    const calls = stubNet();
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest());
    const digest = await sha256Hex(zip);
    const res = await worker.fetch(
      rawReq(
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'content-length': String(zip.length),
          'x-market-zip-sha256': digest,
        },
        zip,
      ),
      env,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; prUrl: string; pendingKey: string };
    expect(out.ok).toBe(true);
    expect(out.prUrl).toContain('/pull/42');

    // 待审区：zip 内容原样 + 元数据带摘要锚；暂存清干净
    expect(out.pendingKey.startsWith('pending/demo.worker-1.0.0-')).toBe(true);
    expect([...bucket.store.get(`${out.pendingKey}.zip`)!]).toEqual([...zip]);
    const meta = JSON.parse(new TextDecoder().decode(bucket.store.get(`${out.pendingKey}.json`)!)) as {
      report: { containerSha256: string; zipBytes: number };
      indexEntry: { zip: { sha256: string } };
    };
    expect(meta.report.containerSha256).toBe(digest);
    expect(meta.report.zipBytes).toBe(zip.length);
    expect(meta.indexEntry.zip.sha256).toBe(digest);
    expect(storeHas(bucket, 'pending/incoming/')).toBe(false);

    // PR 只带 pack.json（明文树内容补全在注册表 CI，见 index.ts 注释）
    const treeCall = calls.find((c) => c.url.includes('/git/trees'));
    const paths = (treeCall!.body as { tree: { path: string }[] }).tree.map((t) => t.path).sort();
    expect(paths).toEqual(['packs/kojo-pack/demo.worker/1.0.0/pack.json']);
    expect(calls.filter((c) => c.url.includes('/git/blobs')).length).toBe(1);
  });

  it('中央目录穿越（zip 条目 ../）-> 400 path-dotdot，暂存清理', async () => {
    stubNet();
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest(), { 'files/../evil.txt': enc('evil') });
    const res = await worker.fetch(
      rawReq(
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'content-length': String(zip.length),
          'x-market-zip-sha256': await sha256Hex(zip),
        },
        zip,
      ),
      env,
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('path-dotdot');
    expect(bucket.store.size).toBe(0); // 暂存删净，待审区不落任何东西
  });

  it('pack.json 对账失败（bytes 谎报）-> 400 entry-bytes', async () => {
    stubNet();
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const base = await withManifestFor(GOOD_FILES);
    const lieBytes = { ...base, files: base.files.map((f) => (f.path === 'files/hello.txt' ? { ...f, bytes: 999 } : f)) };
    const zip = await packZip(lieBytes);
    const res = await worker.fetch(
      rawReq(
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'content-length': String(zip.length),
          'x-market-zip-sha256': await sha256Hex(zip),
        },
        zip,
      ),
      env,
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('entry-bytes');
    expect(bucket.store.size).toBe(0);
  });

  it('流式超收（实发超过声明 Content-Length）-> 413，暂存不落盘', async () => {
    const { env, bucket } = makeEnv();
    const token = await getToken(env);
    const zip = await packZip(await goodManifest());
    const res = await worker.fetch(
      rawReq(
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'content-length': String(zip.length - 5), // 声明比实际少 5 字节
          'x-market-zip-sha256': await sha256Hex(zip),
        },
        zip,
      ),
      env,
    );
    expect(res.status).toBe(413);
    expect(await codeOf(res)).toBe('payload-too-large');
    expect(bucket.store.size).toBe(0);
  });
});
