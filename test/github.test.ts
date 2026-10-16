import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishToRegistry, buildPrBody, GithubError, publishBranchOf, type FileContents } from '../src/github';
import { goodManifest, GOOD_FILES } from './helpers';
import type { VerifyReport } from '../src/verify';

const enc = (s: string) => new TextEncoder().encode(s);

const report: VerifyReport = {
  fileCount: 2,
  unpackedBytes: 18,
  containerSha256: 'c'.repeat(64),
  zipBytes: 300,
  files: [
    { path: 'files/hello.txt', bytes: 12, sha256: 'a'.repeat(64) },
    { path: 'files/sub/deep.txt', bytes: 6, sha256: 'b'.repeat(64) },
  ],
};

const CFG = { token: 'gh-token', repo: 'Poboking/kojo-market' };

/** 极简 GitHub API 路由桩：记录调用，按 method+url 前缀给响应 */
function stubGithub(routes: { match: (method: string, url: string) => boolean; respond: (req: RequestInfo, init?: RequestInit) => { status?: number; body: unknown } }[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (req: RequestInfo, init?: RequestInit) => {
    const method = (init?.method ?? 'GET') as string;
    const url = typeof req === 'string' ? req : (req as Request).url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const route = routes.find((r) => r.match(method, url));
    if (!route) return new Response('no route', { status: 500 });
    const out = route.respond(req, init);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe('publishToRegistry（GitHub API 层 mock）', () => {
  it('happy path：blobs→tree→commit→ref→PR 依次调用，PR 正文带校验报告，created=true', async () => {
    const { calls, fetchImpl } = stubGithub([
      { match: (m, u) => m === 'GET' && u.includes('/pulls?head='), respond: () => ({ body: [] }) },
      { match: (m, u) => m === 'GET' && u.endsWith('/repos/Poboking/kojo-market'), respond: () => ({ body: { default_branch: 'master' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/master'), respond: () => ({ body: { object: { sha: 'basesha' } } }) },
      { match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ status: 404, body: { message: 'Not Found' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/commits/basesha'), respond: () => ({ body: { tree: { sha: 'basetree' } } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/blobs'), respond: (_r, i) => ({ body: { sha: `blob-${JSON.parse(i!.body as string).content.length}` } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/trees'), respond: () => ({ body: { sha: 'newtree' } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/commits'), respond: () => ({ body: { sha: 'newcommit' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/refs/heads/publish/'), respond: () => ({ status: 404, body: { message: 'Not Found' } }) },
      { match: (m, u) => m === 'POST' && u.endsWith('/git/refs'), respond: () => ({ body: {} }) },
      { match: (m, u) => m === 'POST' && u.includes('/pulls') && !u.includes('?'), respond: () => ({ body: { html_url: 'https://github.com/Poboking/kojo-market/pull/7' } }) },
    ]);

    const manifest = await goodManifest();
    const contents: FileContents = {
      'packs/kojo-pack/demo.worker/1.0.0/pack.json': enc(JSON.stringify(manifest)),
      ...Object.fromEntries(report.files.map((f) => [`packs/kojo-pack/demo.worker/1.0.0/${f.path}`, enc('x')])),
    };
    const out = await publishToRegistry(CFG, manifest, report, contents, fetchImpl);
    expect(out).toEqual({ prUrl: 'https://github.com/Poboking/kojo-market/pull/7', branch: 'publish/demo.worker-1.0.0', created: true });

    const treeCall = calls.find((c) => c.url.includes('/git/trees'));
    expect(treeCall!.body).toMatchObject({ base_tree: 'basetree' });
    const paths = (treeCall!.body as { tree: { path: string }[] }).tree.map((t) => t.path).sort();
    expect(paths).toEqual([
      'packs/kojo-pack/demo.worker/1.0.0/files/hello.txt',
      'packs/kojo-pack/demo.worker/1.0.0/files/sub/deep.txt',
      'packs/kojo-pack/demo.worker/1.0.0/pack.json',
    ]);
    const prCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'));
    expect(prCall!.body).toMatchObject({ title: '发布：Worker 冒烟包 v1.0.0', head: 'publish/demo.worker-1.0.0', base: 'master' });
    expect((prCall!.body as { body: string }).body).toContain(`\`${'a'.repeat(64)}\``);
    expect((prCall!.body as { body: string }).body).toContain('校验报告');
    expect(calls.filter((c) => c.url.includes('/git/blobs')).length).toBe(3);
  });

  it('幂等：同分支已有 open PR → 直接返回，不 blobs/commit/refs 一步都不走', async () => {
    const { calls, fetchImpl } = stubGithub([
      {
        match: (m, u) => m === 'GET' && u.includes('/pulls?head='),
        respond: () => ({ body: [{ html_url: 'https://github.com/Poboking/kojo-market/pull/3', number: 3 }] }),
      },
    ]);
    const out = await publishToRegistry(CFG, await goodManifest(), report, {}, fetchImpl);
    expect(out).toEqual({ prUrl: 'https://github.com/Poboking/kojo-market/pull/3', branch: 'publish/demo.worker-1.0.0', created: false });
    expect(calls.length).toBe(1);
  });

  it('base 上已有同版本 → GithubError 409（重复发布闸）', async () => {
    const { fetchImpl } = stubGithub([
      { match: (m, u) => m === 'GET' && u.includes('/pulls?head='), respond: () => ({ body: [] }) },
      { match: (m, u) => m === 'GET' && u.endsWith('/repos/Poboking/kojo-market'), respond: () => ({ body: { default_branch: 'master' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/master'), respond: () => ({ body: { object: { sha: 'basesha' } } }) },
      { match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ body: { sha: 'exists' } }) },
    ]);
    await expect(publishToRegistry(CFG, await goodManifest(), report, {}, fetchImpl)).rejects.toMatchObject({
      name: 'GithubError',
      status: 409,
    });
  });

  it('分支已存在（旧 PR 被关未 merge）→ PATCH force 更新后再开 PR', async () => {
    const { calls, fetchImpl } = stubGithub([
      { match: (m, u) => m === 'GET' && u.includes('/pulls?head='), respond: () => ({ body: [] }) },
      { match: (m, u) => m === 'GET' && u.endsWith('/repos/Poboking/kojo-market'), respond: () => ({ body: { default_branch: 'master' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/master'), respond: () => ({ body: { object: { sha: 'basesha' } } }) },
      { match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ status: 404, body: {} }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/commits/basesha'), respond: () => ({ body: { tree: { sha: 'basetree' } } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/blobs'), respond: () => ({ body: { sha: 'b1' } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/trees'), respond: () => ({ body: { sha: 't1' } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/commits'), respond: () => ({ body: { sha: 'c1' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/refs/heads/publish/'), respond: () => ({ body: { object: { sha: 'old' } } }) },
      { match: (m, u) => m === 'PATCH' && u.includes('/git/refs/heads/publish/'), respond: () => ({ body: {} }) },
      { match: (m, u) => m === 'POST' && u.endsWith('/pulls'), respond: () => ({ body: { html_url: 'https://github.com/Poboking/kojo-market/pull/9' } }) },
    ]);
    const out = await publishToRegistry(CFG, await goodManifest(), report, {}, fetchImpl);
    expect(out.created).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ sha: 'c1', force: true });
  });

  it('422 竞态（PR 刚被开出）→ 复查按幂等返回', async () => {
    let pullCalls = 0;
    const { fetchImpl } = stubGithub([
      {
        match: (m, u) => m === 'GET' && u.includes('/pulls?head='),
        respond: () => ({ body: ++pullCalls === 2 ? [{ html_url: 'https://github.com/Poboking/kojo-market/pull/11', number: 11 }] : [] }),
      },
      { match: (m, u) => m === 'GET' && u.endsWith('/repos/Poboking/kojo-market'), respond: () => ({ body: { default_branch: 'master' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/ref/heads/master'), respond: () => ({ body: { object: { sha: 'basesha' } } }) },
      { match: (m, u) => m === 'GET' && u.includes('/contents/'), respond: () => ({ status: 404, body: {} }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/commits/basesha'), respond: () => ({ body: { tree: { sha: 'basetree' } } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/blobs'), respond: () => ({ body: { sha: 'b1' } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/trees'), respond: () => ({ body: { sha: 't1' } }) },
      { match: (m, u) => m === 'POST' && u.includes('/git/commits'), respond: () => ({ body: { sha: 'c1' } }) },
      { match: (m, u) => m === 'GET' && u.includes('/git/refs/heads/publish/'), respond: () => ({ status: 404, body: {} }) },
      { match: (m, u) => m === 'POST' && u.endsWith('/git/refs'), respond: () => ({ body: {} }) },
      { match: (m, u) => m === 'POST' && u.endsWith('/pulls'), respond: () => ({ status: 422, body: { message: 'A pull request already exists' } }) },
    ]);
    const out = await publishToRegistry(CFG, await goodManifest(), report, {}, fetchImpl);
    expect(out).toEqual({ prUrl: 'https://github.com/Poboking/kojo-market/pull/11', branch: 'publish/demo.worker-1.0.0', created: false });
  });

  it('非 404 的 ref 查询错误原样上抛（人话化在路由层做）', async () => {
    const { fetchImpl } = stubGithub([
      { match: (m, u) => m === 'GET' && u.includes('/pulls?head='), respond: () => ({ status: 401, body: { message: 'Bad credentials' } }) },
    ]);
    await expect(publishToRegistry(CFG, await goodManifest(), report, {}, fetchImpl)).rejects.toBeInstanceOf(GithubError);
  });
});

describe('纯函数', () => {
  it('publishBranchOf 形态固定', () => {
    expect(publishBranchOf({ id: 'demo.era-tw', version: '1.0.1' } as never)).toBe('publish/demo.era-tw-1.0.1');
  });
  it('buildPrBody 带逐文件 sha256 表', () => {
    const body = buildPrBody({ id: 'x', name: '包名', version: '1.0.0', kind: 'kojo-pack', author: 'a', license: 'CC0' } as never, report);
    expect(body).toContain('| `files/hello.txt` | 12 |');
    expect(body).toContain('c'.repeat(64));
    expect(body).toContain(GOOD_FILES['files/hello.txt']!.slice(0, 5));
  });
});
