/**
 * zip 容器解析。选型 fflate：纯 JS 零依赖（不碰 Node API，Workers 原生可跑）、
 * unzipSync 单次内存展开——publish 链本来就要全量缓冲做逐文件 sha256 对账，
 * 流式无收益反而多两份拷贝；体量 ~8 KB，维护活跃（unzipper 依赖 Node stream，jszip 老旧慢）。
 *
 * 防穿越零容忍发生在**解压之前**：先手扫中央目录拿条目名与解压后字节数，
 * 路径卫生不过关或总字节超限直接拒——恶意 zip 根本不给 inflate 的机会（防 zip 炸弹 OOM）。
 */
import { unzipSync } from 'fflate';
import {
  MARKET_MANIFEST_FILE,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_MAX_ZIP_BYTES,
  pathProblem,
  type RejectCode,
} from './schema';

const U32 = (b: Uint8Array, p: number): number => (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
const U16 = (b: Uint8Array, p: number): number => b[p]! | (b[p + 1]! << 8);
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/** 中央目录预扫：拿 { name, unpackedBytes } 列表；结构不合法返回错误码 */
export function scanCentralDirectory(
  bytes: Uint8Array,
): { ok: true; entries: readonly { name: string; unpackedBytes: number }[] } | { ok: false; code: RejectCode; detail: string } {
  // EOCD 从尾部向前扫（窗口 = 22 字节固定段 + ≤65535 注释），取第一个命中
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (U32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, code: 'zip-unreadable', detail: 'EOCD 未找到：不是合法 ZIP 或被截断' };
  const count = U16(bytes, eocd + 10);
  if (U16(bytes, eocd + 8) !== count) return { ok: false, code: 'zip-unreadable', detail: '不支持多磁盘 ZIP' };
  if (U16(bytes, eocd + 20) !== 0) return { ok: false, code: 'zip-unreadable', detail: 'ZIP 带注释，拒绝' };
  if (count === 0xffff) return { ok: false, code: 'zip-unreadable', detail: 'ZIP64 不支持（条目数超 16 位门槛）' };
  if (count > MARKET_MAX_FILE_ENTRIES) return { ok: false, code: 'entries-limit', detail: `ZIP 条目 ${count} > ${MARKET_MAX_FILE_ENTRIES}` };

  const entries: { name: string; unpackedBytes: number }[] = [];
  let p = U32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || U32(bytes, p) !== SIG_CENTRAL) {
      return { ok: false, code: 'zip-unreadable', detail: `中央目录第 ${n} 条签名不符` };
    }
    const nlen = U16(bytes, p + 28);
    const elen = U16(bytes, p + 30);
    const clen = U16(bytes, p + 32);
    entries.push({ name: decoder.decode(bytes.subarray(p + 46, p + 46 + nlen)), unpackedBytes: U32(bytes, p + 24) });
    p += 46 + nlen + elen + clen;
  }
  return { ok: true, entries };
}

/**
 * 容器卫生总闸（解压前）：体积上限 + 条目上限 + 总解压字节上限 + 逐条路径卫生（防穿越）。
 * 全绿才允许进入 fflate 解压。
 */
export function containerGate(bytes: Uint8Array): { code: RejectCode; detail: string } | null {
  if (bytes.length > MARKET_MAX_ZIP_BYTES) return { code: 'zip-too-large', detail: `${bytes.length} > ${MARKET_MAX_ZIP_BYTES}` };
  const scan = scanCentralDirectory(bytes);
  if (!scan.ok) return { code: scan.code, detail: scan.detail };
  let total = 0;
  for (const e of scan.entries) {
    // 根 pack.json 是元数据不是内容，不按 files/ 语义判（CI 同款豁免）
    if (e.name === MARKET_MANIFEST_FILE) continue;
    const isDir = e.name.endsWith('/');
    const bad = pathProblem(isDir ? e.name.slice(0, -1) : e.name);
    if (bad !== null) {
      // 唯一豁免：根目录条目 `files/`（去尾后裸 `files` 触发 path-prefix；目录壳无内容风险，
      // 其它工具打的 zip 常见）。`../`、盘符、反斜杠、绝对路径等目录条目照拒，零容忍。
      if (isDir && e.name === 'files/') continue;
      return { code: bad, detail: e.name };
    }
    total += e.unpackedBytes;
    if (total > MARKET_MAX_UNPACKED_BYTES) {
      return { code: 'bytes-limit', detail: `${total} > ${MARKET_MAX_UNPACKED_BYTES}` };
    }
  }
  return null;
}

/**
 * 解出文件条目（目录条目剔除，fflate 对目录条目给的名字以 / 结尾）。
 * 调用方必须已过 containerGate。
 */
export function unzipFileEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  const all = unzipSync(bytes);
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(all)) {
    if (!name.endsWith('/')) files[name] = data;
  }
  return files;
}
