// 前端 API 客户端。
//
// 所有请求带 credentials:'include' —— 与 Huntly 插件一致（PLAN §14.3），
// 这样浏览器 UI 与插件共用同一套 cookie 会话。

import type {
  ApiError, BulkResult, DiscoverCandidate, DiscoverResponse, DigestCluster,
  DigestDetail, DigestRunPhase, DigestRunStatus, DigestRunView, DigestSummary,
  DigestWorthReading, EntryDetail, EntrySummary, FeedItem, FeedListResponse,
  FolderItem, HealthResponse, HighlightColor, HighlightItem, HistoryBucket,
  HistoryEntry, HistoryGroup, HistoryResponse, ListResponse, RsshubConfigResponse,
  RsshubPreviewResponse, RsshubRoute, RsshubSearchResponse, User,
} from '../shared/dto.ts';

// 响应类型（DTO）搬到了 src/shared/dto.ts —— 服务端路由要拿同一份类型去
// 标注返回值，否则客户端这份 interface 只是"自我安慰"，编译器永远不会
// 拿它和服务端真实返回对照（详见 dto.ts 头注释）。
//
// 这里只做转出，名字一个都没变：客户端所有 `import type { X } from './api.ts'`
// 照旧可用，也不必为了这次搬迁去改几十个文件。
export type {
  ApiError,
  BulkResult,
  DiscoverCandidate,
  DiscoverResponse,
  DigestCluster,
  DigestDetail,
  DigestRunPhase,
  DigestRunStatus,
  DigestRunView,
  DigestSummary,
  DigestWorthReading,
  EntryDetail,
  EntrySummary,
  FeedItem,
  FeedListResponse,
  FolderItem,
  HealthResponse,
  HighlightColor,
  HighlightItem,
  HistoryBucket,
  HistoryEntry,
  HistoryGroup,
  HistoryResponse,
  ListResponse,
  RsshubConfigResponse,
  RsshubPreviewResponse,
  RsshubRoute,
  RsshubSearchResponse,
  User,
} from '../shared/dto.ts';

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, body: ApiError | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.retryable = body?.error?.retryable ?? false;
  }
}

async function rawRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!res.ok) {
    throw new ApiFailure(res.status, body as ApiError | null, res.statusText);
  }
  return body as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return rawRequest<T>(`/api/v1${path}`, init);
}

