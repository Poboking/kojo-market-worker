import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { indexConflict } from '../src/verify';
import { packFilesProblem, parseManifest, type PackFileEntry, type PackManifest } from '../src/schema';
import { sha256Hex } from '../src/token';
import { goodManifest, packZip, withManifestFor, GOOD_FILES, verifyBytes } from './helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('golden：合法包通过', () => {
  it('小 zip（pack.json + files/ 几个文本文件）全绿，报告数字与容器摘要全对', async () => {
    const zip = await packZip(await goodManifest());
    const r = await verifyBytes(zip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('demo.worker');
    expect(r.report.fileCount).toBe(Object.keys(GOOD_FILES).length);
    expect(r.report.unpackedBytes).toBe(Object.values(GOOD_FILES).reduce((n, t) => n + enc(t).length, 0));
    expect(r.report.containerSha256).toBe(await sha256Hex(zip));
    expect(r.report.zipBytes).toBe(zip.length);
    expect(r.report.files.map((f) => f.path)).toEqual(['files/hello.txt', 'files/sub/deep.txt']);
  });

  it('zip 带目录条目 files/（其它打包工具常见）不拒', async () => {
    const zip = await packZip(await goodManifest(), { 'files/': new Uint8Array(0) });
    const r = await verifyBytes(zip);
    expect(r.ok).toBe(true);
  });
});

