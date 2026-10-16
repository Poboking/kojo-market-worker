/**
 * 口上市场契约（KM-1）——Worker 侧独立对齐副本。
 *
 * schema 常量与类型逐字对齐唯一真源：kojo-editor `packages/plugin-api/src/market.ts`；
 * 判据同时对齐注册表仓 CI（`Poboking/kojo-market/scripts/market.mjs`）——那是维护者
 * merge 后真正放行的闸（redistribute 必须 true、未知字段拒、path ≤512 B、zip ≤64 MiB、
 * 同 id 取最高版本），PR 进去若过不了 CI 等于白开。
 *
 * 本仓与编辑器仓库零代码耦合：两仓只共享字节级契约，不互相 import。
 * 零游戏名词：市场只认"包"，包内容是什么游戏口径由消费者解释。
 */

/** 当前（也是唯一在用的）清单/索引 schema 版本 */
export const MARKET_SCHEMA_VERSION = 1;

/** 包种类（跨游戏通用：口上包 / 字典包 / 模板包） */
export type PackKind = 'kojo-pack' | 'dict-pack' | 'template-pack';

export const MARKET_PACK_KINDS: readonly PackKind[] = ['kojo-pack', 'dict-pack', 'template-pack'];

/** zip 根唯一的元数据文件名 */
export const MARKET_MANIFEST_FILE = 'pack.json';

/** 包内容一律住在这个子目录下（清单里的 path 恒以它开头） */
export const MARKET_CONTENT_DIR = 'files';

/** 硬限额（DoS 面）——与编辑器契约逐字同值 */
export const MARKET_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
export const MARKET_MAX_FILE_ENTRIES = 5000;
export const MARKET_MAX_PATH_DEPTH = 12;
export const MARKET_MAX_INDEX_BYTES = 512 * 1024;

/** 注册表 CI 口径：容器本体 ≤64 MiB、单条 path 的 UTF-8 字节数 ≤512（market.mjs 同值） */
export const MARKET_MAX_ZIP_BYTES = 64 * 1024 * 1024;
export const MARKET_MAX_PATH_BYTES = 512;

/** 包 id：小写、首字符字母数字、可含 `.` `_` `-`，总长 ≤ 64 */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 包版本：严格三段数字（不做宽松 semver，CI 与本地校验同一把尺） */
export const PACK_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** sha256 摘要字面形（64 位小写十六进制） */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 权威索引端点（GitHub Pages；GET /index.json 缓存 miss 时回源） */
export const MARKET_DEFAULT_INDEX_URL = 'https://poboking.github.io/kojo-market/index.json';

/* ------------------------------- schema ------------------------------- */

/** 包内单个文件条目。`path` = posix 相对路径，恒以 `files/` 开头 */
export interface PackFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** `pack.json` 的内容（zip 根 / 注册表仓版本目录各一份，同一 schema） */
export interface PackManifest {
  schema: 1;
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  /** 原作者是否许可代理分发。false ⇒ 编辑器本地装包一律拒，市场也不收 */
  redistribute: boolean;
  sourceUrl?: string;
  summary?: string;
  minAppVersion: string;
  gameId?: string;
  files: PackFileEntry[];
}

/** 注册表索引里的一条包（无逐文件明细；fileCount/unpackedBytes 是摘要） */
export interface MarketIndexEntry {
  kind: PackKind;
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  summary?: string;
  minAppVersion: string;
  gameId?: string;
  sourceUrl?: string;
  /** zip 本体：落点 + 校验锚（整包 sha256，与 pack.json 的逐文件锚两层并存） */
  zip: { url: string; sha256: string; bytes: number };
  fileCount: number;
  unpackedBytes: number;
}

export interface MarketIndex {
  schema: 1;
  /** ISO 时间串 */
  generatedAt: string;
  packs: MarketIndexEntry[];
}

/* ------------------------------- 拒绝码 ------------------------------- */

/**
 * 发布被拒的原因码：与编辑器 `MarketRejectCode` 同名的码同义（UI 按码分组呈现），
 * Worker 链路特有的码在后面追加段。机器码只进日志/结构化字段，作者只看人话。
 */
