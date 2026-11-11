// 服务端与客户端共用的响应类型（DTO）。
//
// 为什么这些类型必须放在客户端之外：类型只写在客户端，等于根本没有契约 ——
// 服务端路由返回裸字面量、没有任何标注，客户端那份 interface 想怎么写就
// 怎么写，编译器永远不会拿两边对照。真实事故已经发生过一次：
// EntrySummary.highlightCount 写成必填，而历史接口实际不返回它，前端只能
// 在渲染时用 `'highlightCount' in it` 兜住。
//
// 放到 src/shared/ 之后，服务端路由可以 `const body: ListResponse = {...}`
// 让编译器去比对；形状对不上就不再是"运行时才发现的惊喜"。
//
// 这个文件里只允许放**纯类型**：任何运行时代码（枚举对象、函数、类）
// 都会同时被服务端（NodeNext + strip-types）和前端（bundler）加载，
// 两边模块解析规则不同，放进来的代价远大于收益。ApiFailure 之类的运行
// 时类继续留在 src/client/api.ts。

/** 服务端错误响应的统一形状（c.json 出错时 onError 拼出来的） */
export interface ApiError {
  error: { code: string; message: string; retryable: boolean };
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

export interface EntrySummary {
  id: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: number;
  excerpt: string | null;
  isRead: boolean;
  isStarred: boolean;
  tier: string | null;
  summary: string | null;
  siteName: string | null;
  highlightCount: number;
  faviconUrl: string | null;
  thumbnailUrl: string | null;
  wordCount: number | null;
  /** 所属的源 id；网页捕获的条目为 null（v1.17 起列表与详情都带） */
  feedId: string | null;
  /**
   * 源的标题。列表和详情都返回它，所以是必填；阅读页的"去源站"用它，
   * 列表页则靠 siteName —— 两边都需要它存在，只是用法不同。
   */
  feedTitle: string | null;
}

/** 历史条目：比 EntrySummary 多"怎么读的"这一组字段（PLAN §7.4） */
export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: number;
  /** 最后一次读的时间。历史页的时间轴用它，**不是** publishedAt */
  readAt: number;
  firstReadAt: number | null;
  /** 读过几次。>1 时卡片上画角标（"这篇我回看过"） */
  readCount: number;
  /** 0~1；null 表示没有上报过 */
  readProgress: number | null;
  isRead: boolean;
  isStarred: boolean;
  excerpt: string | null;
  siteName: string | null;
  summary: string | null;
  tier: string | null;
  faviconUrl: string | null;
  wordCount: number | null;
  feedId: string | null;
  feedTitle: string | null;
}

export type HistoryBucket = 'today' | 'yesterday' | 'week' | 'earlier';

export interface HistoryGroup {
  key: HistoryBucket;
  title: string;
  count: number;
  items: HistoryEntry[];
}

export interface HistoryResponse {
  groups: HistoryGroup[];
  /** 本页条数（各分组之和） */
  count: number;
  /** 读过的总条数（不含游标条件） */
  total: number;
  nextCursor: string | null;
}

export interface RsshubRoute {
  key: string;
  title: string;
  namespace: string;
  path: string;
  example: string | null;
  categories: string[];
  description: string;
  namespaceDescription: string;
  params: string[];
  paramDocs: { name: string; description: string }[];
  matchedBy: 'radar' | 'name' | 'description' | 'category' | 'path';
  viaDomain?: string;
}

export interface RsshubSearchResponse {
  items: RsshubRoute[];
  total: number;
  type: 'url' | 'keyword';
  /** 缓存超过 7 天：界面提示"去看看更新"，但仍可用 */
  stale: boolean;
  fetchedAt: number;
  library: { routes: number; radar: number };
}

export interface RsshubPreviewResponse {
  ok: boolean;
  url: string;
  title: string | null;
  items: { title: string; link: string | null; publishedAt: number | null }[];
  error?: string;
}

export interface RsshubConfigResponse {
  baseUrl: string;
  accessKey: string;
  cache: { routes: number; radar: number; fetchedAt: number; stale: boolean; bytes: number };
}

export interface EntryDetail extends EntrySummary {
  contentHtml: string | null;
  contentMarkdown: string | null;
  /** 源站首页（feed 的 site_url）。网页捕获条目没有源，为 null */
  feedSiteUrl: string | null;
  feedTitle: string | null;
  /** 读过几次（>1 说明回看过） */
  readCount: number;
  firstReadAt: number | null;
  lastReadAt: number | null;
  /** 0~1；null 表示没上报过 */
  readProgress: number | null;
  analysis: {
    summary: string;
    keyPoints: string[];
    topics: string[];
    importance: number;
    tier: string;
    readingTime: number | null;
  } | null;
}