describe('golden：清单结构逐条被拒', () => {
  const rejects = async (manifestOverrides: Record<string, unknown>, extraEntries?: Record<string, Uint8Array>) => {
    const zip = await packZip(await goodManifest(manifestOverrides), extraEntries);
    const r = await verifyBytes(zip);
    expect(r.ok, `期望被拒：${JSON.stringify(manifestOverrides)}`).toBe(false);
    if (r.ok) return '';
    return r.rejected.code;
  };

  it('schema 版本不对 -> schema-version', async () => {
    expect(await rejects({ schema: 2 })).toBe('schema-version');
  });
  it('pack.json 缺失 -> manifest-missing', async () => {
    const zip = await packZip(await goodManifest());
    const r = await verifyBytes(zipSyncWithout(zip, 'pack.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('manifest-missing');
  });
  it('pack.json 坏 JSON -> manifest-json', async () => {
    const zip = await packZip(await goodManifest());
    const r = await verifyBytes(replaceEntry(zip, 'pack.json', enc('{ schema: 1,')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('manifest-json');
  });
  it('未知字段 -> manifest-shape（CI 同款硬闸）', async () => {
    expect(await rejects({ bonus: 'field' })).toBe('manifest-shape');
  });
  it('kind 未知 -> kind-unknown', async () => {
    expect(await rejects({ kind: 'mega-pack' })).toBe('kind-unknown');
  });
  it('id 形态坏（大写/超长/空）-> id-invalid', async () => {
    expect(await rejects({ id: 'Demo.Worker' })).toBe('id-invalid');
    expect(await rejects({ id: '-lead' })).toBe('id-invalid');
  });
  it('版本非三段 -> version-invalid', async () => {
    expect(await rejects({ version: '1.0' })).toBe('version-invalid');
    expect(await rejects({ version: 'v1.0.0' })).toBe('version-invalid');
  });
  it('minAppVersion 非三段 -> min-app-version-invalid', async () => {
    expect(await rejects({ minAppVersion: 'latest' })).toBe('min-app-version-invalid');
  });
  it('redistribute=false -> redistribute-denied（内容类硬闸）', async () => {
    expect(await rejects({ redistribute: false })).toBe('redistribute-denied');
  });
  it('sourceUrl 非 https -> manifest-shape', async () => {
    expect(await rejects({ sourceUrl: 'http://example.com/x' })).toBe('manifest-shape');
  });
});

describe('golden：路径与限额（纯函数面）', () => {
  it('path 越出 files/ -> path-prefix；穿越 ../ -> path-dotdot；反斜杠/绝对/盘符/空段各有其码', () => {
    const p = (path: string): PackFileEntry => ({ path, bytes: 1, sha256: 'a'.repeat(64) });
    expect(packFilesProblem([p('root.txt')])!.code).toBe('path-prefix');
    expect(packFilesProblem([p('files/../evil.txt')])!.code).toBe('path-dotdot');
    expect(packFilesProblem([p('files\\evil.txt')])!.code).toBe('path-backslash');
    expect(packFilesProblem([p('/files/evil.txt')])!.code).toBe('path-absolute');
    expect(packFilesProblem([p('C:files/evil.txt')])!.code).toBe('path-drive');
    expect(packFilesProblem([p('files//x.txt')])!.code).toBe('path-empty-segment');
    expect(packFilesProblem([p('files/' + 'd/'.repeat(12) + 'x.txt')])!.code).toBe('path-depth');
    expect(packFilesProblem([p('files/' + 'x'.repeat(600))])!.code).toBe('path-too-long');
  });
  it('重复路径 / 条数超限 / 字节超限 / 摘要形态 / 负字节 各有其码', () => {
    const good = (path: string): PackFileEntry => ({ path, bytes: 1, sha256: 'a'.repeat(64) });
    expect(packFilesProblem([good('files/a'), good('files/a')])!.code).toBe('entry-duplicate');
    expect(packFilesProblem(Array.from({ length: 5001 }, (_, i) => good(`files/f${i}`)))!.code).toBe('entries-limit');
    expect(packFilesProblem([{ ...good('files/big'), bytes: 128 * 1024 * 1024 + 1 }])!.code).toBe('bytes-limit');
    expect(packFilesProblem([{ path: 'files/a', bytes: 1, sha256: 'XYZ' }])!.code).toBe('entry-sha256');
    expect(packFilesProblem([{ ...good('files/a'), bytes: -1 }])!.code).toBe('entry-bytes');
    expect(packFilesProblem([{ ...good('files/a'), sha256: 'A'.repeat(64) }])!.code).toBe('entry-sha256');
  });
  it('parseManifest：files 元素未知字段拒', () => {
    const r = parseManifest({ ...(goodManifestSync() as unknown as Record<string, unknown>), files: [{ path: 'files/a', bytes: 1, sha256: 'a'.repeat(64), extra: 1 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('manifest-shape');
  });
  it('parseManifest：非对象/数组拒', () => {
    expect(parseManifest([1]).ok).toBe(false);
    expect(parseManifest(null).ok).toBe(false);
  });
});

describe('golden：zip 条目卫生（解压前，防穿越零容忍）', () => {
  it('zip 条目 ../ 穿越 -> path-dotdot', async () => {
    const m = await goodManifest();
    const zip = await packZip(m, { 'files/../evil.txt': enc('evil') });
    const r = await verifyBytes(zip);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('path-dotdot');
  });
  it('zip 条目反斜杠 / 绝对路径 / 盘符 各有其码', async () => {
    for (const [name, code] of [['files\\evil.txt', 'path-backslash'], ['/abs.txt', 'path-absolute'], ['C:evil.txt', 'path-drive']] as const) {
      const zip = await packZip(await goodManifest(), { [name]: enc('x') });
      const r = await verifyBytes(zip);
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.rejected.code, name).toBe(code);
    }
  });
});

describe('golden：内容双向对账', () => {
  it('zip 多文件未声明 -> entry-extra', async () => {
    const zip = await packZip(await withManifestFor({ 'files/hello.txt': GOOD_FILES['files/hello.txt']! }), {
      'files/stowaway.txt': enc('sneak'),
    });
    const r = await verifyBytes(zip);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('entry-extra');
  });
  it('清单声明了 zip 里没有 -> entry-missing', async () => {
    const m = await withManifestFor({ 'files/hello.txt': GOOD_FILES['files/hello.txt']!, 'files/ghost.txt': 'boo\n' });
    const zip = await packZip(m, {}, { 'files/hello.txt': GOOD_FILES['files/hello.txt']! });
    const r = await verifyBytes(zip);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('entry-missing');
  });
  it('bytes 与实际不符 -> entry-bytes；sha256 谎报不再由 Worker 重算（数据级对账推迟注册表 CI）', async () => {
    const base = await withManifestFor(GOOD_FILES);
    const lieBytes = { ...base, files: base.files.map((f) => (f.path === 'files/hello.txt' ? { ...f, bytes: 999 } : f)) };
    const r1 = await verifyBytes(await packZip(lieBytes));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.rejected.code).toBe('entry-bytes');

    // sha256 谎报：免费档 10ms CPU 线内不做逐文件重算（verify.ts 分层注释）——
    // Worker 只守形态闸（64 位 hex，parseManifest 内），内容真伪由注册表 CI（merge 后复核）+ 人工审核把守
    const lieSha = { ...base, files: base.files.map((f) => (f.path === 'files/hello.txt' ? { ...f, sha256: 'b'.repeat(64) } : f)) };
    const r2 = await verifyBytes(await packZip(lieSha));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
  });
  it('sha256 缺失（undefined 形态）-> entry-sha256', async () => {
    const m = await withManifestFor({ 'files/hello.txt': GOOD_FILES['files/hello.txt']! });
    (m.files[0] as unknown as Record<string, unknown>)['sha256'] = undefined;
    const r = await verifyBytes(await packZip(m));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('entry-sha256');
  });
});

describe('golden：容器层', () => {
  it('不是 zip -> zip-unreadable', async () => {
    const r = await verifyBytes(enc('this is not a zip at all........'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('zip-unreadable');
  });
  it('清单声明总字节超 128MiB -> bytes-limit（不解压）', async () => {
    const m = await goodManifest({
      files: [{ path: 'files/huge.bin', bytes: 128 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) }],
    });
    const r = await verifyBytes(await packZip(m));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejected.code).toBe('bytes-limit');
  });
});

describe('indexConflict（发布前注册表对账）', () => {
  const idx = {
    packs: [
      { kind: 'kojo-pack', id: 'demo.worker', version: '1.0.0' },
      { kind: 'dict-pack', id: 'other.dict', version: '2.0.0' },
    ],
  };
  it('同 id 异 kind -> id-kind-conflict', () => {
    expect(indexConflict(idx, { id: 'demo.worker', kind: 'dict-pack' } as never)?.code).toBe('id-kind-conflict');
  });
  it('同 id 同版本 -> version-published', () => {
    expect(indexConflict(idx, { id: 'demo.worker', kind: 'kojo-pack', version: '1.0.0' } as never)?.code).toBe('version-published');
  });
  it('同 id 新版本 -> 无冲突；无索引 -> 无冲突', () => {
    expect(indexConflict(idx, { id: 'demo.worker', kind: 'kojo-pack', version: '1.1.0' } as never)).toBeNull();
    expect(indexConflict(null, { id: 'demo.worker', kind: 'kojo-pack', version: '1.0.0' } as never)).toBeNull();
  });
});

/* ---- 小工具：不重建 zip 直接改/删条目（golden 用） ---- */

function replaceEntry(zip: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const all = unzipSync(zip) as Record<string, Uint8Array>;
  return zipSync({ ...all, [name]: data });
}

function zipSyncWithout(zip: Uint8Array, drop: string): Uint8Array {
  const all = unzipSync(zip) as Record<string, Uint8Array>;
  const { [drop]: _gone, ...rest } = all;
  return zipSync(rest);
}

/** 同步版 manifest（golden 纯函数面用，sha256 是占位不参与断言） */
function goodManifestSync(): PackManifest {
  return {
    schema: 1,
    kind: 'kojo-pack',
    id: 'demo.worker',
    version: '1.0.0',
    name: 'n',
    author: 'a',
    license: 'CC0-1.0',
    redistribute: true,
    minAppVersion: '0.4.0',
    files: [],
  };
}
