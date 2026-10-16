/**
 * 发布校验主流程：zip 原始字节 → 结构化结果（校验报告 | 拒绝）。
 *
 * 判据链 = 容器卫生（解压前，见 zip.ts）→ 清单结构 → 内容双向对账 → 逐文件 sha256 重算。
 * 与编辑器 `installFromIndex` 的对账语义同构：清单声明而容器没有 = 拒（entry-missing），
 * 容器有而清单没声明 = 拒（entry-extra），根 pack.json 算元数据不算内容。
 */
import { MARKET_MANIFEST_FILE, parseManifest, type PackManifest, type PackFileEntry, type Rejected } from './schema';
import { containerGate, unzipFileEntries } from './zip';
import { sha256Hex } from './token';
import { REJECT_TEXT } from './reject';

const rejected = (code: Rejected['code'], detail?: string): { ok: false; rejected: Rejected } => ({
  ok: false,
  rejected: { code, detail, message: REJECT_TEXT[code] },
});

/** 校验报告（进 PR 正文与 R2 待审元数据） */
export interface VerifyReport {
  fileCount: number;
  unpackedBytes: number;
  /** 容器（zip 本体）整包 sha256 */
  containerSha256: string;
  zipBytes: number;
  /** 排序后的逐文件明细 */
  files: readonly PackFileEntry[];
}

export type VerifyResult = { ok: true; manifest: PackManifest; report: VerifyReport } | { ok: false; rejected: Rejected };

export async function verifyZipPack(bytes: Uint8Array): Promise<VerifyResult> {
  const gate = containerGate(bytes);
  if (gate) return rejected(gate.code, gate.detail);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipFileEntries(bytes);
  } catch (e) {
    // containerGate 已拦结构违例，这里只剩 fflate 层面的解压失败（加密/未知压缩方法/数据坏）
    return rejected('zip-unreadable', e instanceof Error ? e.message : String(e));
  }

  const manifestRaw = entries[MARKET_MANIFEST_FILE];
  if (manifestRaw === undefined) return rejected('manifest-missing');
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    return rejected('manifest-json');
  }
  const parsed = parseManifest(root);
  if (!parsed.ok) return rejected(parsed.code, parsed.detail);
  const manifest = parsed.manifest;

  // 双向对账：文件条目集合必须与清单声明完全一致（目录条目在 unzipFileEntries 已剔除）
  const declared = new Set(manifest.files.map((f) => f.path));
  const actual = new Set(Object.keys(entries).filter((n) => n !== MARKET_MANIFEST_FILE));
  for (const name of actual) if (!declared.has(name)) return rejected('entry-extra', name);
  for (const p of declared) if (!actual.has(p)) return rejected('entry-missing', p);

  // 逐文件：bytes 对平 + sha256 重算（防篡改闸）
  let unpacked = 0;
  const verified: PackFileEntry[] = [];
  for (const f of manifest.files) {
    const data = entries[f.path]!;
    if (data.length !== f.bytes) return rejected('entry-bytes', `${f.path}: 声明 ${f.bytes} != 实际 ${data.length}`);
    const actualHex = await sha256Hex(data);
    if (actualHex !== f.sha256) return rejected('entry-sha256', `${f.path}: 重算 ${actualHex} != 声明 ${f.sha256}`);
    unpacked += f.bytes;
    verified.push(f);
  }
  verified.sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    ok: true,
    manifest,
    report: {
      fileCount: verified.length,
      unpackedBytes: unpacked,
      containerSha256: await sha256Hex(bytes),
      zipBytes: bytes.length,
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
