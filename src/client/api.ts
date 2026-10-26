// 前端 API 客户端。
//
// 所有请求带 credentials:'include' —— 与 Huntly 插件一致（PLAN §14.3），
// 这样浏览器 UI 与插件共用同一套 cookie 会话。

export interface ApiError {
  error: { code: string; message: string; retryable: boolean };
}

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
}

export interface EntryDetail extends EntrySummary {
  contentHtml: string | null;
  contentMarkdown: string | null;
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
  folderId: string | null;
  folderName: string | null;
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
  }) => {
    const sp = new URLSearchParams();
    if (params.view) sp.set('view', params.view);
    if (params.q) sp.set('q', params.q);
    if (params.cursor) sp.set('cursor', params.cursor);
    if (params.feedId) sp.set('feedId', params.feedId);
    if (params.folderId) sp.set('folderId', params.folderId);
    sp.set('limit', String(params.limit ?? 30));
    return request<ListResponse>(`/entries?${sp}`);
  },
  getEntry: (id: string) => request<EntryDetail>(`/entries/${id}`),
  markRead: (id: string, progress?: number) =>
    request<{ ok: boolean }>('/entries/read', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], progress }),
    }),
  toggleStar: (id: string) =>
    request<{ isStarred: boolean }>(`/entries/${id}/star`, { method: 'POST' }),
  stats: () => request<{
    entries: number;
    feeds: number;
    unread: number;
    starred?: number;
    queue: { pending: number; running: number; dead: number };
  }>('/stats'),

  // ── 订阅 ────────────────────────────────────────────────
  listFeeds: (params: { folderId?: string | null } = {}) => {
    const sp = new URLSearchParams();
    if (params.folderId !== undefined && params.folderId !== null) {
      sp.set('folderId', params.folderId);
    }
    const qs = sp.toString();
    return request<FeedListResponse>('/feeds' + (qs ? '?' + qs : ''));
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
  listFolders: () => request<{ items: FolderItem[] }>('/folders'),
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
  addFeed: (url: string) =>
    request<{ created: boolean; feed: FeedItem; imported?: number }>('/feeds', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  refreshFeed: (id: string) =>
    request<{ ok: boolean; queued: boolean }>(`/feeds/${id}/refresh`, { method: 'POST' }),
  refreshAllFeeds: () =>
    request<{ ok: boolean; queued: number; total: number }>('/feeds/refresh-all', { method: 'POST' }),
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
