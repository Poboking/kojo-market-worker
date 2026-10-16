/**
 * GitHub PR 开具——注册表仓 `packs/` 是**解包明文树**（packs/<kind>/<id>/<version>/pack.json + files/**），
 * zip 资产由注册表 CI 在 merge 后打成 GitHub Release（跟随现状，仓里不放 zip）。
 * 故本模块用 Git Data API 一次提交整树（blobs → tree → commit → ref），比逐文件
 * Contents API 少几十个请求；5 个文件以上 Contents API 就该退场了。
 */
import type { PackManifest } from './schema';
import type { VerifyReport } from './verify';

/** Worker 环境里 GitHub 侧的配置（bindings 名字定死） */
export interface GithubConfig {
  token: string;
  /** 形如 `Poboking/kojo-market` */
  repo: string;
}

export interface PublishOutcome {
  prUrl: string;
  branch: string;
  /** false = 命中幂等：同分支的 open PR 已存在，直接返回它的地址 */
  created: boolean;
}

/** 文件内容表（相对注册表仓根的 posix 路径 → 字节） */
export type FileContents = Readonly<Record<string, Uint8Array>>;

/** GitHub 侧失败（原文进日志，调用方转人话） */
export class GithubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`GitHub API ${status} @ ${endpoint}`);
    this.name = 'GithubError';
  }
}

type Fetchish = typeof fetch;

/** 全部 API 调用走这一个函数（测试里 stub 掉 globalThis.fetch 即可） */
async function gh<T>(cfg: GithubConfig, method: string, path: string, body?: unknown, fetchImpl: Fetchish = fetch): Promise<T> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'kojo-market-worker',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new GithubError(res.status, `${method} ${path}`, text);
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

/** PR 分支名：publish/<id>-<version>（webhook 侧从 ref 反解 id/version 也按这个形态） */
export const publishBranchOf = (manifest: PackManifest): string => `publish/${manifest.id}-${manifest.version}`;

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** PR 正文：校验报告（文件数、总字节、逐文件 sha256 表） */
export function buildPrBody(manifest: PackManifest, report: VerifyReport): string {
  const rows = report.files.map((f) => `| \`${f.path}\` | ${f.bytes} | \`${f.sha256}\` |`).join('\n');
  return [
    `## 校验报告（kojo-market-worker 自动出具）`,
    ``,
    `- 包：**${manifest.name}**（\`${manifest.kind}\`/\`${manifest.id}\` v${manifest.version}）`,
    `- 作者：${manifest.author}｜许可：${manifest.license}｜redistribute：${manifest.redistribute}`,
    `- 文件数：${report.fileCount}｜解压总字节：${report.unpackedBytes}｜容器：${report.zipBytes} B`,
    `- 容器整包 sha256：\`${report.containerSha256}\``,
    ``,
    `| path | bytes | sha256 |`,
    `|---|---|---|`,
    rows,
    ``,
    `> merge 本 PR 即放行：CI validate → 打 release zip 资产 → 推 gh-pages index.json。`,
    `> 待审 zip 在 R2 \`pending/\`；webhook / cron 会把它归档进 R2 \`packs/\` 并镜像索引。`,
  ].join('\n');
}

/**
 * 发布一个包到注册表仓并开 PR。
 * 幂等：同 head 分支已有 open PR ⇒ 直接返回该 PR 地址（不重复开）。
 */
export async function publishToRegistry(
  cfg: GithubConfig,
  manifest: PackManifest,
  report: VerifyReport,
  contents: FileContents,
  fetchImpl: Fetchish = fetch,
): Promise<PublishOutcome> {
  const branch = publishBranchOf(manifest);
  const [owner] = cfg.repo.split('/');

  // 幂等闸：同分支 open PR 在，就不再开第二张
  const open = await gh<{ html_url: string; number: number }[]>(
    cfg,
    'GET',
    `/repos/${cfg.repo}/pulls?head=${owner}:${branch}&state=open`,
    undefined,
    fetchImpl,
  );
  if (open.length > 0) return { prUrl: open[0]!.html_url, branch, created: false };

  const repo = await gh<{ default_branch: string }>(cfg, 'GET', `/repos/${cfg.repo}`, undefined, fetchImpl);
  const base = repo.default_branch;
  const baseRef = await gh<{ object: { sha: string } }>(cfg, 'GET', `/repos/${cfg.repo}/git/ref/heads/${base}`, undefined, fetchImpl);
  const baseSha = baseRef.object.sha;

  // base 上同版本已在 = 重复发布（bump version 才能再发）
  const dirPath = `packs/${manifest.kind}/${manifest.id}/${manifest.version}`;
  const exists = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/contents/${dirPath}/pack.json?ref=${baseSha}`, {
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/vnd.github+json', 'user-agent': 'kojo-market-worker' },
  });
  if (exists.ok) throw new GithubError(409, `GET contents/${dirPath}/pack.json`, 'base 分支已有该版本（重复发布）');

  const baseCommit = await gh<{ tree: { sha: string } }>(cfg, 'GET', `/repos/${cfg.repo}/git/commits/${baseSha}`, undefined, fetchImpl);

  // blobs → tree → commit（一次提交整树；Git Data API 单 blob 上限 100 MB，契约 128 MiB 是总量不是单文件）
  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const [path, bytes] of Object.entries(contents)) {
    const blob = await gh<{ sha: string }>(cfg, 'POST', `/repos/${cfg.repo}/git/blobs`, { content: b64(bytes), encoding: 'base64' }, fetchImpl);
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh<{ sha: string }>(
    cfg,
    'POST',
    `/repos/${cfg.repo}/git/trees`,
    { base_tree: baseCommit.tree.sha, tree },
    fetchImpl,
  );
  const commit = await gh<{ sha: string }>(
    cfg,
    'POST',
    `/repos/${cfg.repo}/git/commits`,
    {
      message: `发布：${manifest.name} v${manifest.version}（${manifest.kind}/${manifest.id}，worker 自动提交，待人工 merge）`,
      tree: newTree.sha,
      parents: [baseSha],
    },
    fetchImpl,
  );

  // ref：不存在则建，存在（此前 PR 被关未 merge）则强推到新 commit
  const refPath = `/repos/${cfg.repo}/git/refs/heads/${branch}`;
  let refOk = false;
  try {
    await gh(cfg, 'GET', refPath, undefined, fetchImpl);
    refOk = true;
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 404) throw e;
  }
  if (refOk) {
    await gh(cfg, 'PATCH', refPath, { sha: commit.sha, force: true }, fetchImpl);
  } else {
    await gh(cfg, 'POST', `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha }, fetchImpl);
  }

  // 开 PR；422 = 并发下 PR 刚被开出 ⇒ 查回来按幂等返回
  try {
    const pr = await gh<{ html_url: string }>(
      cfg,
      'POST',
      `/repos/${cfg.repo}/pulls`,
      { title: `发布：${manifest.name} v${manifest.version}`, head: branch, base, body: buildPrBody(manifest, report) },
      fetchImpl,
    );
    return { prUrl: pr.html_url, branch, created: true };
  } catch (e) {
    if (e instanceof GithubError && e.status === 422) {
      const reopen = await gh<{ html_url: string }[]>(cfg, 'GET', `/repos/${cfg.repo}/pulls?head=${owner}:${branch}&state=open`, undefined, fetchImpl);
      if (reopen.length > 0) return { prUrl: reopen[0]!.html_url, branch, created: false };
    }
    throw e;
  }
}