export const api = {
  // /api/health 不在 /api/v1 下，走 rawRequest
  health: () => rawRequest<HealthResponse>('/api/health'),
  me: () => request<{ user: User }>('/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  setup: (email: string, password: string) =>
    request<{ created: boolean; password?: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  listEntries: (params: {
    view?: string;
    q?: string;
    cursor?: string | null;
    limit?: number;
    feedId?: string | null;
    folderId?: string | null;
    /** 切视图/改搜索词要能中途作废，见 lib/latest.ts */
    signal?: AbortSignal;
  }) => {
    const sp = new URLSearchParams();
    if (params.view) sp.set('view', params.view);
    if (params.q) sp.set('q', params.q);
    if (params.cursor) sp.set('cursor', params.cursor);
    if (params.feedId) sp.set('feedId', params.feedId);
    if (params.folderId) sp.set('folderId', params.folderId);
    sp.set('limit', String(params.limit ?? 30));
    return request<ListResponse>(`/entries?${sp}`, { signal: params.signal });
  },
  getEntry: (id: string) => request<EntryDetail>(`/entries/${id}`),

  /**
   * 阅读历史（按日期分组）。
   *
   * 独立于 listEntries：返回结构是"分组数组"而不是"平铺列表 + 游标"，
   * 因为历史页要渲染日期标题。把它塞进 listEntries 的返回类型，
   * 会逼所有调用方处理一个它们从来不会用的 groups 字段。
   */
  listHistory: (params: {
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  } = {}) => {
    const sp = new URLSearchParams();
    if (params.cursor) sp.set('cursor', params.cursor);
    sp.set('limit', String(params.limit ?? 60));
    return request<HistoryResponse>(`/entries/history?${sp}`, { signal: params.signal });
  },

  // ── RSSHub 订阅搜索（§10）──────────────────────────────
  rsshubConfig: () => request<RsshubConfigResponse>('/rsshub/config'),
  saveRsshubConfig: (baseUrl: string, accessKey: string) =>
    request<RsshubConfigResponse>('/rsshub/config', {
      method: 'PUT',
      body: JSON.stringify({ baseUrl, accessKey }),
    }),
  refreshRsshub: () =>
    request<{ ok: boolean; routes: number; radar: number; errors: string[]; ms: number; cache: RsshubConfigResponse['cache'] }>(
      '/rsshub/refresh', { method: 'POST' },
    ),
  searchRsshub: (q: string, limit = 20, signal?: AbortSignal) =>
    request<RsshubSearchResponse>(`/rsshub/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal }),
  previewRsshub: (path: string, params: Record<string, string> = {}) =>
    request<RsshubPreviewResponse>('/rsshub/preview', {
      method: 'POST',
      body: JSON.stringify({ path, params }),
    }),

  markRead: (id: string, progress?: number) =>
    request<{ ok: boolean }>('/entries/read', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], progress }),
    }),
  toggleStar: (id: string) =>
    request<{ isStarred: boolean }>(`/entries/${id}/star`, { method: 'POST' }),
  /** 已读回退（§15.11）。阅读历史字段不动，只把 is_read 置 0。 */
  markUnread: (id: string) =>
    request<{ ok: boolean; count: number }>('/entries/unread', {
      method: 'POST',
      body: JSON.stringify({ ids: [id] }),
    }),
  /**
   * 把一个范围（分组 / 单个源）的未读一次标为已读（§15.21，v1.17）。
   *
   * 只接受范围，不支持全库 —— 后端会拒绝不带 feedId/folderId 的请求。
   * 与 markRead 的区别：这条不写阅读历史（first_read_at / last_read_at /
   * read_count 都不动），因为它表达的是"不想看了"，不是"读过了"。
   */
  markAllRead: (scope: { feedId?: string | null; folderId?: string | null }) =>
    request<{ ok: boolean; count: number }>('/entries/mark-all-read', {
      method: 'POST',
      body: JSON.stringify(scope),
    }),
  /** 阅读进度上报。只增不减，重复值后端直接返回 changed:false。 */
  reportProgress: (id: string, progress: number) =>
    request<{ ok: boolean; progress: number; changed: boolean }>(`/entries/${id}/progress`, {
      method: 'POST',
      body: JSON.stringify({ progress }),
    }),

  // ── 高亮（M4）──────────────────────────────────────────
  listHighlights: (entryId: string) =>
    request<{ items: HighlightItem[] }>(`/entries/${entryId}/highlights`),

  /** 全局列表（跨条目）。cursor 是上一页最后一条的 createdAt */
  allHighlights: (params: {
    limit?: number;
    cursor?: string | null;
    color?: string | null;
    /** 切到别的标签页就可能被判过期，见 lib/latest.ts */
    signal?: AbortSignal;
  } = {}) => {
    const sp = new URLSearchParams();
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.cursor) sp.set('cursor', params.cursor);
    if (params.color) sp.set('color', params.color);
    const qs = sp.toString();
    return request<{ items: (HighlightItem & { entryTitle: string; sourceName: string })[]; nextCursor: string | null }>(
      '/highlights' + (qs ? '?' + qs : ''),
      { signal: params.signal },
    );
  },

  // 可以用 start/end（浏览器里的精确选区），也可以只给 quote（服务端搜）。
  // 两个都给时服务端会校验偏移与 quote 是否一致 —— 不一致说明前端拿的是
  // 旧正文，它会按 quote 重算。
  createHighlight: (input: {
    entryId: string; start?: number; end?: number; quote?: string;
    color?: HighlightColor; note?: string;
  }) => request<HighlightItem>('/highlights', {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  /** 只传要改的字段。`note: ''` 是"清空"，不是"没传" */
  patchHighlight: (id: string, patch: { color?: HighlightColor; note?: string }) =>
    request<HighlightItem>(`/highlights/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteHighlight: (id: string) =>
    request<{ ok: boolean }>(`/highlights/${id}`, { method: 'DELETE' }),

  /**
   * 单条 AI 解读（§11.4）。同步返回，可能等 1~3 秒。
   *
   * 失败时 **HTTP 仍是 200**，靠 ok 字段区分 —— 没配 key 不是「请求错了」，
   * 前端该显示「去配 key」而不是红色报错。
   */
  highlightInsight: (id: string, force = false) =>
    request<{
      ok: boolean;
      insight: string | null;
      cached?: boolean;
      costUsd?: number;
      failureKind?: string;
      message?: string;
    }>(`/highlights/${id}/insight`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  stats: () => request<{
    entries: number;
    feeds: number;
    unread: number;
    starred?: number;
    queue: { pending: number; running: number; dead: number };
    /** M2 起返回；老版本没有这一段，调用方要按可选处理 */
    ai?: {
      analyzed: number;
      failed: number;
      dims: Record<string, number>;
      level: 'ok' | 'fast_only' | 'stop';
      todayUsd: number;
      monthUsd: number;
      dailyLimit: number;
      monthlyLimit: number;
      todayCalls: number;
      todayFailures: number;
      reason: string;
    };
  }>('/stats'),

  // ── AI 配置（M2）────────────────────────────────────────
  // GET 返回的是**合成后**的配置 + 来源标记，不是数据库里那条原始 JSON：
  // 用户要看的是"现在实际连的是哪儿"，而原始 JSON 只知道自己覆盖了哪些字段。
  getAiConfig: () => request<{
    baseURL: string;
    apiKeyEnv: string;
    models: { fast: string; strong: string; embed: string };
    budget: { dailyUsd: number; monthlyUsd: number };
    hasKey: boolean;
    /** key 从哪来（§8.8）：界面上填的文件 / 部署期环境变量 / 都没有 */
    keySource: 'file' | 'env' | 'none';
    /** 掩码后的 key。服务端**从不**回显完整 key */
    keyMasked: string | null;
    source: 'settings' | 'deployed';
    /** 单篇总结的提示词（§8.9）：生效值 / 内置默认 / 是否处于默认 */
    summaryPrompt: string;
    summaryPromptDefault: string;
    summaryPromptIsDefault: boolean;
  }>('/settings/ai'),

  /** 只提交要改的字段。空/缺省 = 保持部署期配置（见 §8.6 三层合并） */
  patchAiConfig: (patch: Record<string, unknown>) =>
    request<{ ok: boolean }>('/settings/ai', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * 写 API key（§8.8）。空串 = 删除、回落到环境变量。
   *
   * 单独一个端点而不是并进 patchAiConfig：key 落在 `data/secrets.json`，
   * 与 ai_config 不是同一份存储。
   */
  setApiKey: (apiKey: string) =>
    request<{ ok: boolean; hasKey: boolean }>('/settings/ai/key', {
      method: 'PATCH',
      body: JSON.stringify({ apiKey }),
    }),

  /**
   * 用一次最小调用验证 key 能不能用（§8.8）。失败也返 200，看 `ok`。
   *
   * v2.8 起结果里带 `latencyMs` / `delivery` / 用量：用户按这颗按钮问的是
   * "到底通不通、慢不慢"，只回一句"连不上"没法判断是 key、网络还是模型。
   */
  testAiKey: () => request<{
    ok: boolean;
    text?: string;
    model?: string;
    latencyMs?: number;
    /** split = system/user 分角色；merged = 网关丢了 system，已合并成一条 */
    delivery?: 'split' | 'merged';
    deliveryReason?: 'learned' | 'profile' | 'default';
    inTokens?: number;
    outTokens?: number;
    costUsd?: number;
    failure?: { kind: string; message: string; retryable: boolean };
    hint?: string;
  }>('/settings/ai/test', { method: 'POST', body: '{}' }),

  // ── AI 自检与测速（v2.7，§8.10 / §8.11 / §15.30）─────────
  //
  // 与上面的 testAiKey 分工：那颗按钮 2 秒只验"key 能不能过鉴权"；
  // 自检跑八步 10~60 秒，回答"这条链上每一步通不通、不通该怎么办"。
  // 线上真实故障是"key 通、但每一篇分析都失败" —— 前者对它一无所知。
  runAiSelfTest: () => request<{
    id: string;
    verdict: string;
    steps: {
      id: string; title: string; status: 'pass' | 'warn' | 'fail' | 'skip';
      detail: string; hint?: string; raw?: string;
      metrics?: { latencyMs?: number | null; inTokens?: number | null; outTokens?: number | null; costUsd?: number | null };
    }[];
    capabilities: unknown;
    startedAt: number;
    finishedAt: number;
    costUsd: number;
  }>('/settings/ai/selftest', { method: 'POST', body: '{}' }),

  /** 最近一次自检。首屏渲染用 —— 刷新后结果还在，是"便于查看"的最低要求 */
  getAiSelfTestLatest: () => request<{
    id: string | null;
    verdict: string | null;
    steps: {
      id: string; title: string; status: 'pass' | 'warn' | 'fail' | 'skip';
      detail: string; hint?: string; raw?: string;
      metrics?: { latencyMs?: number | null; inTokens?: number | null; outTokens?: number | null; costUsd?: number | null };
    }[];
    startedAt?: number;
    finishedAt?: number;
    costUsd?: number;
  }>('/settings/ai/selftest/latest'),

  /** 测速。缺省测 fast + strong，每个 3 次报中位数 */
  benchAiModels: (models?: string[]) => request<{
    results: {
      model: string;
      okCount: number;
      runs: {
        ok: boolean; streamed: boolean;
        ttftMs: number | null; firstReasoningMs: number | null; firstContentMs: number | null;
        totalMs: number; outTokens: number | null; tokensPerSec: number | null; error?: string;
      }[];
      median: {
        ok: boolean;
        ttftMs: number | null; firstReasoningMs: number | null; firstContentMs: number | null;
        totalMs: number; outTokens: number | null; tokensPerSec: number | null;
        range: { ttftMs: [number, number] | null; totalMs: [number, number] | null };
      };
    }[];
  }>('/settings/ai/bench', { method: 'POST', body: JSON.stringify({ models }) }),

  /** 复位 AI 侧失败并重新入队（§8.10）。N 与入队用同一判据，避免"说 N 条、入队 0 条" */
  retryFailedAnalyze: () => request<{
    reset: number; clearedDeadJobs: number; queued: number; remaining: number;
  }>('/settings/ai/retry-failed', { method: 'POST', body: '{}' }),

  // ── 单篇总结（2.7，§8.9）────────────────────────────────
  /** 读当前提示词下的缓存。`summary:null` = 还没总结过 */
  getEntrySummary: (id: string) => request<{
    summary: string | null;
    promptFp: string;
    createdAt: number | null;
    model: string | null;
  }>(`/entries/${id}/summary`),

  /** 生成（或取缓存）。`force:true` 才重算，否则同提示词命中缓存不发请求 */
  makeEntrySummary: (id: string, opts: { force?: boolean } = {}) =>
    request<{
      ok: boolean;
      cached: boolean;
      summary: string | null;
      promptFp: string;
      failure: { kind: string; message: string; retryable: boolean } | null;
    }>(`/entries/${id}/summary`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  // ── 简报（M3）──────────────────────────────────────────
  /** 只提交要改的字段：`{ at?: 'HH:MM', enabled?: boolean }` */
  patchDigestConfig: (patch: {
    at?: string; enabled?: boolean; kind?: string; maxCostUsd?: number;
  }) =>
    request<{ ok: boolean }>('/settings/digest', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  digestStatus: () => request<{
    enabled: boolean;
    at: string;
    state: 'none' | 'generated' | 'skipped' | 'failed' | 'pending';
    digestId: string | null;
    skipReason: string | null;
    attempts: number;
    lastError: string | null;
    nextAt: number;
    maxCostUsd: number;
    /** 最近一次生成（含正在跑的那次）；从来没有过则为 null */
    run: DigestRunView | null;
  }>('/digests/status'),

  listDigests: (limit = 20, signal?: AbortSignal) =>
    request<{ items: DigestSummary[] }>(`/digests?limit=${limit}`, { signal }),

  /**
   * 触发一次生成。**立刻返回**，不等生成跑完（202 + runId）。
   *
   * `queued:false` 表示已经有一次在跑，返回的是那一次的 runId ——
   * 连点两下不会花两份钱，也不会出现两个进度条。
   */
  runDigest: (force = false) =>
    request<{
      ok: boolean;
      queued: boolean;
      runId: string;
      status: DigestRunStatus;
      message?: string;
      dayKey?: number;
      hint?: string | null;
    }>('/digests/run', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  /** 请求停止。语义是"已请求"不是"已停止"，结果要靠轮询状态确认 */
  stopDigest: (runId: string) =>
    request<{
      ok: boolean;
      status: DigestRunStatus | null;
      cancelled: boolean;
      requested: boolean;
      message: string;
    }>(`/digests/runs/${runId}/stop`, { method: 'POST' }),

  getDigest: (id: string) =>
    request<DigestDetail>(`/digests/${id}`),

  // ── 订阅 ────────────────────────────────────────────────
  listFeeds: (params: { folderId?: string | null; signal?: AbortSignal } = {}) => {
    const sp = new URLSearchParams();
    if (params.folderId !== undefined && params.folderId !== null) {
      sp.set('folderId', params.folderId);
    }
    const qs = sp.toString();
    return request<FeedListResponse>('/feeds' + (qs ? '?' + qs : ''), { signal: params.signal });
  },

  /** 编辑订阅：标题 / 分组 / 抓取间隔 */
  editFeed: (id: string, patch: {
    title?: string | null;
    folderId?: string | null;
    fetchInterval?: number;
  }) => request<{ feed: FeedItem }>('/feeds/' + id, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }),

  // ── 分组 ────────────────────────────────────────────────
  listFolders: (params: { signal?: AbortSignal } = {}) =>
    request<{ items: FolderItem[] }>('/folders', { signal: params.signal }),
  createFolder: (name: string) =>
    request<{ folder: FolderItem }>('/folders', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameFolder: (id: string, name: string) =>
    request<{ folder: FolderItem }>('/folders/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: string) =>
    request<{ ok: boolean }>('/folders/' + id, { method: 'DELETE' }),
  /** 重排分组（PLAN §15.28）：ids 就是新顺序，未列出的顺延在后 */
  reorderFolders: (ids: string[]) =>
    request<{ items: FolderItem[] }>('/folders/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ ids }),
    }),
  /**
   * 安排一批源（PLAN §15.28）：归到 `folderId`（null=未分组），顺序就是 `ids`。
   *
   * 一个方法覆盖组内调序、移入某组、移出分组三种动作 —— 它们说的是
   * 同一句话。拆成三个 API 的话，跨组拖动（同时换组又定序）还得前端
   * 先判断是哪一种，而那正是最容易写错的地方。
   */
  arrangeFeeds: (folderId: string | null, ids: string[]) =>
    request<{ ok: boolean; moved: number }>('/feeds/arrange', {
      method: 'POST',
      body: JSON.stringify({ folderId, ids }),
    }),
  moveFeedsToFolder: (folderId: string, feedIds: string[]) =>
    request<{ ok: boolean; moved: number }>('/folders/' + folderId + '/feeds', {
      method: 'POST',
      body: JSON.stringify({ feedIds }),
    }),
  unfileFeeds: (feedIds: string[]) =>
    request<{ ok: boolean; moved: number }>('/folders/unfile/feeds', {
      method: 'POST',
      body: JSON.stringify({ feedIds }),
    }),

  // ── 批量操作（§15.10）────────────────────────────────────
  //
  // 四个端点都是「一次事务做完」，不是前端循环调单条接口。
  // 理由写在 src/server/feeds/bulk.ts 的头注释里。
  bulkMoveToFolder: (feedIds: string[], folderId: string | null) =>
    request<BulkResult>('/feeds/bulk/folder', {
      method: 'POST',
      body: JSON.stringify({ feedIds, folderId }),
    }),
  bulkSetStatus: (feedIds: string[], status: 'active' | 'paused') =>
    request<BulkResult>('/feeds/bulk/status', {
      method: 'POST',
      body: JSON.stringify({ feedIds, status }),
    }),
  bulkDelete: (feedIds: string[]) =>
    request<BulkResult>('/feeds/bulk/delete', {
      method: 'POST',
      body: JSON.stringify({ feedIds }),
    }),
  bulkRefresh: (feedIds: string[]) =>
    request<BulkResult>('/feeds/bulk/refresh', {
      method: 'POST',
      body: JSON.stringify({ feedIds }),
    }),
  discoverFeed: (url: string) =>
    request<DiscoverResponse>('/feeds/discover', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  /**
   * 订阅一个源。
   *
   * `folderId` 是 v1.9 才用上的（§15.15）：后端 POST /feeds 一直支持这个字段，
   * 只是原来前端没传，于是"在某个分组里添加订阅"总是落到未分组，
   * 用户得再回行里编辑一次才能归组。
   */
  addFeed: (url: string, folderId?: string | null) =>
    request<{ created: boolean; feed: FeedItem; imported?: number }>('/feeds', {
      method: 'POST',
      body: JSON.stringify(folderId ? { url, folderId } : { url }),
    }),
  refreshFeed: (id: string) =>
    request<{ ok: boolean; queued: boolean }>(`/feeds/${id}/refresh`, { method: 'POST' }),
  refreshAllFeeds: () =>
    request<{ ok: boolean; queued: number; total: number }>('/feeds/refresh-all', { method: 'POST' }),
  /**
   * 复活所有「失效」源并立刻重抓（§15.23，v1.17）。
   *
   * broken 是终态，sweep 不会再碰它 —— 判据修好之后，已经坏掉的那批
   * 仍然躺在库里，需要一个显式动作把它们拉回时间线。
   */
  retryBrokenFeeds: () =>
    request<{ ok: boolean; revived: number; queued: number; total: number }>(
      '/feeds/retry-broken', { method: 'POST' },
    ),
  updateFeed: (id: string, patch: { title?: string | null; fetchInterval?: number; status?: 'active' | 'paused' }) =>
    request<{ feed: FeedItem }>(`/feeds/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteFeed: (id: string) =>
    request<{ ok: boolean }>(`/feeds/${id}`, { method: 'DELETE' }),
  exportOpml: async (): Promise<string> => {
    const r = await fetch('/api/v1/feeds/export', { credentials: 'include' });
    if (!r.ok) throw new ApiFailure(r.status, null, '导出失败');
    return r.text();
  },
  importOpml: (opml: string) =>
    request<{ created: number; skipped: number; items: { id: string; title: string | null }[] }>(
      '/feeds/import',
      { method: 'POST', headers: { 'content-type': 'text/x-opml' }, body: opml },
    ),
};
