import { gzipSync, gunzipSync } from 'node:zlib';

// 正文压缩存储（PLAN §13.3）。
//
// 为什么必须从 M0 就做：entry_contents 占全库体积 84%（实测 10 万条
// 时 2090MB/2480MB）。存储类型事后从 TEXT 改成 gzip BLOB，要把全部
// 历史正文重写一遍 —— 这是 §22.10 里标"返工成本极高"的一项。
//
// 压缩比实测 2.6×（中英混合真实文本）。不要用重复文本估，那会得到 130×。

/** 低于这个长度就不值得压缩（gzip 头本身约 20 字节） */
const MIN_COMPRESS_BYTES = 512;

/** gzip level 6：默认平衡点，实测与 level 9 在本项目文本上差距 < 2% */
const GZIP_LEVEL = 6;

export function packText(text: string | null | undefined): Uint8Array | null {
  if (text === null || text === undefined || text === '') return null;
  const buf = Buffer.from(text, 'utf8');
  // 短文本原样存，带一个 1 字节的"未压缩"标记前缀
  // 标记法比"试 gunzip 失败就当明文"更可靠，后者在二进制恰好是
  // 合法 gzip 时会误判。
  if (buf.length < MIN_COMPRESS_BYTES) {
    const out = new Uint8Array(buf.length + 1);
    out[0] = 0x00;
    out.set(buf, 1);
    return out;
  }
  const gz = gzipSync(buf, { level: GZIP_LEVEL });
  const out = new Uint8Array(gz.length + 1);
  out[0] = 0x01;
  out.set(gz, 1);
  return out;
}

export function unpackText(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 1) return null;
  const marker = blob[0];
  const body = blob.subarray(1);
  if (marker === 0x00) return Buffer.from(body).toString('utf8');
  if (marker === 0x01) return gunzipSync(body).toString('utf8');
  throw new Error(`未知的正文存储标记: 0x${marker?.toString(16)}`);
}

/** 统计用：返回压缩后体积与实际压缩比，供 doctor 报告 */
export function compressionStats(text: string): { raw: number; packed: number; ratio: number } {
  const packed = packText(text);
  const raw = Buffer.byteLength(text, 'utf8');
  const p = packed ? packed.length : 0;
  return { raw, packed: p, ratio: raw > 0 ? raw / p : 1 };
}
