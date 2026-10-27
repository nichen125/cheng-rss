// RSSHub 路由库的本地模型（PLAN §10）。
//
// 为什么要把上游的三个接口归一成这两种形状：
//   /api/namespace  → 路由清单（给关键词搜索用）
//   /api/radar/rules→ 域名映射（给 URL 反查用）
// 它们在语义上是两件事（"我能订阅什么" vs "这个网站怎么订阅"），
// 但下游都要走同一个"候选 → 参数表单 → 试订阅"的流程。
// 归一之后，搜索层不必知道候选来自哪一个接口。

/** 一条路由模板，如 `/bilibili/user/video/:uid` */
export interface RouteTemplate {
  /** 形如 `bilibili/user/video`，用于稳定标识 */
  key: string;
  /** 展示名，如「Bilibili 用户视频」 */
  title: string;
  /** 所属命名空间，如 `bilibili` */
  namespace: string;
  /** 路径模板，含 `:param` 占位 */
  path: string;
  /** 示例地址（相对 RSSHub 根），用来预填参数 */
  example: string | null;
  categories: string[];
  description: string;
  /**
   * 所属命名空间的中文说明。
   *
   * 为什么单独留一份而不是并进 `description`：用户搜「哔哩哔哩」时想找的是
   * bilibili 命名空间下的路由，而那个中文名只出现在 namespace 上，
   * 每条路由自己的 description 往往是「用户的视频投稿」这类短语。
   * 并进 description 会让界面显示一长串，单独存着只参与匹配。
   */
  namespaceDescription: string;
  /** 路径里出现的参数名，按顺序 */
  params: string[];
  /** 上游给的参数说明（可不全） */
  paramDocs: { name: string; description: string }[];
}

/** radar 规则：某域名可以用哪条路由订阅 */
export interface RadarRule {
  domain: string;
  title: string;
  /** 相对 RSSHub 根的路径；可能含 `:param` */
  path: string;
  docs: string | null;
}

export interface RouteLibrary {
  routes: RouteTemplate[];
  radar: RadarRule[];
  /** 拉取时间；0 表示从未成功拉过（只能用内置种子） */
  fetchedAt: number;
}

/** 参数名从路径模板里抠出来，顺序保持原样 */
export function paramsOf(path: string): string[] {
  const out: string[] = [];
  // 只认 `:name` 与 `:name?`（RSSHub 的可选参数写法）
  const re = /:([A-Za-z0-9_]+)\??/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 把参数填进模板。
 *
 * 未填的参数如何处置：
 *   · 模板里写 `:param?` → 整段删掉（含前面的斜杠）
 *   · 普通 `:param` 未填 → 保留占位符并返回 missing 列表，让前端提示
 *
 * 为什么不做"未填就填空字符串"：`/bilibili/user/video/` 会被 RSSHub 当成
 * 另一个路由（或直接 404），用户拿到的错误信息与真实原因无关。
 */
export function fillRoute(template: string, values: Record<string, string>): {
  url: string; missing: string[];
} {
  const missing: string[] = [];
  let out = template.replace(/\/:([A-Za-z0-9_]+)\?/g, (_all, name: string) => {
    const v = values[name];
    return v ? `/${encodeURIComponent(v)}` : '';
  });
  out = out.replace(/:([A-Za-z0-9_]+)/g, (_all, name: string) => {
    const v = values[name];
    if (!v) { missing.push(name); return `:${name}`; }
    return encodeURIComponent(v);
  });
  return { url: out, missing };
}

/**
 * 把相对路径拼成完整 RSSHub 地址。
 *
 * 一律 trim 尾部斜杠再把路径接上去 —— 用户配 `https://rsshub.app/` 与
 * `https://rsshub.app` 都应该得到 `https://rsshub.app/bilibili/...`，
 * 而不是 `https://rsshub.app//bilibili/...`（后者部分反代会 404）。
 */
export function joinRsshub(baseUrl: string, path: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/** 域名归一：去协议、去 `www.`、去路径与端口，小写 */
export function domainOf(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  return u.hostname.toLowerCase().replace(/^www\./, '') || null;
}

/**
 * 判断输入像不像一个 URL。
 *
 * 为什么不用 `new URL()` 一把梭：`bilibili` 这种裸词在 `new URL('https://bilibili')`
 * 下是合法的（hostname=bilibili），会被误判成网址，于是关键词搜索根本走不到。
 * 判据要求"含点且点后有 2 位以上的字母"，才能把单复数词排除掉。
 */
export function looksLikeUrl(raw: string): boolean {
  const s = (raw ?? '').trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/|$|:|\?)/.test(s);
}
