/**
 * zip 容器解析（免费档结构级）。
 *
 * 分层理由：CF Workers 免费档每次调用只有 10ms CPU，对 99 MB 包体做全量解压、
 * 逐文件 sha256、逐字节扫描都必然超线。因此本模块只做两件事：
 *   1) 中央目录预扫：只读 EOCD + 中央目录（O(条目数) 而非 O(字节)），
 *      路径卫生 / 重复条目 / 条数与解压总量上限全部在此拦截；
 *   2) 局部解出：按需读单个条目的 local header + 压缩数据，只 inflate 这一个条目
 *      （发布链里只有 pack.json 需要解出做清单对账）。
 * 数据级完整性（逐文件 sha256 重算、容器内容哈希）推迟到注册表仓 CI（merge 后复核）
 * + 人工审核，Worker 只把结构闸守住。
 */
import { inflateSync } from 'fflate';
import {
  MARKET_MANIFEST_FILE,
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_UNPACKED_BYTES,
  pathProblem,
  type RejectCode,
} from './schema';

const U16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const U32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;

/** [start,end) 字节窗读取器：生产 = R2 range GET（只搬窗口字节）；测试 = 内存切片 */
export type ZipWindowReader = (start: number, end: number) => Promise<Uint8Array>;

/** 中央目录解析出的单条目（不解压内容，只留账目） */
export interface ZipEntry {
  name: string;
  method: number;
  /** 压缩后字节 */
  csize: number;
  /** 解压后字节 */
  usize: number;
  /** local header 起始偏移 */
  lho: number;
}

/**
 * pack.json 条目局部解出上限：5000 条目 × ~130B 的清单 ≈ 650KB，2MB 是宽松盖。
 * 没有它，恶意 zip 可以把 pack.json 的 csize 谎报到百 MB，range GET 直接吃满内存。
 */
const MAX_MANIFEST_ENTRY_BYTES = 2_000_000;
/**
 * 中央目录窗口上限：5000 条目 × (46 + 512B 名字 + 1KB 附加字段) ≈ 8MB。
 * 名字/附加字段理论上可以更长，但编辑器导出与注册表 CI 的 buildZip 都不产生这种形态。
 */
const MAX_CENTRAL_DIR_BYTES = 8_000_000;

export type ScanResult =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; code: RejectCode; detail: string };

/**
 * 中央目录预扫：EOCD → 中央目录 → 条目账目。
 * EOCD 向前扫描窗口 ≤ 64KB + 22B（注释上限），有界且只在尾部找 22 字节签名段，
 * 不属于对包体的逐字节循环。
 */
