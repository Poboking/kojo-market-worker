import { zipSync, type Zippable } from 'fflate';
import { sha256Hex } from '../src/token';
import type { PackManifest } from '../src/schema';
import { type ZipWindowReader } from '../src/zip';
import { verifyZipPack, type VerifyResult } from '../src/verify';

/** 合法样例的文件内容（小文本） */
export const GOOD_FILES: Record<string, string> = {
  'files/hello.txt': 'hello kojo\n',
  'files/sub/deep.txt': 'deeper\n',
};

/** 基础合法 manifest（files 的 sha256 由真实内容重算，别手抄） */
export async function goodManifest(overrides: Record<string, unknown> = {}): Promise<PackManifest> {
  const files = await Promise.all(
    Object.entries(GOOD_FILES).map(async ([p, text]) => ({ path: p, bytes: new TextEncoder().encode(text).length, sha256: await sha256Hex(new TextEncoder().encode(text)) })),
  );
  return {
    schema: 1,
    kind: 'kojo-pack',
    id: 'demo.worker',
    version: '1.0.0',
    name: 'Worker 冒烟包',
    author: 'tester',
    license: 'CC0-1.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files,
    ...overrides,
  } as PackManifest;
}

/** 打一个 zip：pack.json + files/**，可选附加/覆盖任意条目（含目录条目） */
export async function packZip(manifest: PackManifest, extraEntries: Record<string, Uint8Array> = {}, fileContents: Record<string, string> = GOOD_FILES): Promise<Uint8Array> {
  const entries: Zippable = {
    'pack.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    ...Object.fromEntries(Object.entries(fileContents).map(([p, t]) => [p, new TextEncoder().encode(t)])),
    ...extraEntries,
  };
  return zipSync(entries);
}

/** 改 manifest 的 files[] 并保持 sha256/bytes 与给定内容一致（专测“清单与内容对不上”类） */
export async function withManifestFor(files: Record<string, string>, overrides: Record<string, unknown> = {}): Promise<PackManifest> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([p, text]) => ({ path: p, bytes: new TextEncoder().encode(text).length, sha256: await sha256Hex(new TextEncoder().encode(text)) })),
  );
  return goodManifest({ ...overrides, files: entries });
}

/* ---- 免费档两段式校验的测试适配（生产侧读取器是 R2 range GET，见 index.ts） ---- */

/** 内存字节窗读取器：把 verifyZipPack 适配成「本地 zip」形态 */
export const bufferReader = (zip: Uint8Array): ZipWindowReader => async (start, end) => zip.subarray(start, end);

/** 与编辑器同口径：容器 sha256 由编辑器本地算好随上传声明（Worker 不重算，只做锚） */
export const verifyBytes = async (zip: Uint8Array, digest?: string): Promise<VerifyResult> =>
  verifyZipPack(bufferReader(zip), zip.length, digest ?? (await sha256Hex(zip)));
