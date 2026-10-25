import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiFailure, type EntryDetail, type EntrySummary, type User } from './api.ts';
import {
  IconArrowLeft, IconBookmark, IconChevronRight, IconCircle, IconClock,
  IconExternal, IconInbox, IconLogout, IconMenu, IconRss, IconSearch, IconSparkle, IconStar,
} from './icons.tsx';
import { FeedsPage } from './FeedsPage.tsx';

// 主界面 = 三栏（PLAN §15.1/§15.2/§15.3）
//
//   侧栏（导航 + 筛选）│ 列表（扫描）│ 阅读区（内容优先）
//
// 三栏而非两栏的理由：点开一条时列表不能消失——阅读时反复回看列表
// 挑下一篇是 RSS 阅读器最常见的动作，跳页式导航会把它变成两次点击。
//
// M0 的数据能力只有「条目读取 + 已读/收藏」，所以导航里除收件箱外的
// 入口都标了"待接入"，不让用户点了没反应。

type View = 'inbox' | 'unread' | 'starred' | 'history';

interface NavItem {
  key: View;
  label: string;
  icon: React.ReactNode;
  /** 角标取哪个计数 */
  count?: 'unread' | 'starred';
}

const NAV: NavItem[] = [
  { key: 'inbox', label: '收件箱', icon: <IconInbox />, count: 'unread' },
  { key: 'unread', label: '未读', icon: <IconCircle />, count: 'unread' },
  { key: 'starred', label: '已收藏', icon: <IconStar />, count: 'starred' },
  { key: 'history', label: '历史', icon: <IconClock /> },
];

// 未接入的导航项：给用户"以后会有"的确定感，而不是装作不存在
const SOON: { label: string; icon: React.ReactNode }[] = [
  { label: '简报', icon: <IconSparkle /> },
];

/** 当前页：条目列表 or 订阅管理 */
type Page = 'entries' | 'feeds';

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
          // 库里有用户但未登录 → 登录页；没有用户 → 初始化页。
          // 判据由服务端给（与 POST /auth/setup 的门禁同源）。
          try {
            const h = await api.health();
            setNeedSetup(h.needsSetup === true);
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
        <span className="spinner" />
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

// ── 登录 / 初始化 ───────────────────────────────────────────

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
        <div className="auth-brand"><IconRss size={22} /> AI RSS</div>
        <p className="hint">自托管 RSS 阅读与 AI 分析</p>
        {err && <div className="alert error">{err}</div>}
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email" type="email" autoComplete="username" required autoFocus
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
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="auth-foot">
          首次使用？
          <button type="button" className="linkish" onClick={props.onNeedSetup}>
            初始化管理员账号
          </button>
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
        <div className="auth-brand"><IconRss size={22} /> 初始化</div>
        <p className="hint">这个数据库还没有任何账号，创建一个管理员。数据全部保存在本地。</p>
        {err && <div className="alert error">{err}</div>}
        <div className="field">
          <label htmlFor="su-email">邮箱</label>
          <input id="su-email" type="email" required autoFocus value={email}
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
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? '创建中…' : '创建并登录'}
        </button>
      </form>
    </div>
  );
}

// ── 主界面 ─────────────────────────────────────────────────

interface Stats { entries: number; feeds: number; unread: number; starred: number }

