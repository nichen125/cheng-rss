import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { enqueue } from '../jobs/queue.ts';
import { packText } from '../db/text-blob.ts';
import { indexEntry } from '../search/index.ts';
import { contentHash, type UpsertStats } from './fetch.ts';
import { sanitizeHtml } from './sanitize.ts';
import { htmlToText, type ParsedFeed } from './parse.ts';
import { MIN_FEED_CHARS } from '../extract/article.ts';
import { estimateWordCount } from '../extract/article.ts';
import { canonicalUrl, findDuplicate, ensureLocalVector } from '../dedupe/index.ts';
// 订阅源与条目的持久化。
//
// 与路由分开的理由：抓取（job handler）与 HTTP 请求都要用同一套写入逻辑。
// 写入规则集中在 upsertItems 一处，避免"手动刷新"和"定时抓取"写出两种数据。

export type FeedStatus = 'active' | 'paused' | 'broken';

export interface FeedRow {
  id: string;
  user_id: string;
  folder_id: string | null;
  url: string;
  site_url: string | null;
  title: string | null;
  icon_url: string | null;
  fetch_interval: number;
  last_fetched_at: number | null;
  next_fetch_at: number | null;
  etag: string | null;
  last_modified: string | null;
  error_count: number;
  status: FeedStatus;
  source_kind: string;
}

/** 新建订阅时的默认抓取间隔：30 分钟。多数个人订阅源更新频率远低于此 */
export const DEFAULT_INTERVAL = 1800;

/**
 * 退避曲线上的饱和点（v1.17 起只用于计算退避，不再用于判 broken）。
 *
 * 历史上它是"连续失败多少次后置 broken"。那条规则已经在
 * recordFetchError 里被撤掉（详见那里的注释：一次网络抖动就会把源判死），
 * 常量保留是因为 §7.1 的退避公式要引用这个数：失败 3 次后退避到 8 倍。
 */
export const BROKEN_AFTER = 3;

export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(8).toString('hex')}`;

export function listFeeds(db: DatabaseSync, userId: string): (FeedRow & { unread: number; total: number })[] {
  // 未读数与总数都要排除重复条目，否则侧栏角标会比列表里能看到的条目多
  // （重复条目被 entries 路由过滤掉，但角标若照数就会对不上）。
  const rows = db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM entries e
             WHERE e.feed_id = f.id AND e.is_read = 0 AND e.duplicate_of IS NULL) AS unread,
           (SELECT COUNT(*) FROM entries e
             WHERE e.feed_id = f.id AND e.duplicate_of IS NULL) AS total
      FROM feeds f
     WHERE f.user_id = ?
     ORDER BY f.status = 'broken', f.title IS NULL, f.title
  `).all(userId) as unknown as (FeedRow & { unread: number; total: number })[];
  return rows.map((r) => ({ ...r, unread: Number(r.unread), total: Number(r.total) }));
}

export function getFeed(db: DatabaseSync, userId: string, id: string): FeedRow | null {
  return (db.prepare('SELECT * FROM feeds WHERE id = ? AND user_id = ?')
    .get(id, userId) as FeedRow | undefined) ?? null;
}

export function findFeedByUrl(db: DatabaseSync, userId: string, url: string): FeedRow | null {
  return (db.prepare('SELECT * FROM feeds WHERE user_id = ? AND url = ?')
    .get(userId, url) as FeedRow | undefined) ?? null;
}

export interface CreateFeedInput {
  userId: string;
  url: string;
  title?: string | null;
  siteUrl?: string | null;
  iconUrl?: string | null;
  folderId?: string | null;
  fetchInterval?: number;
  sourceKind?: string;
}

export function createFeed(db: DatabaseSync, input: CreateFeedInput): FeedRow {
  const id = newId('f');
  const now = Date.now();
  const interval = input.fetchInterval ?? DEFAULT_INTERVAL;
  db.prepare(`
    INSERT INTO feeds (id, user_id, folder_id, url, site_url, title, icon_url,
                       fetch_interval, last_fetched_at, next_fetch_at, error_count,
                       status, source_kind)
    VALUES (?,?,?,?,?,?,?,?,NULL,?,0,'active',?)
  `).run(
    id, input.userId, input.folderId ?? null, input.url,
    input.siteUrl ?? null, input.title ?? null, input.iconUrl ?? null,
    interval, now, input.sourceKind ?? 'rss',
  );
  return getFeed(db, input.userId, id)!;
}

