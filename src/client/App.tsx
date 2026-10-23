import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiFailure, type EntryDetail, type EntrySummary, type User } from './api.ts';

// 应用主体。
//
// M0 的目标是「能验收」而不是「功能完整」：
// 登录 / 收件箱列表 / 搜索 / 阅读页 / 已读标记。
// 订阅管理、简报、高亮在 M1~M4 补（PLAN §19.3~§19.6）。

type View = 'inbox' | 'unread' | 'starred' | 'history';

const VIEWS: { key: View; label: string }[] = [
  { key: 'inbox', label: '收件箱' },
  { key: 'unread', label: '未读' },
  { key: 'starred', label: '已收藏' },
  { key: 'history', label: '历史' },
];

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [needSetup, setNeedSetup] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.me();
        setUser(r.user);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401) {
          // 库里有用户但未登录 → 登录页；没有用户 → 初始化页
          // 用 /auth/setup 的返回判断更准，这里用一次探测
          try {
            const h = await api.health();
            setNeedSetup((h.stats?.entries ?? 0) === 0 && false);
          } catch { /* ignore */ }
        }
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  if (booting) {
    return (
      <div className="center-page">
        <div className="row"><span className="spinner" /> <span className="muted">加载中…</span></div>
      </div>
    );
  }

  if (!user) {
    return needSetup
      ? <SetupPage onDone={setUser} />
      : <LoginPage onDone={setUser} onNeedSetup={() => setNeedSetup(true)} />;
  }

  return <Main user={user} onLogout={() => setUser(null)} />;
}

