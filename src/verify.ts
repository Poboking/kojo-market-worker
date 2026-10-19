/**
 * 发布校验主流程（免费档结构级）：zip 字节窗 → 结构化结果（校验报告 | 拒绝）。
 *
 * 判据链 = 容器体积闸（请求侧 Content-Length，95MB，见 index.ts）
 *        → 中央目录预扫（解压前：条数/路径卫生/重复/解压总量，见 zip.ts）
 *        → 清单结构（pack.json 局部解出后 parseManifest）
 *        → 清单 ↔ 中央目录 双向对账（path/bytes）。
 *
 * 分层取舍：逐文件 sha256 重算与容器内容哈希是 O(解压字节) 的 CPU 循环，免费档 10ms
 * 线内不可行——对账推迟到注册表仓 CI（merge 后复核）+ 人工审核。Worker 侧 sha256 只做
 * 形态闸（64 位 hex，parseManifest 内）与容器完整性锚（编辑器声明 + R2 落盘原生校验，
 * 见 index.ts），不做内容重算。
 * 与编辑器 `installFromIndex` 的对账语义同构：清单声明而容器没有 = 拒（entry-missing），
 * 容器有而清单没声明 = 拒（entry-extra）；根 pack.json 算元数据不算内容。
 */
import {
  MARKET_MANIFEST_FILE,
  parseManifest,
  type PackFileEntry,
  type PackManifest,
  type Rejected,
} from './schema';
import { containerGate, readEntryBytes, scanCentralDirectory, type ZipWindowReader } from './zip';
import { REJECT_TEXT } from './reject';

export interface VerifyReport {
  fileCount: number;
  unpackedBytes: number;
  /**
   * 容器（zip 本体）sha256。Worker 不重算——由编辑器侧计算、请求头声明、
   * R2 落盘时原生校验（详见 index.ts）；发布链只消费这个锚。
   */
  containerSha256: string;
  zipBytes: number;
  files: readonly PackFileEntry[];
}

export type VerifyResult =
  | { ok: true; manifest: PackManifest; manifestBytes: Uint8Array; report: VerifyReport }
  | { ok: false; rejected: Rejected };

const rejected = (code: Rejected['code'], detail?: string): { ok: false; rejected: Rejected } => ({
  ok: false,
  rejected: { code, detail, message: REJECT_TEXT[code] },
});

export async function verifyZipPack(
  reader: ZipWindowReader,
  zipBytes: number,
  containerSha256: string,
): Promise<VerifyResult> {
  // 第一段：中央目录预扫（不碰任何文件数据）
  const scan = await scanCentralDirectory(reader, zipBytes);
  if (!scan.ok) return rejected(scan.code, scan.detail);
  const gate = containerGate(scan.entries);
  if (gate !== null) return rejected(gate.code, gate.detail);

  // 第二段：只解出 pack.json 做清单对账
  const packEntry = scan.entries.find((e) => e.name === MARKET_MANIFEST_FILE);
  if (packEntry === undefined) return rejected('manifest-missing');
  const raw = await readEntryBytes(reader, packEntry, zipBytes);
  if (!raw.ok) return rejected(raw.code, raw.detail);
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder().decode(raw.data));
  } catch {
    return rejected('manifest-json');
  }
  const parsed = parseManifest(root);
  if (!parsed.ok) return rejected(parsed.code, parsed.detail);
  const manifest = parsed.manifest;

  // 双向对账（中央目录口径，不解压）：path 集合必须完全一致，bytes 必须逐条相等
  const byName = new Map(scan.entries.map((e) => [e.name, e] as const));
  for (const f of manifest.files) {
    const e = byName.get(f.path);
    if (e === undefined) return rejected('entry-missing', f.path);
    if (f.bytes !== e.usize) return rejected('entry-bytes', `${f.path}: 声明 ${f.bytes} 与实际 ${e.usize} 不符`);
  }
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const e of scan.entries) {
    if (e.name === MARKET_MANIFEST_FILE || e.name.endsWith('/')) continue;
    if (!declared.has(e.name)) return rejected('entry-extra', e.name);
  }

  const verified = [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    ok: true,
    manifest,
    // zip 内 pack.json 的原始字节：PR 树原样提交，注册表 hydrate 的字节级对账才成立
    manifestBytes: raw.data,
    report: {
      fileCount: verified.length,
      unpackedBytes: verified.reduce((n, f) => n + f.bytes, 0),
      containerSha256,
      zipBytes,
      files: verified,
    },
  };
}

/**
 * 发布前注册表对账（用 R2 缓存的索引；索引缺席时降级跳过，只记日志——
 * 查不了重复不该挡发布，CI merge 前还有一道 validate）。
 * 查两件事：同 id 异 kind（tag 碰撞不变量）、同 id+version 重复发布。
 */
export function indexConflict(index: { packs: readonly { kind: string; id: string; version: string }[] } | null, manifest: PackManifest): Rejected | null {
  if (!index) return null;
  for (const p of index.packs) {
    if (p.id !== manifest.id) continue;
    if (p.kind !== manifest.kind) return { code: 'id-kind-conflict', message: REJECT_TEXT['id-kind-conflict'], detail: `${p.id} 已按 ${p.kind} 收录` };
    if (p.version === manifest.version) return { code: 'version-published', message: REJECT_TEXT['version-published'], detail: `${p.id}@${p.version}` };
  }
  return null;
}