export async function scanCentralDirectory(reader: ZipWindowReader, zipBytes: number): Promise<ScanResult> {
  if (zipBytes < 22) return { ok: false, code: 'zip-unreadable', detail: '文件小于 EOCD 最小长度 22B：不是合法 ZIP' };
  const tailLen = Math.min(zipBytes, 22 + 0xffff);
  const tail = await reader(zipBytes - tailLen, zipBytes);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (U32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, code: 'zip-unreadable', detail: 'EOCD 未找到：不是合法 ZIP 或文件被截断' };
  const eocdAbs = zipBytes - tailLen + eocd;
  const count = U16(tail, eocd + 10);
  if (U16(tail, eocd + 8) !== count) return { ok: false, code: 'zip-unreadable', detail: '不支持多磁盘 ZIP' };
  if (U16(tail, eocd + 20) !== 0) return { ok: false, code: 'zip-unreadable', detail: 'ZIP 带注释，拒绝' };
  // 不追 zip64：免费档结构闸只收 16 位条目数内的常规 zip，zip64 形态直接拒
  if (count === 0xffff) return { ok: false, code: 'zip-unreadable', detail: 'ZIP64（条目数顶满 16 位）不支持' };
  if (count > MARKET_MAX_FILE_ENTRIES) {
    return { ok: false, code: 'entries-limit', detail: `ZIP 条目 ${count} 超过上限 ${MARKET_MAX_FILE_ENTRIES}` };
  }
  const cdSize = U32(tail, eocd + 12);
  const cdStart = U32(tail, eocd + 16);
  if (cdSize > MAX_CENTRAL_DIR_BYTES) {
    return { ok: false, code: 'zip-unreadable', detail: `中央目录 ${cdSize}B 超过窗口上限 ${MAX_CENTRAL_DIR_BYTES}B` };
  }
  if (cdStart + cdSize > eocdAbs || cdStart + cdSize > zipBytes) {
    return { ok: false, code: 'zip-unreadable', detail: '中央目录越界：EOCD 记录的偏移与体积不符' };
  }
  const cd = await reader(cdStart, cdStart + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || U32(cd, p) !== SIG_CENTRAL) {
      return { ok: false, code: 'zip-unreadable', detail: `中央目录第 ${n} 条签名不符` };
    }
    const flags = U16(cd, p + 8);
    const method = U16(cd, p + 10);
    const csize = U32(cd, p + 20);
    const usize = U32(cd, p + 24);
    const nlen = U16(cd, p + 28);
    const elen = U16(cd, p + 30);
    const clen = U16(cd, p + 32);
    const lho = U32(cd, p + 42);
    if (flags & FLAG_ENCRYPTED) return { ok: false, code: 'zip-unreadable', detail: `第 ${n} 条加密，不支持` };
    if (lho + 30 > zipBytes) return { ok: false, code: 'zip-unreadable', detail: `第 ${n} 条本地头越界` };
    // 名字一律按 UTF-8 解码：fflate 等常见打包器只对非 ASCII 名置 0x0800 旗标，
    // 按旗标拒会把全 ASCII 的合法包挡在门外；旗标闸由注册表 CI 的 release 资产把守。
    entries.push({ name: decoder.decode(cd.subarray(p + 46, p + 46 + nlen)), method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  if (p !== cd.length) return { ok: false, code: 'zip-unreadable', detail: '中央目录实际长度与 EOCD 声明不符' };
  return { ok: true, entries };
}

/**
 * 结构闸：重复条目、压缩方法、路径卫生、解压总量。纯函数，O(条目数)。
 * 路径卫生与编辑器 `installFromIndex`、注册表 CI `pathViolations` 三方同构。
 */
export function containerGate(entries: readonly ZipEntry[]): { code: RejectCode; detail: string } | null {
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) return { code: 'entry-duplicate', detail: e.name };
    seen.add(e.name);
    if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
      return { code: 'zip-unreadable', detail: `${e.name}: 不支持的压缩方法 ${e.method}` };
    }
    // 根 pack.json 是元数据不是内容，不按 files/ 语义判（CI 同款豁免）
    if (e.name === MARKET_MANIFEST_FILE) continue;
    const isDir = e.name.endsWith('/');
    const bad = pathProblem(isDir ? e.name.slice(0, -1) : e.name);
    if (bad !== null) {
      // 唯一豁免：根目录条目 `files/`（目录壳无内容风险，其它工具打的 zip 常见）。
      // `../`、盘符、反斜杠、绝对路径等目录条目照拒，零容忍。
      if (isDir && e.name === 'files/') continue;
      return { code: bad, detail: e.name };
    }
    total += e.usize;
    if (total > MARKET_MAX_UNPACKED_BYTES) {
      return { code: 'bytes-limit', detail: `解压后总计 ${total}B 超过上限 ${MARKET_MAX_UNPACKED_BYTES}` };
    }
  }
  return null;
}

export type EntryBytesResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; code: RejectCode; detail: string };

/**
 * 局部解出单个条目：读 local header（本地 nlen/elen 可能与中央目录不同，
 * 流式打包器会塞额外字段）→ 读压缩数据窗 → stored/deflate 按需解。
 * 解压用 `{ out }` 缓冲钉死在 usize——解压炸弹最多写到 usize 就被截断，不给 OOM 机会。
 */
export async function readEntryBytes(
  reader: ZipWindowReader,
  entry: ZipEntry,
  zipBytes: number,
): Promise<EntryBytesResult> {
  if (entry.usize > MAX_MANIFEST_ENTRY_BYTES) {
    return {
      ok: false,
      code: 'zip-unreadable',
      detail: `${entry.name}: 条目解压后 ${entry.usize}B 超过局部解出上限 ${MAX_MANIFEST_ENTRY_BYTES}B`,
    };
  }
  const lh = await reader(entry.lho, entry.lho + 30);
  if (U32(lh, 0) !== SIG_LOCAL) return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 本地头签名不符` };
  if (U16(lh, 8) !== entry.method) {
    return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 本地头与中央目录压缩方法不一致` };
  }
  if (U16(lh, 6) & FLAG_ENCRYPTED) return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 加密条目不支持` };
  const dataStart = entry.lho + 30 + U16(lh, 26) + U16(lh, 28);
  if (dataStart + entry.csize > zipBytes) {
    return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 条目数据越界` };
  }
  const comp = await reader(dataStart, dataStart + entry.csize);
  if (entry.method === METHOD_STORED) {
    if (comp.length !== entry.usize) {
      return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 存储条目长度与声明不符` };
    }
    return { ok: true, data: comp };
  }
  const out = new Uint8Array(entry.usize);
  try {
    inflateSync(comp, { out });
  } catch (e) {
    return { ok: false, code: 'zip-unreadable', detail: `${entry.name}: 解压失败（${e instanceof Error ? e.message : String(e)}）` };
  }
  // 声明 usize 与实际不符（多写截断 / 少写补零）都会在 JSON 解析处报 manifest-json，
  // 话术里的「导出被截断」正好覆盖这种形态，这里不再额外判。
  return { ok: true, data: out };
}