// ── 登录 ──────────────────────────────────────────────────
function LoginPage(props: { onDone: (u: User) => void; onNeedSetup: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api.login(email, password);
      props.onDone(r.user);
    } catch (e2) {
      if (e2 instanceof ApiFailure && e2.status === 400) {
        setErr('还没有账号，请先初始化。');
      } else {
        setErr(e2 instanceof Error ? e2.message : '登录失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>登录 AI RSS</h1>
        <p className="hint">自托管 RSS 阅读与 AI 分析</p>
        {err && <div className="alert error">{err}</div>}
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
          首次使用？<button
            type="button"
            style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer' }}
            onClick={props.onNeedSetup}
          >初始化管理员账号</button>
        </p>
      </form>
    </div>
  );
}

function SetupPage(props: { onDone: (u: User) => void }) {
  const [email, setEmail] = useState('admin@localhost');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (password.length < 8) { setErr('密码至少 8 位'); return; }
    if (password !== password2) { setErr('两次密码不一致'); return; }
    setBusy(true);
    try {
      await api.setup(email, password);
      const r = await api.login(email, password);
      props.onDone(r.user);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '初始化失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>初始化</h1>
        <p className="hint">这个数据库还没有任何账号，创建一个管理员</p>
        {err && <div className="alert error">{err}</div>}
        <div className="field">
          <label htmlFor="su-email">邮箱</label>
          <input id="su-email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="su-pw">密码（至少 8 位）</label>
          <input id="su-pw" type="password" required value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="su-pw2">确认密码</label>
          <input id="su-pw2" type="password" required value={password2}
            onChange={(e) => setPassword2(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>{busy ? '创建中…' : '创建并登录'}</button>
      </form>
    </div>
  );
}

// ── 主界面 ────────────────────────────────────────────────
function Main(props: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('inbox');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<EntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [stats, setStats] = useState<{ unread: number; entries: number } | null>(null);

  // 搜索防抖：输入过程中不打请求
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 260);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.listEntries({
        view,
        q: debounced || undefined,
        cursor: reset ? null : cursor,
        limit: 30,
      });
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [view, debounced, cursor]);

  useEffect(() => { void load(true); /* eslint-disable-next-line */ }, [view, debounced]);

  useEffect(() => {
    api.stats().then((s) => {
      if (s) setStats({ unread: s.unread, entries: s.entries });
    }).catch(() => { /* ignore */ });
  }, [items]);

  const open = async (id: string) => {
    setOpenId(id);
    setDetail(null);
    try {
      const d = await api.getEntry(id);
      setDetail(d);
      // 标记已读（幂等，PLAN §7.4）
      if (!d.isRead) {
        await api.markRead(id);
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: true } : x)));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '打开失败');
    }
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setQuery('');
  };

  if (openId) {
    return (
      <Reader
        detail={detail}
        onBack={() => { setOpenId(null); setDetail(null); }}
        onStar={async () => {
          if (!detail) return;
          try {
            const r = await api.toggleStar(detail.id);
            setDetail({ ...detail, isStarred: r.isStarred });
          } catch { /* ignore */ }
        }}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">AI RSS</div>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`nav-item ${view === v.key ? 'active' : ''}`}
            onClick={() => setView(v.key)}
          >
            <span>{v.label}</span>
            {v.key === 'unread' && stats && stats.unread > 0 && (
              <span className="badge">{stats.unread > 999 ? '999+' : stats.unread}</span>
            )}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div className="muted" style={{ padding: '10px', fontSize: 12 }}>
          {props.user.email}
        </div>
        <button className="nav-item" onClick={props.onLogout}>退出登录</button>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="search-box">
            <span className="search-icon">⌕</span>
            <input
              placeholder="搜索标题、摘要…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
          </div>
          {stats && (
            <span className="muted">{stats.entries} 条 · {stats.unread} 未读</span>
          )}
        </div>

        <div className="content">
          {err && <div className="alert error" style={{ margin: 18 }}>{err}</div>}

          {items.length === 0 && !loading && (
            <EmptyState hasQuery={Boolean(debounced)} view={view} />
          )}

          <ul className="entry-list">
            {items.map((it) => (
              <li
                key={it.id}
                className={`entry-item ${it.isRead ? 'read' : ''}`}
                data-tier={it.tier ?? 'normal'}
                onClick={() => void open(it.id)}
              >
                <h3 className="entry-title">{it.title}</h3>
                {(it.summary || it.excerpt) && (
                  <p className="entry-summary">{it.summary ?? it.excerpt}</p>
                )}
                <div className="entry-meta">
                  {it.siteName && <span>{it.siteName}</span>}
                  <span>{timeAgo(it.publishedAt)}</span>
                  {it.isStarred && <span>★</span>}
                  {it.highlightCount > 0 && <span>{it.highlightCount} 高亮</span>}
                </div>
              </li>
            ))}
          </ul>

          {cursor && (
            <div style={{ padding: 18, textAlign: 'center' }}>
              <button onClick={() => void load(false)} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}

          {loading && items.length === 0 && (
            <div className="empty"><span className="spinner" /></div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState(props: { hasQuery: boolean; view: View }) {
  if (props.hasQuery) {
    return (
      <div className="empty">
        <h2>没有匹配的条目</h2>
        <p>试试更短的关键词，或换个词。</p>
      </div>
    );
  }
  if (props.view === 'history') {
    return (
      <div className="empty">
        <h2>还没有阅读记录</h2>
        <p>读过的文章会按时间出现在这里。</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>还没有内容</h2>
      <p>M1 会加入订阅管理与抓取。现在可以先通过 Huntly 插件保存网页来验证链路。</p>
    </div>
  );
}

// ── 阅读页 ────────────────────────────────────────────────
function Reader(props: {
  detail: EntryDetail | null;
  onBack: () => void;
  onStar: () => void;
}) {
  const { detail } = props;

  if (!detail) {
    return (
      <div className="center-page">
        <div className="row"><span className="spinner" /> <span className="muted">加载中…</span></div>
      </div>
    );
  }

  const a = detail.analysis;

  return (
    <div className="main" style={{ height: '100%' }}>
      <div className="topbar">
        <button onClick={props.onBack}>← 返回</button>
        <div className="grow" />
        <button onClick={props.onStar}>{detail.isStarred ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      <div className="content">
        <article className="reader">
          <h1 className="reader-title">{detail.title}</h1>
          <div className="reader-meta">
            {detail.siteName && <span>{detail.siteName}</span>}
            {detail.author && <span>{detail.author}</span>}
            <span>{new Date(detail.publishedAt).toLocaleString('zh-CN')}</span>
            {a?.readingTime ? <span>{a.readingTime} 分钟</span> : null}
            <a href={detail.url} target="_blank" rel="noreferrer">原文 ↗</a>
          </div>

          {a && (
            <div className="ai-card">
              <h3>AI 摘要</h3>
              <p>{a.summary}</p>
              {a.keyPoints.length > 0 && (
                <ul>
                  {a.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
                </ul>
              )}
              {a.topics.length > 0 && (
                <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                  {a.topics.join(' · ')} · 重要度 {a.importance}
                </p>
              )}
            </div>
          )}

          {detail.contentHtml ? (
            <div
              className="article-body"
              // 正文来自我们自己抓取并清洗的 HTML；M1 会加一层白名单清洗
              dangerouslySetInnerHTML={{ __html: detail.contentHtml }}
            />
          ) : (
            <div className="alert info">
              这篇还没有正文缓存。
              <a href={detail.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
                去原文阅读 ↗
              </a>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