function Main(props: { user: User; onLogout: () => void }) {
  const [page, setPage] = useState<Page>('entries');
  const [view, setView] = useState<View>('inbox');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<EntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 240);
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

  const refreshStats = useCallback(() => {
    api.stats().then((s) => {
      if (s) setStats({ ...s, starred: s.starred ?? 0 });
    }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => { refreshStats(); }, [refreshStats, items]);

  const open = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await api.getEntry(id);
      setDetail(d);
      if (!d.isRead) {
        await api.markRead(id);
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: true } : x)));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '打开失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const toggleStar = useCallback(async (id: string) => {
    try {
      const r = await api.toggleStar(id);
      setDetail((d) => (d && d.id === id ? { ...d, isStarred: r.isStarred } : d));
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isStarred: r.isStarred } : x)));
    } catch { /* ignore */ }
  }, []);

  // 键盘全覆盖（PLAN §15.5）：不用鼠标也能浏览
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && /^(INPUT|TEXTAREA)$/.test(t.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (openId) { setOpenId(null); setDetail(null); }
        else if (typing) (t as HTMLInputElement).blur();
        return;
      }
      if (typing) return;
      // j/k 或上下键在列表里移动；阅读区里同样有效（下一篇是最高频动作）
      const idx = items.findIndex((x) => x.id === openId);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = items[idx + 1];
        if (next) void open(next.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = idx > 0 ? items[idx - 1] : items[0];
        if (prev) void open(prev.id);
      } else if (e.key === 's' && openId) {
        e.preventDefault();
        void toggleStar(openId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, openId, open, toggleStar]);

  const current = useMemo(
    () => NAV.find((n) => n.key === view) ?? NAV[0],
    [view],
  );

  return (
    <div className={`app ${page === 'feeds' ? 'feeds-mode' : ''}`}>
      {/* ── 侧栏 ─────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="brand">
          <IconRss size={19} />
          <span>AI RSS</span>
        </div>

        <nav className="nav">
          {NAV.map((n) => {
            const badge = n.count === 'unread' ? stats?.unread
              : n.count === 'starred' ? stats?.starred
              : undefined;
            return (
              <button
                key={n.key}
                className={`nav-item ${page === 'entries' && view === n.key ? 'active' : ''}`}
                onClick={() => { setPage('entries'); setView(n.key); }}
                title={n.label}
              >
                <span className="nav-icon">{n.icon}</span>
                <span className="nav-label">{n.label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className="badge">{badge > 999 ? '999+' : badge}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="nav-section">订阅源</div>
        <nav className="nav">
          <button
            className={`nav-item ${page === 'feeds' ? 'active' : ''}`}
            onClick={() => setPage('feeds')}
            title="订阅"
          >
            <span className="nav-icon"><IconRss /></span>
            <span className="nav-label">订阅</span>
            {stats && stats.feeds > 0 && <span className="badge">{stats.feeds}</span>}
          </button>
        </nav>

        <div className="nav-section">即将支持</div>
        <nav className="nav">
          {SOON.map((s) => (
            <button key={s.label} className="nav-item soon" disabled title="M2~M3 落地">
              <span className="nav-icon">{s.icon}</span>
              <span className="nav-label">{s.label}</span>
              <span className="soon-tag">待接入</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="avatar">{(props.user.name ?? props.user.email ?? '?').slice(0, 1).toUpperCase()}</div>
          <div className="who">
            <div className="who-name">{props.user.name ?? 'Owner'}</div>
            <div className="who-mail">{props.user.email}</div>
          </div>
          <button className="icon-btn" onClick={props.onLogout} title="退出登录">
            <IconLogout size={16} />
          </button>
        </div>
      </aside>

      {/* ── 订阅页：跨后两栏 ─────────────────────────────── */}
      {page === 'feeds' ? (
        <FeedsPage onOpenInbox={() => setPage('entries')} />
      ) : (
        <>
      {/* ── 列表栏 ───────────────────────────────────────── */}
      <section className={`list-pane ${openId ? 'narrow' : ''}`}>
        <header className="pane-head">
          <div className="pane-title">
            <h1>{current.label}</h1>
            {stats && (
              <span className="pane-count">
                {debounced ? `${items.length} 条结果` : `${stats.entries} 条`}
              </span>
            )}
          </div>
          <div className="search-box">
            <IconSearch size={15} className="search-icon" />
            <input
              ref={searchRef}
              placeholder="搜索标题、摘要…  /"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </header>

        <div className="list-scroll">
          {err && <div className="alert error inset">{err}</div>}

          {!loading && items.length === 0 && (
            <EmptyState
              hasQuery={Boolean(debounced)}
              view={view}
              onGoFeeds={() => setPage('feeds')}
            />
          )}

          <ul className="entry-list">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  className={`entry-item ${it.isRead ? 'read' : ''} ${openId === it.id ? 'active' : ''}`}
                  data-tier={it.tier ?? 'normal'}
                  onClick={() => void open(it.id)}
                >
                  <div className="entry-top">
                    {it.faviconUrl
                      ? <img className="favicon" src={it.faviconUrl} alt="" loading="lazy"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="favicon fallback">{(it.siteName ?? hostOf(it.url) ?? '?').slice(0, 1).toUpperCase()}</span>}
                    <span className="entry-site">{it.siteName ?? hostOf(it.url)}</span>
                    <span className="dot">·</span>
                    <span className="entry-time">{timeAgo(it.publishedAt)}</span>
                    {/* tier 徽标放在元信息行里，不再单独占一行 ——
                        一屏 8~10 条（§15.2）靠的是每项不超过 ~100px */}
                    {it.tier && it.tier !== 'normal' && (
                      <span className={`tier tier-${it.tier}`}>{tierLabel(it.tier)}</span>
                    )}
                    {it.highlightCount > 0 && <span className="meta">{it.highlightCount} 高亮</span>}
                    <span className="grow" />
                    {it.isStarred && <IconStar size={13} filled className="star-mark" />}
                  </div>
                  <h3 className="entry-title">{it.title}</h3>
                  {(it.summary || it.excerpt) && (
                    <p className="entry-summary">{it.summary ?? it.excerpt}</p>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {cursor && (
            <div className="load-more">
              <button className="btn" onClick={() => void load(false)} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}

          {loading && items.length === 0 && (
            <div className="empty"><span className="spinner" /></div>
          )}
        </div>
      </section>

      {/* ── 阅读区 ───────────────────────────────────────── */}
      <section className={`reader-pane ${openId ? 'open' : ''}`}>
        {!openId && (
          <div className="reader-placeholder">
            <div className="ph-art"><IconBookmark size={30} /></div>
            <h2>选一篇开始读</h2>
            <p>用 <kbd>j</kbd> / <kbd>↓</kbd> 在列表里移动，<kbd>Esc</kbd> 返回，<kbd>/</kbd> 搜索。</p>
          </div>
        )}
        {openId && (
          <Reader
            loading={detailLoading}
            detail={detail}
            onBack={() => { setOpenId(null); setDetail(null); }}
            onStar={() => void toggleStar(openId)}
          />
        )}
      </section>
        </>
      )}

      {/* ── 移动端底部导航（≤640px 才显示，见 styles.css）───────── */}
      <nav className="tabbar">
        {NAV.map((n) => {
          const badge = n.count === 'unread' ? stats?.unread
            : n.count === 'starred' ? stats?.starred
            : undefined;
          return (
            <button
              key={n.key}
              className={`tab ${page === 'entries' && view === n.key ? 'active' : ''}`}
              onClick={() => { setPage('entries'); setView(n.key); setOpenId(null); }}
            >
              <span className="tab-icon">
                {n.icon}
                {badge !== undefined && badge > 0 && (
                  <span className="tab-badge">{badge > 99 ? '99+' : badge}</span>
                )}
              </span>
              <span className="tab-label">{n.label}</span>
            </button>
          );
        })}
        <button
          className={`tab ${page === 'feeds' ? 'active' : ''}`}
          onClick={() => { setPage('feeds'); setOpenId(null); }}
        >
          <span className="tab-icon"><IconRss size={18} /></span>
          <span className="tab-label">订阅</span>
        </button>
      </nav>
    </div>
  );
}

function EmptyState(props: {
  hasQuery: boolean;
  view: View;
  onGoFeeds?: () => void;
}) {
  if (props.hasQuery) {
    return (
      <div className="empty">
        <div className="ph-art"><IconSearch size={26} /></div>
        <h2>没有匹配的条目</h2>
        <p>试试更短的关键词，或换个词。</p>
      </div>
    );
  }
  if (props.view === 'starred') {
    return (
      <div className="empty">
        <div className="ph-art"><IconStar size={26} /></div>
        <h2>还没有收藏</h2>
        <p>阅读时点右上角的星标，重要的文章会留在这里。</p>
      </div>
    );
  }
  if (props.view === 'history') {
    return (
      <div className="empty">
        <div className="ph-art"><IconClock size={26} /></div>
        <h2>还没有阅读记录</h2>
        <p>读过的文章会按时间出现在这里。</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <div className="ph-art"><IconInbox size={26} /></div>
      <h2>收件箱是空的</h2>
      <p>还没有订阅任何源。添加一个 RSS 源后，新文章会自动出现在这里。</p>
      {props.onGoFeeds && (
        <div className="empty-actions">
          <button className="btn primary" onClick={props.onGoFeeds}>去添加订阅</button>
        </div>
      )}
    </div>
  );
}

// ── 阅读页 ─────────────────────────────────────────────────

function Reader(props: {
  detail: EntryDetail | null;
  loading: boolean;
  onBack: () => void;
  onStar: () => void;
}) {
  const { detail, loading } = props;
  const [aiOpen, setAiOpen] = useState(true);

  if (loading || !detail) {
    return (
      <div className="reader-loading">
        <span className="spinner" />
      </div>
    );
  }

  const a = detail.analysis;

  return (
    <div className="reader-wrap">
      <div className="reader-bar">
        <button className="icon-btn" onClick={props.onBack} title="返回（Esc）">
          <IconArrowLeft size={17} />
        </button>
        <div className="grow" />
        <a className="icon-btn" href={detail.url} target="_blank" rel="noreferrer" title="打开原文">
          <IconExternal size={16} />
        </a>
        <button
          className={`icon-btn ${detail.isStarred ? 'on' : ''}`}
          onClick={props.onStar}
          title={detail.isStarred ? '取消收藏' : '收藏'}
        >
          <IconStar size={17} filled={detail.isStarred} />
        </button>
      </div>

      <div className="reader-scroll">
        <article className="reader">
          <h1 className="reader-title">{detail.title}</h1>
          <div className="reader-meta">
            {detail.siteName && <span className="src">{detail.siteName}</span>}
            {detail.author && <span>{detail.author}</span>}
            <span>{new Date(detail.publishedAt).toLocaleString('zh-CN', {
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit',
            })}</span>
            {a?.readingTime ? <span>约 {a.readingTime} 分钟</span> : null}
          </div>

          {a && (
            <div className={`ai-card ${aiOpen ? '' : 'collapsed'}`}>
              <button className="ai-head" onClick={() => setAiOpen((v) => !v)}>
                <IconSparkle size={15} />
                <span>AI 摘要</span>
                {a.tier && <span className={`tier tier-${a.tier}`}>{tierLabel(a.tier)}</span>}
                <div className="grow" />
                <IconChevronRight size={14} className={`chev ${aiOpen ? 'down' : ''}`} />
              </button>
              {aiOpen && (
                <div className="ai-body">
                  <p className="ai-summary">{a.summary}</p>
                  {a.keyPoints.length > 0 && (
                    <ul className="ai-points">
                      {a.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
                    </ul>
                  )}
                  {(a.topics.length > 0 || a.importance > 0) && (
                    <div className="ai-foot">
                      {a.topics.map((t) => <span key={t} className="topic">{t}</span>)}
                      {a.importance > 0 && <span className="meta">重要度 {a.importance}</span>}
                    </div>
                  )}
                </div>
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
              <a href={detail.url} target="_blank" rel="noreferrer">去原文阅读 ↗</a>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

// ── 工具 ───────────────────────────────────────────────────

function tierLabel(tier: string): string {
  return ({ must_read: '必读', worth: '值得', noise: '噪音' } as Record<string, string>)[tier] ?? tier;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