export type RejectCode =
  /* ---- 与编辑器契约同码同义 ---- */
  | 'manifest-missing'
  | 'manifest-json'
  | 'manifest-shape'
  | 'schema-version'
  | 'kind-unknown'
  | 'id-invalid'
  | 'id-kind-conflict'
  | 'version-invalid'
  | 'min-app-version-invalid'
  | 'redistribute-denied'
  | 'path-prefix'
  | 'path-absolute'
  | 'path-drive'
  | 'path-backslash'
  | 'path-dotdot'
  | 'path-empty-segment'
  | 'path-depth'
  | 'entry-duplicate'
  | 'entries-limit'
  | 'bytes-limit'
  | 'entry-bytes'
  | 'entry-sha256'
  | 'entry-missing'
  | 'entry-extra'
  /* ---- 发布链路特有 ---- */
  | 'path-too-long'
  | 'zip-unreadable'
  | 'zip-too-large'
  | 'payload-too-large'
  /** Worker 链路特有：请求没带 Content-Length（分块传输），免费档无法预判体积，直接拒 */
  | 'length-required'
  /** Worker 链路特有：包体 sha256 锚缺失/形态不对/与实际不符（编辑器声明 + R2 原生校验） */
  | 'container-digest'
  | 'token-invalid'
  | 'token-expired'
  | 'version-published'
  | 'r2-failed'
  | 'github-failed'
  | 'not-found'
  | 'method-not-allowed'
  | 'internal';

/** 一次校验拒绝（code 给机器，message 给作者） */
export interface Rejected {
  code: RejectCode;
  message: string;
  detail?: string;
}

/* ----------------------------- 纯校验函数 ----------------------------- */

const utf8 = new TextEncoder();

/**
 * 单个路径的非法形态；合法返回 null。清单条目与 zip 条目共用同一把尺
 * （判据 = 编辑器 `packEntryPathProblem` + 注册表 CI 的 512 B 长度闸）。
 */
export function pathProblem(path: unknown): RejectCode | null {
  if (typeof path !== 'string' || path.length === 0) return 'path-empty-segment';
  if (utf8.encode(path).length > MARKET_MAX_PATH_BYTES) return 'path-too-long';
  if (/^[A-Za-z]:/.test(path)) return 'path-drive';
  if (path.includes('\\')) return 'path-backslash';
  if (path.startsWith('/')) return 'path-absolute';
  const segments = path.split('/');
  // 空段与 `.` 段都算"路径里掺了非成分"——两种写法都会让解压端对同一份清单给出两种树
  if (segments.some((s) => s.length === 0 || s === '.')) return 'path-empty-segment';
  if (segments.some((s) => s === '..')) return 'path-dotdot';
  if (segments[0] !== MARKET_CONTENT_DIR) return 'path-prefix';
  // 必须在 files/ 之内（裸 `files` 是目录不是文件），且段数含 `files` 本身不超限
  if (segments.length < 2) return 'path-prefix';
  if (segments.length > MARKET_MAX_PATH_DEPTH) return 'path-depth';
  return null;
}

/** 逐条核路径 + 去重 + bytes/sha256 形 + 总字节；返回首个问题（首个即拒，不收集全部） */
export function packFilesProblem(files: readonly PackFileEntry[]): { code: RejectCode; detail: string } | null {
  if (!Array.isArray(files)) return { code: 'manifest-shape', detail: 'files 必须是数组' };
  if (files.length > MARKET_MAX_FILE_ENTRIES) {
    return { code: 'entries-limit', detail: String(files.length) };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (f === null || typeof f !== 'object') return { code: 'manifest-shape', detail: 'files 元素必须是对象' };
    if (Object.keys(f).some((k) => k !== 'path' && k !== 'bytes' && k !== 'sha256')) {
      return { code: 'manifest-shape', detail: `files 元素含未知字段：${Object.keys(f).join(',')}` };
    }
    const p = pathProblem(f.path);
    if (p !== null) return { code: p, detail: String(f.path) };
    if (seen.has(f.path)) return { code: 'entry-duplicate', detail: f.path };
    seen.add(f.path);
    if (!Number.isInteger(f.bytes) || f.bytes < 0) return { code: 'entry-bytes', detail: f.path };
    if (typeof f.sha256 !== 'string' || !SHA256_HEX_RE.test(f.sha256)) return { code: 'entry-sha256', detail: f.path };
    total += f.bytes;
    if (total > MARKET_MAX_UNPACKED_BYTES) {
      return { code: 'bytes-limit', detail: `${total} > ${MARKET_MAX_UNPACKED_BYTES}` };
    }
  }
  return null;
}

