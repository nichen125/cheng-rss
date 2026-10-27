import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { unzipSync } from 'fflate';

// 静态资源访问层。
//
// 两条路径（PLAN §3.4）：
//   打包模式  从 SEA 的 assets 取出 client.zip，用 fflate 在内存里解压一次
//   源码模式  直接从 dist/client/ 读文件
//
// 为什么用 zip + 内存解压而不是 VFS：Node 24 的 SEA 没有 vfsArchive
// （那是 Node 26 的能力，写进 sea-config 会被静默忽略，blob 只有几百字节）。
// 实测解压 1ms，前端产物几十 KB，全驻留内存可接受。

export interface StaticAssets {
  /** 取文件内容；不存在返回 null */
  get(path: string): Uint8Array | null;
  /** 是否可用（目录或内嵌资源存在） */
  readonly ok: boolean;
  /** 来源描述，doctor 输出用 */
  readonly source: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// esbuild 在打包时把这里 define 成 true（见 scripts/build-server.mjs）
declare const __AI_RSS_SEA__: boolean | undefined;
const IS_SEA = typeof __AI_RSS_SEA__ === 'boolean' ? __AI_RSS_SEA__ : false;

/** 从项目根定位 dist/client */
function findClientDir(): string | null {
  // 源码模式：src/server/static.ts → ../../..
  const candidates = [
    resolve(process.cwd(), 'dist/client'),
    resolve(process.cwd(), '../dist/client'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

async function loadFromSea(): Promise<StaticAssets | null> {
  try {
    // node:sea 在源码模式下也可 import（isSea() 返回 false），
    // 但为了不在非 SEA 环境引入额外模块，这里用动态 import。
    const sea = await import('node:sea');
    if (!sea.isSea()) return null;
    const keys = sea.getAssetKeys();
    if (!keys.includes('client.zip')) return null;

    const zip = new Uint8Array(sea.getAsset('client.zip'));
    const files = unzipSync(zip);
    const map = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(files)) {
      const norm = k.replace(/^\.?\//, '');
      map.set(norm, v);
    }
    return {
      ok: true,
      source: `SEA assets/client.zip（${map.size} 个文件）`,
      get(path: string) {
        return map.get(path.replace(/^\/+/, '')) ?? null;
      },
    };
  } catch {
    return null;
  }
}

function loadFromDisk(dir: string): StaticAssets {
  const cache = new Map<string, Uint8Array>();

  function readSafe(rel: string): Uint8Array | null {
    // 路径穿越防护：normalize 后必须仍在 dir 内
    const target = resolve(dir, rel);
    const root = resolve(dir);
    if (!target.startsWith(root + '/') && target !== root && !target.startsWith(root + '\\')) {
      return null;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) return null;
    // index.html **不进缓存**。
    //
    // 它是唯一一个"文件名不变、内容会变"的产物：重新 build 之后 hash 变了，
    // 它里面的 <script src> 也跟着变。缓存住它，服务就永远发旧的 index，
    // 而旧 index 指向的 hash 文件已经被删 —— 浏览器加载不到 JS，白屏。
    // 开发时表现为"改完前端刷新还是白屏，非要重启服务"。
    // 带 hash 的资源可以放心缓存（同名必然同内容），index.html 只有 0.5KB。
    const cacheable = !/^index\.html$/i.test(rel);
    const hit = cache.get(target);
    if (hit && cacheable) return hit;
    const buf = new Uint8Array(readFileSync(target));
    if (cacheable) cache.set(target, buf);
    return buf;
  }

  return {
    ok: true,
    source: dir,
    get(rel: string) {
      const norm = normalize(rel).replace(/^[/\\]+/, '');
      if (norm.includes('..')) return null;
      return readSafe(norm);
    },
  };
}

let cached: StaticAssets | null = null;

export async function getStaticAssets(): Promise<StaticAssets> {
  if (cached) return cached;

  const fromSea = await loadFromSea();
  if (fromSea) {
    cached = fromSea;
    return cached;
  }

  const dir = findClientDir();
  if (dir) {
    cached = loadFromDisk(dir);
    return cached;
  }

  // 前端还没构建：返回一个空实现，由调用方决定是否给出提示页
  cached = {
    ok: false,
    source: IS_SEA ? 'SEA 内没有 client.zip' : 'dist/client 不存在（先运行 build:client）',
    get() { return null; },
  };
  return cached;
}

/** 测试用：清掉缓存，便于切换资源来源 */
export function resetStaticCache(): void {
  cached = null;
}

/** 供 doctor 报告：内嵌资源是否可用 */
export function assetSummary(a: StaticAssets): { available: boolean; source: string } {
  return { available: a.ok, source: a.source };
}

/** 取 index.html，供未构建时给出提示页 */
export function indexHtml(a: StaticAssets): Uint8Array | null {
  return a.get('index.html');
}

/** 判断路径是否像静态资源（有扩展名） */
export function looksLikeAsset(p: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(p);
}
