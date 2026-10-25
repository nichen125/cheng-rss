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
  }) => {
    const sp = new URLSearchParams();
    if (params.view) sp.set('view', params.view);
    if (params.q) sp.set('q', params.q);
    if (params.cursor) sp.set('cursor', params.cursor);
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
};