export function updateFeed(
  db: DatabaseSync,
  userId: string,
  id: string,
  patch: { title?: string | null; fetchInterval?: number; status?: FeedStatus; folderId?: string | null },
): FeedRow | null {
  const cur = getFeed(db, userId, id);
  if (!cur) return null;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
  if (patch.fetchInterval !== undefined) {
    sets.push('fetch_interval = ?');
    params.push(Math.max(300, Math.min(86400 * 7, patch.fetchInterval)));
  }
  if (patch.folderId !== undefined) { sets.push('folder_id = ?'); params.push(patch.folderId); }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
    // 从 broken 恢复时重置计数与下次抓取时间，否则永远等不到重试
    if (patch.status === 'active') {
      sets.push('error_count = 0', 'next_fetch_at = ?');
      params.push(Date.now());
    }
  }
  if (sets.length === 0) return cur;

  params.push(id, userId);
  db.prepare(`UPDATE feeds SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  return getFeed(db, userId, id);
}

/**
 * 删除订阅。
 *
 * entries.feed_id 是 ON DELETE CASCADE，所以条目会一并删除 —— 这是
 * RSS 阅读器的常规语义（取消订阅就不该再占着列表）。但用户**读过的**
 * 条目若被删掉，历史记录也跟着没了。因此这里对"已读或已收藏"的条目
 * 改为保留并解绑 feed，只有未读条目随订阅一起删。
 */
export function deleteFeed(db: DatabaseSync, userId: string, id: string): boolean {
  const cur = getFeed(db, userId, id);
  if (!cur) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 解绑要保留的条目
    db.prepare(`
      UPDATE entries SET feed_id = NULL
       WHERE feed_id = ? AND user_id = ? AND (is_read = 1 OR is_starred = 1)
    `).run(id, userId);
    // 其余未读条目随订阅删除（CASCADE 处理不了条件，显式删）
    const doomed = db.prepare(
      'SELECT id FROM entries WHERE feed_id = ? AND user_id = ?',
    ).all(id, userId) as { id: string }[];
    for (const d of doomed) {
      db.prepare('DELETE FROM entry_fts_map WHERE entry_id = ?').run(d.id);
      db.prepare('DELETE FROM entries WHERE id = ?').run(d.id);
    }
    db.prepare('DELETE FROM feeds WHERE id = ? AND user_id = ?').run(id, userId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

// ── 条目写入 ───────────────────────────────────────────────

/**
 * 把解析出的 feed 条目写库。
 *
 * 判重三层（PLAN §7.1 L2 的简化版，向量层在 M2 补）：
 *   1. (feed_id, guid) 唯一索引 —— 同一 feed 重复抓取
 *   2. url_norm 相同 —— 同一文章被不同 feed 收录
 *   3. content_hash 相同 —— 转载/镜像
 *
 * 第 2、3 层命中时不插入，但**不丢弃**：写 duplicate_of 指向已有条目，
 * 这样"这篇文章被几个源报道"是可查的（M3 简报要用）。
 */
export function upsertItems(
  db: DatabaseSync,
  feed: FeedRow,
  parsed: ParsedFeed,
  now = Date.now(),
): UpsertStats {
  const stats: UpsertStats = { inserted: 0, skipped: 0, invalid: 0, extractSkipped: 0, duplicates: 0 };

  const existsGuid = db.prepare('SELECT id FROM entries WHERE feed_id = ? AND guid = ?');

  const ins = db.prepare(`
    INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title, author,
                         published_at, fetched_at, excerpt, content_hash, word_count,
                         stage, source_type, site_name, favicon_url, thumbnail_url,
                         duplicate_of)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rss',?,?,?,?)
  `);
  const insContent = db.prepare(
    'INSERT OR REPLACE INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of parsed.items) {
      const url = (it.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        stats.invalid++;
        continue;
      }
      const urlNorm = canonicalUrl(url);
      const hash = contentHash(it.title, it.html);

      if (existsGuid.get(feed.id, it.guid)) { stats.skipped++; continue; }

      // 正文必须清洗后再存：feed 是外部输入，直接送进
      // dangerouslySetInnerHTML 就是存储型 XSS（见 feeds/sanitize.ts）。
      // 清洗在这里做（而不是等提取任务），因为"feed 正文够不够长"这个
      // 判断要看清洗后的字数，而清洗后的 HTML 也正好就是要落库的那份；
      // 去重的向量层同样要用它算签名。
      let cleanHtml = '';
      if (it.html) {
        const clean = sanitizeHtml(it.html, { baseUrl: url });
        if (clean.html) cleanHtml = clean.html;
      }

      // 三层判重（PLAN §7.1 L2）：URL → 内容指纹 → 向量余弦。
      // 命中时不丢弃条目，而是写 duplicate_of 指回已存在那条 ——
      // "这篇文章被几个源报道"是 M3 简报的输入，丢弃就查不到了。
      const dup = findDuplicate(db, {
        userId: feed.user_id,
        url, title: it.title, html: cleanHtml, contentHash: hash,
      });

      const id = newId('e');
      const feedChars = cleanHtml.length > 0 ? htmlToText(cleanHtml).length : 0;

      // 正文太短 → 交给提取任务去抓原文（PLAN §7.5）。
      // 够长则直接标 extracted：这一步省掉的正是每天四五百次额外请求。
      const needExtract = feedChars < MIN_FEED_CHARS;
      const stage = needExtract ? 'pending' : 'extracted';
      const words = cleanHtml ? estimateWordCount(htmlToText(cleanHtml)) : null;

      ins.run(
        id, feed.user_id, feed.id, it.guid, url, urlNorm, it.title, it.author,
        it.publishedAt, now, it.excerpt, hash, words, stage,
        parsed.title ?? feed.title, feed.icon_url, it.imageUrl,
        dup ? dup.entryId : null,
      );
      if (dup) stats.duplicates++;

      if (cleanHtml) insContent.run(id, packText(cleanHtml), 'feed');

      // 向量层判重要读它，所以入库当下就写。异步补写会留下一个
      // "刚入库、还没有向量"的窗口，窗口里同一篇的转载查不到它
      // （§dedupe/index.ts 有说明）。
      ensureLocalVector(db, id, it.title, cleanHtml);

      if (needExtract) {
        // dedupe_key 保证同一篇不会被重复排进队列（重复抓是纯浪费）
        enqueue(db, {
          kind: 'extract',
          payload: { entryId: id },
          dedupeKey: `extract:${id}`,
        });
      } else {
        stats.extractSkipped++;
      }

      // 摘要进 FTS（正文不进，见 §7.3）
      indexEntry(db, id, {
        title: it.title,
        excerpt: it.excerpt,
        summary: null,
        topics: it.categories.length > 0 ? it.categories : null,
      });

      stats.inserted++;
    }

    db.prepare('UPDATE feeds SET last_fetched_at = ?, error_count = 0, status = ? WHERE id = ?')
      .run(now, 'active', feed.id);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return stats;
}

/**
 * 抓取成功后推进 next_fetch_at。
 *
 * 退避策略按 PLAN §7.1：抓取间隔随失败次数线性放大（最多 8 倍），
 * 成功一次就复位 —— 站点临时挂了不应该让它永远按 8 倍慢速跑。
 */
export function scheduleNextFetch(db: DatabaseSync, feed: FeedRow, now = Date.now()): void {
  const mult = 1 + Math.min(feed.error_count, 3) * 2;
  const next = now + feed.fetch_interval * 1000 * mult;
  db.prepare('UPDATE feeds SET next_fetch_at = ? WHERE id = ?').run(next, feed.id);
}

/**
 * 抓取失败记账。
 *
 * 只有 `retryable === false` 的失败才置 broken；瞬时失败（网络错误、超时、
 * 5xx、429、站点临时返回 HTML）一律留在 active，只靠退避放慢。
 *
 * 这条规则在 v1.17 改过一次，原因是一次真实事故：原来的判据是
 * `!retryable || count >= BROKEN_AFTER`，于是"连续三次网络不通"就把源
 * 判成永久失效，而 broken 是**终态** —— sweep 只认 active，它再也不会被
 * 自动抓取。实测 21 个源里有 15 个落到 broken，其中 11 个的失败原因全是
 * `网络错误: fetch failed` / `请求超时（30s）`（那段时间整机网络在抖），
 * 点一下手动重试就全好了。
 *
 * 判据改成"确凿的永久失效"之后，一次网络抖动最多让源慢下来（退避上限
 * 8 倍 = 4 小时），不会把它从时间线上摘掉。真正死掉的源（404/410、
 * 域名没了）仍会在第一次就明确标记，用户能看到一个诚实的"这个源没了"。
 *
 * `BROKEN_AFTER` 保留但不再参与判定：它是"退避到 8 倍"的饱和点，
 * 保留常量是为了让 §7.1 里那条退避曲线仍有一个可引用的名字。
 */
export function recordFetchError(
  db: DatabaseSync,
  feed: FeedRow,
  err: { message: string; retryable: boolean },
  now = Date.now(),
): { status: FeedStatus; errorCount: number } {
  // error_count 只用于退避与"这个源最近老失败"的提示，不封顶会溢出显示
  const count = Math.min(feed.error_count + 1, 999);
  const broken = !err.retryable;
  const status: FeedStatus = broken ? 'broken' : 'active';
  const next = now + feed.fetch_interval * 1000 * (1 + Math.min(count, 3) * 2);

  db.prepare(`
    UPDATE feeds SET error_count = ?, status = ?, next_fetch_at = ?,
                     last_fetched_at = ?
     WHERE id = ?
  `).run(count, status, next, now, feed.id);

  return { status, errorCount: count };
}

/** 到期待抓的源。sweep 定时器与验收脚本共用。 */
export function dueFeeds(db: DatabaseSync, limit = 20, now = Date.now()): FeedRow[] {
  return db.prepare(`
    SELECT * FROM feeds
     WHERE status = 'active'
       AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
     ORDER BY next_fetch_at IS NULL DESC, next_fetch_at
     LIMIT ?
  `).all(now, limit) as unknown as FeedRow[];
}

/** 入队一次抓取。dedupe_key 保证同一源不会重复排队。 */
export function enqueueFetch(db: DatabaseSync, feedId: string, priority = 0, runAfter?: number): number | null {
  return enqueue(db, {
    kind: 'fetch_feed',
    payload: { feedId },
    dedupeKey: `fetch:${feedId}`,
    priority,
    runAfter,
  });
}

/** 指纹工具再导出，便于验收脚本单独测 */
export { contentHash, canonicalUrl };

/** 供 OPML 使用的稳定 id（导出不带内部 id，导入时重建） */
export function opmlKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}
