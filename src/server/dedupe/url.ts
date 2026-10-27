// URL 规范化（PLAN §7.1 L2 的第一层）。
//
// 为什么单独成模块：它有两个消费者，且两者的诉求微妙地不同
//   · 落库：entries.url_norm 判重（要稳定、要能进索引）
//   · 去重：判断"这是不是同一篇文章"（要能吃掉追踪参数）
// 放在一起是因为第二种只有在第一种正确的前提下才有意义 ——
// 若 url_norm 把 `?utm_source=x` 当成不同文章，去重层永远看不到重复。

/**
 * 追踪参数前缀/全名。命中即丢弃。
 *
 * 只列真正"不影响内容"的：utm_* 系列、广告点击 id、社交分享 id、
 * 以及各家自建的 source/from（这两个有争议，但实测大站都是纯追踪）。
 *
 * 刻意**不**丢的：
 *   · `p` / `id` / `page` / `article_id` —— 很多站用它们选文章
 *   · `s` / `t` / `q` —— 可能是搜索词，丢了两篇文章会被判成同一条
 */
const JUNK_PARAMS: RegExp[] = [
  /^utm_/,
  /^fbclid$/, /^gclid$/, /^dclid$/, /^msclkid$/, /^yclid$/, /^twclid$/,
  /^mc_cid$/, /^mc_eid$/, /^_hsenc$/, /^_hsmi$/, /^_hs/,
  /^igshid$/, /^ref$/, /^ref_src$/, /^ref_url$/, /^referrer$/,
  /^spm$/, /^share_/, /^from$/, /^source$/, /^hmsr$/, /^hmpl$/, /^hmcu$/, /^hmkw$/, /^hmci$/,
  /^vero_id$/, /^oly_enc_id$/, /^oly_anon_id$/, /^wickedid$/,
];

/**
 * 规范化。
 *
 * 处理的（每条都有真实站点踩过）：
 *   1. fragment —— `#section` 不改变内容
 *   2. 追踪参数 —— 同一篇文章被转发到微信/Twitter 后带一堆 utm
 *   3. host 大小写 —— `Example.COM` 与 `example.com` 是同一个站
 *   4. 默认端口 —— `:80` / `:443` 与省略时等价
 *   5. 末尾斜杠 —— `/a/` 与 `/a` 八成是同一页
 *
 * 不处理的：
 *   · http → https 统一：有些站两者返回不同内容（尤其老站），统一了反而误判
 *   · `www.` 去除：`www.x.com` 与 `x.com` 可能是两个不同的部署
 *   · 参数排序：改变顺序对某些站点有语义（少见但存在），保持原序
 */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  // URL 解析已经把默认端口吃掉了（http:80 / https:443），这里兜住非默认的写法
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    const lower = k.toLowerCase();
    if (JUNK_PARAMS.some((re) => re.test(lower))) continue;
    keep.push([k, v]);
  }
  if (keep.length === 0) {
    u.search = '';
  } else {
    const qs = new URLSearchParams();
    for (const [k, v] of keep) qs.append(k, v);
    u.search = qs.toString();
  }

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

/**
 * 判定"这两个地址是不是同一篇"。
 *
 * 与 canonicalUrl 的区别：这里把空路径与 `/` 视作相同
 * （`https://x.com` 与 `https://x.com/` 是同一页，规范化后一个是 `/`、另一个也是）。
 */
export function sameUrl(a: string, b: string): boolean {
  return canonicalUrl(a) === canonicalUrl(b);
}