export interface ListResponse {
  items: EntrySummary[];
  total: number;
  nextCursor: string | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
  db: string;
  /** 库里还没有任何用户时为 true，前端据此显示初始化页 */
  needsSetup?: boolean;
  stats?: {
    entries: number;
    feeds: number;
    unread: number;
    queue: { pending: number; running: number; dead: number };
  };
}

export interface FolderItem {
  id: string;
  name: string;
  sort: number;
  feedCount: number;
  unread: number;
}

export interface FeedItem {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  iconUrl: string | null;
  status: 'active' | 'paused' | 'broken';
  fetchInterval: number;
  lastFetchedAt: number | null;
  nextFetchAt: number | null;
  errorCount: number;
  unread: number;
  total: number;
  /** 组内顺序（PLAN §15.28）。迁移前的老数据全是 0，并列时退回按标题比 */
  sort: number;
  /**
   * 所属分组。**可选**：列表接口（GET /feeds）一定返回它，而"单个源"
   * 的响应（POST /feeds 返回的那个 feed）历史上不带分组信息 —— 客户端
   * 在那条路径上只读 title/url，强制成必填等于让类型说谎。
   */
  folderId?: string | null;
  /** 同上：只有列表与编辑接口会查分组名并把这份带上 */
  folderName?: string | null;
}

/** 简报摘要（列表用，不含 bodyMd） */
export type DigestRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type DigestRunPhase = 'prepare' | 'clustering' | 'generating' | 'saving';

/** 一次简报生成的进度（服务端 digest_runs 的对外形状） */
export interface DigestRunView {
  id: string;
  status: DigestRunStatus;
  phase: DigestRunPhase;
  doneClusters: number;
  totalClusters: number;
  costUsd: number;
  startedAt: number;
  heartbeatAt: number;
  elapsedMs: number;
  /** 心跳停了：跑它的进程已经不在了（而不是这次生成失败） */
  stale: boolean;
  cancelReason: string | null;
  reason: string | null;
  digestId: string | null;
  manual: boolean;
}

export interface DigestSummary {
  id: string;
  title: string;
  intro: string[];
  periodStart: number;
  periodEnd: number;
  dayKey: number | null;
  entryCount: number;
  clusterCount: number;
  model: string | null;
  costUsd: number | null;
  deliveredAt: number | null;
  createdAt: number;
  /** 引用条数（"3 个事件"这类概括文案要用，不必先拉全量详情） */
  citeCount?: number;
}

/** 高亮的颜色：只有三种（§11.3 明确不做调色盘） */
export type HighlightColor = 'yellow' | 'green' | 'blue';

export interface HighlightItem {
  id: string;
  entryId: string;
  quote: string;
  prefix: string | null;
  suffix: string | null;
  posStart: number | null;
  posEnd: number | null;
  color: HighlightColor | null;
  note: string | null;
  aiInsight: string | null;
  /** 原文已变化、无法定位。仍要在列表里显示（§11.1 不静默丢） */
  isOrphaned: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * 简报引用的簇（正文里的 [1] [2] 对应它）。
 *
 * `index` 是**脚注号**，由服务端按 cites 的顺序给出 ——
 * 不能靠数组下标算：簇被清理后某些条目会缺 detail，下标就与 [n] 错位了。
 */
export interface DigestCluster {
  id: string;
  index: number;
  title: string;
  summary: string | null;
  keyPoints: string[];
  consensus: string[];
  /** 各来源说法不一致之处。空数组表示"没有分歧"，不是"没查" */
  conflicts: { claim: string; sources: string[] }[];
  entry_count: number | null;
  source_count: number | null;
  heat: number | null;
  /** 簇的详细数据已被清理，只剩简报里存下的标题 */
  missing: boolean;
}

/** 「值得一读」的一项（低热度但值得看） */
export interface DigestWorthReading {
  id: string;
  title: string;
  summary: string | null;
  entryCount: number | null;
  sourceCount: number | null;
  heat: number | null;
}

export interface DigestDetail extends DigestSummary {
  bodyMd: string;
  clusters: DigestCluster[];
  worthReading: DigestWorthReading[];
}

export interface FeedListResponse {
  items: FeedItem[];
  total: number;
  folders: FolderItem[];
  counts: {
    active: number;
    broken: number;
    paused: number;
    unread: number;
    unfiled: number;
  };
}

export interface DiscoverCandidate {
  url: string;
  title: string | null;
  siteUrl: string | null;
  iconUrl: string | null;
  itemCount: number;
}

/** 批量操作的结果。skipped 是业务跳过，missing 是库里已经没有的 id */
export interface BulkResult {
  requested: number;
  done: number;
  skipped: number;
  missing: string[];
}

export interface DiscoverResponse {
  found: boolean;
  candidates: DiscoverCandidate[];
  notes: string[];
  message?: string;
}