/** 三段数字版本逐段比较：a<b → -1，a>b → 1，等 ⇒ 0；段形非法返回 null */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = a.split('.');
  const y = b.split('.');
  if (x.length !== 3 || y.length !== 3) return null;
  for (let i = 0; i < 3; i++) {
    if (!/^\d{1,9}$/.test(x[i]!) || !/^\d{1,9}$/.test(y[i]!)) return null;
    const d = Number(x[i]) - Number(y[i]);
    if (d < 0) return -1;
    if (d > 0) return 1;
  }
  return 0;
}

/** manifest 必填键 / 可选键（CI 口径：契约外的键不许进 pack.json） */
const REQUIRED_KEYS = ['schema', 'kind', 'id', 'version', 'name', 'author', 'license', 'redistribute', 'minAppVersion', 'files'] as const;
const OPTIONAL_KEYS = ['sourceUrl', 'summary', 'gameId'] as const;

/**
 * `pack.json` 结构与字段的完整校验（不碰内容对账——那是 verify.ts 的事）。
 * 返回强类型的 manifest；非法返回拒绝。
 */
export function parseManifest(root: unknown): { ok: true; manifest: PackManifest } | { ok: false; code: RejectCode; detail: string } {
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, code: 'manifest-shape', detail: 'pack.json 必须是 JSON 对象' };
  }
  const m = root as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    if (!REQUIRED_KEYS.includes(k as never) && !OPTIONAL_KEYS.includes(k as never)) {
      return { ok: false, code: 'manifest-shape', detail: `未知字段 ${k}（契约外的键不许进 pack.json）` };
    }
  }
  if (m['schema'] !== MARKET_SCHEMA_VERSION) {
    return { ok: false, code: 'schema-version', detail: `schema 必须为 ${MARKET_SCHEMA_VERSION}（实际 ${JSON.stringify(m['schema'])}）` };
  }
  for (const k of ['kind', 'id', 'version', 'name', 'author', 'license', 'minAppVersion']) {
    if (typeof m[k] !== 'string' || (m[k] as string).length === 0) {
      return { ok: false, code: 'manifest-shape', detail: `${k}: 必须是非空字符串` };
    }
  }
  if (!MARKET_PACK_KINDS.includes(m['kind'] as PackKind)) {
    return { ok: false, code: 'kind-unknown', detail: `kind 必须是 ${MARKET_PACK_KINDS.join(' | ')}` };
  }
  if (!PACK_ID_RE.test(m['id'] as string)) return { ok: false, code: 'id-invalid', detail: String(m['id']) };
  if (!PACK_VERSION_RE.test(m['version'] as string)) return { ok: false, code: 'version-invalid', detail: String(m['version']) };
  if (!PACK_VERSION_RE.test(m['minAppVersion'] as string)) {
    return { ok: false, code: 'min-app-version-invalid', detail: String(m['minAppVersion']) };
  }
  // CI 同款硬闸：原作者不许可代理分发的内容，市场不收（编辑器侧本来也装不了）
  if (m['redistribute'] !== true) {
    return { ok: false, code: 'redistribute-denied', detail: `redistribute 必须为 true（当前 ${JSON.stringify(m['redistribute'])}）` };
  }
  for (const k of OPTIONAL_KEYS) {
    if (m[k] !== undefined && (typeof m[k] !== 'string' || (m[k] as string).length === 0)) {
      return { ok: false, code: 'manifest-shape', detail: `${k}: 可选，给了就必须是非空字符串` };
    }
  }
  if (typeof m['sourceUrl'] === 'string' && !/^https:\/\/\S+$/.test(m['sourceUrl'])) {
    return { ok: false, code: 'manifest-shape', detail: 'sourceUrl 必须是 https:// 绝对 URL' };
  }
  const filesProblem = packFilesProblem(m['files'] as PackFileEntry[]);
  if (filesProblem) return { ok: false, code: filesProblem.code, detail: filesProblem.detail };
  return {
    ok: true,
    manifest: {
      schema: 1,
      kind: m['kind'] as PackKind,
      id: m['id'] as string,
      version: m['version'] as string,
      name: m['name'] as string,
      author: m['author'] as string,
      license: m['license'] as string,
      redistribute: true,
      ...(m['sourceUrl'] !== undefined ? { sourceUrl: m['sourceUrl'] as string } : {}),
      ...(m['summary'] !== undefined ? { summary: m['summary'] as string } : {}),
      minAppVersion: m['minAppVersion'] as string,
      ...(m['gameId'] !== undefined ? { gameId: m['gameId'] as string } : {}),
      files: (m['files'] as PackFileEntry[]).map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    },
  };
}
