import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiFailure, type EntryDetail, type EntrySummary, type FeedItem, type FolderItem,
  type HistoryGroup, type User,
} from './api.ts';
import {
  IconArrowLeft, IconBookmark, IconCheck, IconChevronRight, IconCircle, IconClock, IconClose,
  IconExternal, IconFolder, IconInbox, IconMenu, IconRefresh, IconRss, IconSearch,
  IconSettings, IconSparkle, IconStar,
} from './icons.tsx';
import { SettingsModal, type SettingsSection } from './settings/SettingsModal.tsx';
import {
  applyPrefs, DEFAULT_PREFS, FONT_SIZES, loadPrefs, savePrefs,
  THEMES, WIDTHS, type ReaderPrefs,
} from './reader-prefs.ts';

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

/** 默认视图。单独抽出来，避免 NAV[0] 在 noUncheckedIndexedAccess 下是 undefined */
const INBOX_NAV: NavItem = {
  key: 'inbox', label: '收件箱', icon: <IconInbox />, count: 'unread',
};

const NAV: NavItem[] = [
  INBOX_NAV,
  { key: 'unread', label: '未读', icon: <IconCircle />, count: 'unread' },
  { key: 'starred', label: '已收藏', icon: <IconStar />, count: 'starred' },
  { key: 'history', label: '历史', icon: <IconClock /> },
];

// 未接入的导航项：给用户"以后会有"的确定感，而不是装作不存在
const SOON: { label: string; icon: React.ReactNode }[] = [
  { label: '简报', icon: <IconSparkle /> },
];

/**
 * 条目的额外过滤（与 view 正交）。
 *
 * 为什么不把「某分组」做成新的 View 值：分组数量是用户数据，
 * View 是代码常量。混在一起会让 View 的类型退化成 string，
 * 也就失去了 switch 的穷尽性检查。
 */
interface Scope {
  feedId?: string;
  folderId?: string;
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('feeds');
  const [view, setView] = useState<View>('inbox');
  const [scope, setScope] = useState<Scope>({});
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<EntrySummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const readerRef = useRef<HTMLElement>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  /**
   * 全部订阅源（§15.13 v1.13：侧栏分组树的数据源）。
   *
   * 为什么从"按组取"改成"一次全取"：改成树之后任何组都可能被展开，
   * 按组取会变成 N 次请求；单人自托管的源总量在几十到几百条，
   * 一次全量（/feeds 已带 unread/total/folderId）更省，也不需要额外接口。
   */
  const [feeds, setFeeds] = useState<FeedItem[]>([]);
  /** 源列表是否已取回。区分"组里确实没有源"和"还没加载"，自愈逻辑要用 */
  const [feedsLoaded, setFeedsLoaded] = useState(false);
  /** 侧栏里展开着的分组（§15.13）。单元素集合 = 手风琴，同时只展开一个 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 手动刷新中（§15.14）：只驱动按钮旋转态，不参与列表渲染 */
  const [refreshing, setRefreshing] = useState(false);
  /** 自增后让源列表（侧栏树上的未读数）也重取一次 */
  const [reloadTick, setReloadTick] = useState(0);
  /**
   * 历史视图的分组（PLAN §7.4）。
   *
   * null = 当前不在历史视图（或还没加载）。用 null 而不是空数组，是为了
   * 区分"历史里确实没有记录"和"还没取到" —— 空数组会让加载中的一瞬间
   * 闪出「还没有阅读记录」。
   */
  const [historyGroups, setHistoryGroups] = useState<HistoryGroup[] | null>(null);

  // 偏好变更 → 立刻写 CSS 变量 + 落盘。
  // 放在 effect 里而不是 setPrefs 的调用处：刷新页面时初次挂载也要应用一次。
  useEffect(() => {
    applyPrefs(readerRef.current, prefs);
    savePrefs(prefs);
  }, [prefs]);

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
        feedId: scope.feedId ?? null,
        folderId: scope.folderId ?? null,
      });
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      // total 是后端算的命中总数，不是本页条数 —— 分页后
      // items.length 会一直涨到 30/60/90，用它当"多少条"会骗人。
      setTotal(typeof r.total === 'number' ? r.total : null);
      setCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [view, debounced, cursor, scope]);

  useEffect(() => { void load(true); /* eslint-disable-next-line */ }, [view, debounced, scope]);

  /**
   * 历史视图的数据（PLAN §7.4）。
   *
   * 走 /entries/history 而不是 /entries?view=history：两者返回结构不同 ——
   * 后者是平铺列表，前端还得自己按本地日期分桶（一份逻辑写两遍，
   * 服务端已经算好了）。这里只负责取回来渲染。
   */
  useEffect(() => {
    if (view !== 'history') { setHistoryGroups(null); return; }
    let alive = true;
    setLoading(true);
    setErr('');
    api.listHistory({ limit: 60 })
      .then((r) => {
        if (!alive) return;
        setHistoryGroups(r.groups);
        setTotal(typeof r.total === 'number' ? r.total : null);
        setCursor(r.nextCursor);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : '加载历史失败');
        setHistoryGroups([]);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [view, reloadTick]);

  const refreshStats = useCallback(() => {
    api.stats().then((s) => {
      if (s) setStats({ ...s, starred: s.starred ?? 0 });
    }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => { refreshStats(); }, [refreshStats, items]);

  /**
   * 手动刷新（§15.14）。
   *
   * 只做"重新拉一遍当前视图"，不重置任何筛选 —— 用户刚点了「科技IT」+「未读」
   * 再点刷新，结果还是那个范围。这也是它和"切视图"的本质区别：
   * 切视图是换条件，刷新是同一条件重新取数。
   *
   * 三条约束：
   * 1. **不清空列表**。load(true) 在响应回来之后才 setItems，中途 items
   *    保持旧值，所以不会闪白 —— 但这条必须由断言守住，因为"清空再填"
   *    是将来最容易顺手写出来的实现。
   * 2. 同时重算侧栏角标与分组内未读数（refreshStats + reloadTick），
   *    否则刷新完列表变了、侧栏数字还是旧的。
   * 3. refreshing 只驱动按钮的旋转态，不参与列表渲染判断 ——
   *    否则又变成"刷新时列表消失"。
   */
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load(true);
      refreshStats();
      setReloadTick((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, load, refreshStats]);

  // 侧栏的分组列表：配置弹窗里可能刚建/删了组，关弹窗要刷新。
  //
  // `refreshShell` 同时被两处调用：弹窗关闭时，以及 FeedsProvider 每
  // 次 reload 之后（onChanged）。后者是必要的 —— 在配置里把源移出组后，
  // 即使还没关弹窗，侧栏的分组未读数就应该是新的。
  //
  // 还要顺带 bump `reloadTick`，让**分组内的源列表**（§15.13 的 chip 行）
  // 也重取一次。少了这一下会有一个具体的坏结果：在配置里把当前筛中的源
  // 移出分组 → 关弹窗 → 顶部还挂着那个源的 chip，列表却是空的，
  // 而"自动退回整组"的自愈永远等不到新的源列表。m1-11 ⑥ 就是抓这个的。
  const refreshShell = useCallback(() => {
    api.listFolders()
      .then((r) => setFolders(r.items))
      .catch(() => { /* 分组是增强功能，取不到不影响主流程 */ });
    refreshStats();
    setReloadTick((n) => n + 1);
  }, [refreshStats]);

  useEffect(() => { refreshShell(); }, [refreshShell]);

  // 全部订阅源（§15.13 v1.13）：侧栏分组树的数据源。
  //
  // 一次全取而不是按组取 —— 树里任何组都可能被展开，按组取会变成 N 次请求。
  // `reloadTick` 让关闭配置弹窗后（可能换了分组/删了源）树上的未读数一起更新。
  useEffect(() => {
    let alive = true;
    api.listFeeds()
      .then((r) => {
        if (!alive) return;
        setFeeds(r.items);
        setFeedsLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        // 取不到就当作"已加载但为空"：否则自愈逻辑会一直等不到判据，
        // 一个指向已删源的筛选态会永久留在界面上。
        setFeeds([]);
        setFeedsLoaded(true);
      });
    return () => { alive = false; };
  }, [reloadTick]);

  // 按分组归拢源（§15.13）。用 Map 而不是每次 render 都 filter 一遍：
  // 侧栏每组都要拿一次自己那份，11 组 × 21 源 = 231 次比较，虽然小，
  // 但它在每次滚动/打字时都会重跑。
  const feedsByFolder = useMemo(() => {
    const m = new Map<string, FeedItem[]>();
    for (const f of feeds) {
      if (!f.folderId) continue;
      const list = m.get(f.folderId);
      if (list) list.push(f); else m.set(f.folderId, [f]);
    }
    return m;
  }, [feeds]);

  /** 当前分组内的源（标题「组名 · 源名」与自愈判据都要用） */
  const folderFeeds = useMemo(
    () => (scope.folderId ? feedsByFolder.get(scope.folderId) ?? [] : []),
    [scope.folderId, feedsByFolder],
  );

  // 源筛选的自愈：当前筛的源已不在**这个组**里（被移出 / 被删），退回整组。
  //
  // 不自愈的话会出现"侧栏里那个源还高亮着，列表却永远是空的" ——
  // 请求带的是 {folderId: 新组, feedId: 旧组的源}，交集必然为空，
  // 用户看到的是"这个组里没有文章"，而不是"你的筛选失效了"。
  //
  // 判据必须是「这个组里有没有它」，不是「库里有没有它」：源被移出分组
  // 时它还在库里（只是 folder_id 变了），用全局 feeds 判会永远不触发。
  // 第一版 v1.13 就是这么写的，m1-11 ⑩ 当场抓到。
  useEffect(() => {
    if (!scope.feedId) return;
    if (!feedsLoaded) return; // 还在加载，不能据此判定
    if (!folderFeeds.some((f) => f.id === scope.feedId)) {
      // 只丢源、保留分组 —— 顺手把 folderId 也清掉会让用户以为自己
      // 被弹出了分组（树收起、标题变回收件箱）。m1-11 的
      // 「自愈只丢源、不丢分组」那条就是专门抓这个的。
      setScope((s) => ({ folderId: s.folderId }));
    }
  }, [folderFeeds, feedsLoaded, scope.feedId, scope.folderId]);

  /**
   * 展开/收起一个分组（§15.13 手风琴）。
   *
   * 只展开一个的理由：侧栏高度有限，同时展开 3 组 × 11 个源 = 33 行，
   * 会把固定视图（收件箱/未读/…）顶出视口。手风琴保证"正在看哪一组"
   * 永远可见，也让"展开的这个组"成为第二个高亮信号。
   */
  const toggleExpand = useCallback((folderId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else { next.clear(); next.add(folderId); }
      return next;
    });
  }, []);

  /**
   * 点侧栏的一个分组（§15.13）。
   *
   * 三件事必须一起发生，少一件用户都会困惑：
   *   1. 选中整组（scope = {folderId}）—— 取消可能存在的源筛选
   *   2. 展开这一组 —— 否则点了分组却看不到组内的源
   *   3. 切回 inbox —— 否则在「历史」视图点分组什么也不会发生
   */
  const pickFolder = useCallback((folderId: string) => {
    setView('inbox');
    setScope({ folderId });
    setExpanded((prev) => {
      const next = new Set(prev);
      next.clear();
      next.add(folderId);
      return next;
    });
  }, []);

  /** 点组内的一个源：再点同一个 = 取消源筛选，回整组（§15.13） */
  const pickFeed = useCallback((folderId: string, feedId: string) => {
    setView('inbox');
    setScope((s) => (s.feedId === feedId ? { folderId } : { folderId, feedId }));
  }, []);


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

  /**
   * 切换已读 / 未读（§15.11，快捷键 m）。
   *
   * 两个容易漏的点：
   * 1. 在「未读」视图下把当前篇标未读 → 它应该从列表消失。直接留在原处会
   *    让用户以为没生效（页面上什么都没变）。消失后焦点落到下一条。
   * 2. 标未读时**不清阅读历史** —— 后端接口也不清（见 entries.ts 注释）。
   */
  const toggleRead = useCallback(async (id: string) => {
    const cur = detail?.id === id ? detail : items.find((x) => x.id === id);
    if (!cur) return;
    try {
      if (cur.isRead) {
        await api.markUnread(id);
        setDetail((d) => (d && d.id === id ? { ...d, isRead: false } : d));
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: false } : x)));
        refreshStats();
      } else {
        await api.markRead(id);
        setDetail((d) => (d && d.id === id ? { ...d, isRead: true } : d));
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: true } : x)));
        refreshStats();
      }
    } catch { /* ignore */ }
    // 未读视图：标成未读后这条不该还在列表里
    if (view === 'unread' && cur.isRead) {
      setItems((prev) => prev.filter((x) => x.id !== id));
      const idx = items.findIndex((x) => x.id === id);
      const next = items[idx + 1];
      if (next && next.id !== id) void open(next.id);
      else { setOpenId(null); setDetail(null); }
    }
  }, [detail, items, view, open, refreshStats]);

  /** 新标签打开原文（§15.11，快捷键 v）。没有 URL 时不打开空白页。 */
  const openOriginal = useCallback((url?: string | null) => {
    const target = url ?? detail?.url;
    if (!target) return;
    window.open(target, '_blank', 'noopener,noreferrer');
  }, [detail]);

  // 键盘全覆盖（PLAN §15.5 / §15.11）：不用鼠标也能浏览
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && /^(INPUT|TEXTAREA)$/.test(t.tagName);
      // 快捷键只认无修饰键的裸字母，否则 Ctrl+V 会被当成"打开原文"
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
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
      } else if (bare && e.key === 'v' && openId) {
        e.preventDefault();
        openOriginal();
      } else if (bare && e.key === 'm' && openId) {
        e.preventDefault();
        void toggleRead(openId);
      } else if (bare && e.key === 't') {
        // 列表顶部。用 scrollIntoView 而不是 scrollTop=0：
        // 列表可能有两列布局，scrollTop 只作用于右侧容器，保险起见交给浏览器算。
        e.preventDefault();
        document.querySelector('.list-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (bare && (e.key === 'o' || e.key === 'Enter') && !openId) {
        const first = items[idx >= 0 ? idx : 0];
        if (first) { e.preventDefault(); void open(first.id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, openId, open, toggleStar, toggleRead, openOriginal]);

  const current = useMemo(
    () => NAV.find((n) => n.key === view) ?? INBOX_NAV,
    [view],
  );

  /** 列表标题：有分组过滤时显示组名，让用户知道自己在看一个子集 */
  const listTitle = useMemo(() => {
    if (!scope.folderId) return current.label;
    const f = folders.find((x) => x.id === scope.folderId);
    const base = f ? f.name : current.label;
    // 再叠一层源筛选时，标题要同时说清"哪个组 + 哪个源"（§15.13），
    // 否则标题还写「科技IT」，而列表只剩一个源的内容，看起来像丢数据。
    if (!scope.feedId) return base;
    const feed = folderFeeds.find((x) => x.id === scope.feedId);
    return feed ? `${base} · ${feed.title ?? hostOf(feed.url) ?? '该源'}` : base;
  }, [scope.folderId, scope.feedId, folders, folderFeeds, current.label]);

  return (
    <div className="app">
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
                className={`nav-item ${
                  // 有分组筛选时固定视图不能高亮 —— 否则「收件箱」和
                  // 分组项会同时亮着，看起来像点了两个地方。
                  view === n.key && !scope.folderId ? 'active' : ''
                }`}
                onClick={() => {
                  setView(n.key);
                  // 点固定视图等于"看全部"，必须清掉分组过滤，
                  // 否则会出现"点了收件箱但还是只有 3 个源的内容"
                  setScope({});
                  // 同时收起分组树（§15.13）：范围已经回到全库，
                  // 侧栏还展开着一组的源会让人以为筛选仍在生效。
                  setExpanded(new Set());
                }}
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
          {/* 保留在侧栏，但语义变成"打开配置并停在订阅分类"（§15.15）。
              删除它会让"我想加个源"多一步（先进配置再选分类）；
              而它不再切换主界面，读与配置的层级关系是清楚的。 */}
          <button
            className={`nav-item ${settingsOpen && settingsSection === 'feeds' ? 'active' : ''}`}
            onClick={() => { setSettingsSection('feeds'); setSettingsOpen(true); }}
            title="管理订阅（打开配置）"
          >
            <span className="nav-icon"><IconRss /></span>
            <span className="nav-label">订阅</span>
            {stats && stats.feeds > 0 && <span className="badge">{stats.feeds}</span>}
          </button>
        </nav>

        {/* 分组树（§15.13 v1.13）：分组行就地展开，组内源作为子行挂在下面。
            改之前是"列表头部一行横向滚动的 chip" —— 组里 11 个源时那行
            吃掉 41px 高度，而且滚出去就看不见。改到侧栏之后：
              · 列表栏一行不占，一屏条目数回到 9
              · 未读数与源名同时可见，不用横向滚
              · 范围的选择全在左栏一处，符合"左=范围 / 中=列表 / 右=内容" */}
        {folders.length > 0 && (
          <>
            <div className="nav-section">分组</div>
            <nav className="nav tree" aria-label="分组与订阅源">
              {folders.map((f) => {
                const open = expanded.has(f.id);
                const kids = feedsByFolder.get(f.id) ?? [];
                // 选中整组（没有源筛选）时组行才是"当前范围"；
                // 选了组内某个源时高亮转移到子行，组行只保留展开箭头的高亮。
                const groupActive = scope.folderId === f.id && !scope.feedId;
                return (
                  <div className="tree-group" key={f.id}>
                    <button
                      className={`nav-item tree-row ${groupActive ? 'active' : ''} ${
                        // in-path 只表示"路径上但不是终点"：选了组内某个源时，
                        // 组行让出高亮、只留箭头变色的线索。整组选中时
                        // 它自己就是终点，两个类同时挂上去是自相矛盾的。
                        scope.folderId === f.id && scope.feedId ? 'in-path' : ''
                      }`}
                      onClick={() => {
                        // 点已展开且在看的组 = 收起；其余情况 = 选中并展开。
                        // 不这么做的话，"收起"没有入口 —— 组行既要选范围又要
                        // 开合，只能让第二次点击承担收起。
                        if (open && groupActive) toggleExpand(f.id);
                        else pickFolder(f.id);
                      }}
                      aria-expanded={open}
                      title={`「${f.name}」${open ? '收起' : '展开'}组内 ${kids.length} 个源`}
                    >
                      <span className="tree-caret" aria-hidden="true">
                        <IconChevronRight size={13} />
                      </span>
                      <span className="nav-label">{f.name}</span>
                      {f.unread > 0 && (
                        <span className="badge">{f.unread > 999 ? '999+' : f.unread}</span>
                      )}
                    </button>

                    {/* 子行：组内每个源一行。0 未读也显示 —— "没新内容"是信息。
                        组里 0 个源时不渲染，避免一条空脊线。 */}
                    {open && kids.length > 0 && (
                      <ul className="tree-kids">
                        {kids.map((fd) => {
                          const on = scope.feedId === fd.id;
                          return (
                            <li key={fd.id}>
                              <button
                                className={`tree-leaf ${on ? 'active' : ''}`}
                                onClick={() => pickFeed(f.id, fd.id)}
                                title={fd.title ?? hostOf(fd.url) ?? fd.url}
                                aria-pressed={on}
                              >
                                <span className="tree-leaf-name">
                                  {fd.title ?? hostOf(fd.url) ?? '未命名源'}
                                </span>
                                {/* 未读数用文字而不是 badge：子行里再挂一个
                                    胶囊会和父行的角标抢同一种视觉重量，
                                    展开后整块看起来像一排按钮。 */}
                                <span className={`tree-leaf-count ${fd.unread > 0 ? 'has' : ''}`}>
                                  {fd.unread > 999 ? '999+' : fd.unread}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </nav>
          </>
        )}

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
          {/* 侧栏底部只留一个齿轮（§15.15）：账户信息与订阅/分组管理
              全部收进配置弹窗。原来这里挂着"头像 + 邮箱 + 退出"三样，
              而订阅管理又是同级的一页 —— 一块区域同时说两件事。
              齿轮旁边保留头像，是为了保持"这是我"的方位感，
              但它不再是按钮，点了没反应就不该长得像按钮。 */}
          <div className="avatar" title={props.user.email ?? props.user.name ?? ''}>
            {(props.user.name ?? props.user.email ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="who">
            <div className="who-name">{props.user.name ?? 'Owner'}</div>
            <div className="who-mail">{props.user.email}</div>
          </div>
          <button
            className="icon-btn"
            onClick={() => { setSettingsSection('feeds'); setSettingsOpen(true); }}
            title="配置（订阅 / 分组 / 账户）"
            aria-label="打开配置"
          >
            <IconSettings size={16} />
          </button>
        </div>
      </aside>

      {/* ── 配置弹窗（§15.15）：订阅 / 分组 / 账户 + M2~M6 占位 ── */}
      {settingsOpen && (
        <SettingsModal
          user={props.user}
          section={settingsSection}
          onSection={setSettingsSection}
          onClose={() => { setSettingsOpen(false); refreshShell(); }}
          onLogout={props.onLogout}
          onChanged={refreshShell}
        />
      )}

      {/* 列表与阅读区。
          订阅不再是独立页 —— 它已经在配置弹窗里（§15.15），
          所以这里不再有 "page === feeds" 的分支。 */}
      <>
      {/* ── 列表栏 ───────────────────────────────────────── */}
      <section className={`list-pane ${openId ? 'narrow' : ''}`}>
        <header className="pane-head">
          <div className="pane-title">
            <h1>{listTitle}</h1>
            {/* 计数不再挂在 stats 上：数字来自 listEntries 的 total，
                stats 只是侧栏角标的来源。让两者脱钩之后，即使 /stats
                慢一拍或失败，列表自己的条数照常显示。 */}
            {(total !== null || items.length > 0) && (
              <span className="pane-count">
                {/* 数字统一来自后端的 `total`（命中总数），不是 items.length。
                    第一版用 items.length，截图里就出现过「科技IT 30 条」
                    而该组真实 40 条 —— 首页只取 30，滚到底才补齐。

                    v1.9 又收窄了一层：原来只在「有搜索词 / 有分组」时才用
                    total，其余情况用 stats.entries。加了「未读」分段之后，
                    这个条件就是错的 —— 切到「未读」时既没有搜索词也没有分组，
                    于是标题仍显示全库条数，而列表只有未读那几条。一律用
                    total 之后，「当前这个视图有多少条」天然成立，
                    不需要为每个新筛选再补一个分支。 */}
                {`${total ?? items.length} 条${debounced ? '结果' : ''}`}
              </span>
            )}
            {/* 清除筛选：从一整块实心按钮改成标题行里的小 ×（§15.12）。
                原来的 129×40 实心块夹在搜索框和列表之间，视觉重量和
                "取消一个筛选"这件小事完全不匹配 —— 它只是按钮基样式的副作用。 */}
            {(scope.folderId || scope.feedId) && (
              <button
                className="scope-clear"
                onClick={() => { setScope({}); setExpanded(new Set()); }}
                title="清除分组与源筛选"
                aria-label="清除筛选"
              >
                <IconClose size={13} />
              </button>
            )}

            {/* 全部 / 未读 分段控件 + 刷新（§15.14）。
                放进已经存在的标题行，垂直成本为 0 —— 单独占一行要吃掉
                约 34px，按 §15.2 每屏 8~10 条的预算，那等于每屏少一条。

                分段控件只在"条目列表"里有意义：收藏/历史本身已经是
                另一种筛选，在它们上面再叠一层"只没读的收藏"会把
                两个正交条件混成一个控件。所以非 inbox/unread 视图隐藏。 */}
            {(view === 'inbox' || view === 'unread') && (
              <div className="seg pane-seg" role="group" aria-label="阅读范围">
                <button
                  className={`seg-btn sm ${view === 'inbox' ? 'on' : ''}`}
                  aria-pressed={view === 'inbox'}
                  onClick={() => { if (view !== 'inbox') { setView('inbox'); setOpenId(null); } }}
                  title="显示全部条目（已读的也在）"
                >
                  全部
                </button>
                <button
                  className={`seg-btn sm ${view === 'unread' ? 'on' : ''}`}
                  aria-pressed={view === 'unread'}
                  onClick={() => { if (view !== 'unread') { setView('unread'); setOpenId(null); } }}
                  title="只显示未读"
                >
                  未读
                </button>
              </div>
            )}
            <button
              className={`icon-btn tiny refresh-btn ${refreshing ? 'spinning' : ''}`}
              onClick={() => void refresh()}
              disabled={refreshing}
              title="刷新当前列表"
              aria-label="刷新当前列表"
              data-refreshing={refreshing ? '1' : '0'}
            >
              <IconRefresh size={14} />
            </button>
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
          {/* 这里原本是「组内源筛选 chip 行」（v1.8）。v1.13 搬到侧栏分组树
              （§15.13）之后删除 —— 留一个空 div 或注释掉的代码比删掉更糟，
              下一个人会以为它还在起作用。判据见 m1-18 ②：组内有 11 个源时
              列表头部高度必须与无分组时完全相等。 */}
        </header>

        <div className="list-scroll">
          {err && <div className="alert error inset">{err}</div>}

          {!loading && items.length === 0 && view !== 'history' && (
            <EmptyState
              hasQuery={Boolean(debounced)}
              view={view}
              scopeLabel={scope.folderId ? listTitle : null}
              onGoFeeds={() => { setSettingsSection('feeds'); setSettingsOpen(true); }}
              onClearScope={scope.folderId ? () => { setScope({}); setExpanded(new Set()); } : undefined}
            />
          )}

          {/* 历史视图：按日期分组渲染（§7.4）。
              分组标签是数据的一部分，不是装饰 —— 用户看历史时问的第一个
              问题是"这是什么时候读的"，不是"发布什么时候"。所以行内
              时间显示 readAt（读的时间），发布日期降级为副信息。 */}
          {view === 'history' && (
            historyGroups !== null && historyGroups.length === 0 && !loading ? (
              <EmptyState hasQuery={false} view="history" scopeLabel={null} />
            ) : (
              (historyGroups ?? []).map((g) => (
                <section className="hist-group" key={g.key} data-bucket={g.key}>
                  <h2 className="hist-title">
                    {g.title}
                    <span className="hist-count">{g.count}</span>
                  </h2>
                  <ul className="entry-list">
                    {g.items.map((it) => (
                      <li key={it.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          className={`entry-item ${it.isRead ? 'read' : ''} ${openId === it.id ? 'active' : ''}`}
                          data-tier={it.tier ?? 'normal'}
                          onClick={() => void open(it.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void open(it.id);
                            }
                          }}
                        >
                          <div className="entry-top">
                            {it.faviconUrl
                              ? <img className="favicon" src={it.faviconUrl} alt="" loading="lazy"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              : <span className="favicon fallback">{(it.siteName ?? hostOf(it.url) ?? '?').slice(0, 1).toUpperCase()}</span>}
                            <span className="entry-site">{it.siteName ?? hostOf(it.url)}</span>
                            <span className="dot">·</span>
                            {/* 读的时间在前，发布多久以前放在 title 里 ——
                                历史页的坐标是"我什么时候读的" */}
                            <span className="entry-time" title={`发布于 ${timeAgo(it.publishedAt)}`}>
                              {timeAgo(it.readAt)}
                            </span>
                            {/* 读过多次：回看过的文章值得一个角标，它说明
                                "这篇我后来又翻过一次"，是收藏之外的另一个信号 */}
                            {it.readCount > 1 && (
                              <span className="meta read-count" title={`读过 ${it.readCount} 次`}>
                                ×{it.readCount}
                              </span>
                            )}
                            {it.readProgress !== null && it.readProgress > 0 && it.readProgress < 0.95 && (
                              <span className="meta read-progress" title={`读到 ${Math.round(it.readProgress * 100)}%`}>
                                {Math.round(it.readProgress * 100)}%
                              </span>
                            )}
                            <span className="grow" />
                            <span className="entry-ops">
                              <button
                                type="button"
                                className={`icon-btn tiny ${it.isStarred ? 'on' : ''}`}
                                title={it.isStarred ? '取消收藏' : '收藏'}
                                aria-pressed={it.isStarred}
                                onClick={(e) => { e.stopPropagation(); void toggleStar(it.id); }}
                              >
                                <IconStar size={13} filled={it.isStarred} />
                              </button>
                              <a
                                className="icon-btn tiny"
                                href={it.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="在新标签打开原文"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <IconExternal size={13} />
                              </a>
                            </span>
                          </div>
                          <a
                            className="entry-title"
                            href={it.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                e.preventDefault();
                                void open(it.id);
                              }
                            }}
                          >
                            {it.title}
                          </a>
                          {(it.summary || it.excerpt) && (
                            <p className="entry-summary">{it.summary ?? it.excerpt}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )
          )}

          {view !== 'history' && (
          <ul className="entry-list">
            {items.map((it) => (
              <li key={it.id}>
                {/* 行元素从 <button> 改成 div[role=button]（§15.11）：
                    <a> 不能嵌在 <button> 里（HTML 内容模型禁止交互元素嵌套），
                    而"标题可中键/Ctrl+点击在新标签打开"必须是一个真 <a>。
                    改完之后按钮语义要手工补：role + tabindex + Enter/Space。 */}
                <div
                  role="button"
                  tabIndex={0}
                  className={`entry-item ${it.isRead ? 'read' : ''} ${openId === it.id ? 'active' : ''}`}
                  data-tier={it.tier ?? 'normal'}
                  onClick={() => void open(it.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void open(it.id);
                    }
                  }}
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
                    {/* hover 才出现：收藏 / 新标签打开原文。
                        不常驻是因为列表页的任务是"扫过去"（§15.2），
                        常驻两个图标会让每行多 24px 的视觉噪声。

                        收藏状态**只由这颗星表达**（`filled` 就是它的状态）。
                        v1.9 之前这里还额外渲染了一个 `star-mark` 装饰星，
                        结果是"点完收藏出现两颗星"（§15.14）。同一个信息
                        说两遍不是冗余，是让人怀疑自己点错了。 */}
                    <span className="entry-ops">
                      <button
                        type="button"
                        className={`icon-btn tiny ${it.isStarred ? 'on' : ''}`}
                        title={it.isStarred ? '取消收藏' : '收藏'}
                        aria-pressed={it.isStarred}
                        onClick={(e) => { e.stopPropagation(); void toggleStar(it.id); }}
                      >
                        <IconStar size={13} filled={it.isStarred} />
                      </button>
                      <a
                        className="icon-btn tiny"
                        href={it.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="在新标签打开原文"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <IconExternal size={13} />
                      </a>
                    </span>
                  </div>
                  {/* 标题是真链接：左键拦截掉（走阅读区），中键与 Ctrl+点击交给浏览器 */}
                  <a
                    className="entry-title"
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      // 只拦"普通左键"。中键、Ctrl/Cmd/Shift+左键都放行，
                      // 由浏览器在新标签打开 —— 这正是用户要的行为。
                      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                        e.preventDefault();
                        void open(it.id);
                      }
                    }}
                  >
                    {it.title}
                  </a>
                  {(it.summary || it.excerpt) && (
                    <p className="entry-summary">{it.summary ?? it.excerpt}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          )}

          {cursor && view !== 'history' && (
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
      <section className={`reader-pane ${openId ? 'open' : ''}`} ref={readerRef}>
        {!openId && (
          <div className="reader-placeholder">
            <div className="ph-art"><IconBookmark size={30} /></div>
            <h2>选一篇开始读</h2>
            <p>用 <kbd>j</kbd> / <kbd>↓</kbd> 在列表里移动，<kbd>Esc</kbd> 返回，<kbd>/</kbd> 搜索，<kbd>v</kbd> 开原文。</p>
          </div>
        )}
        {openId && (
          <Reader
            loading={detailLoading}
            detail={detail}
            prefs={prefs}
            prefsOpen={prefsOpen}
            onTogglePrefsOpen={() => setPrefsOpen((v) => !v)}
            onPrefs={setPrefs}
            onBack={() => { setOpenId(null); setDetail(null); }}
            onStar={() => void toggleStar(openId)}
            onToggleRead={() => void toggleRead(openId)}
            onOpenOriginal={() => openOriginal()}
          />
        )}
      </section>
        </>

      {/* ── 移动端底部导航（≤640px 才显示，见 styles.css）───────── */}
      <nav className="tabbar">
        {NAV.map((n) => {
          const badge = n.count === 'unread' ? stats?.unread
            : n.count === 'starred' ? stats?.starred
            : undefined;
          return (
            <button
              key={n.key}
              className={`tab ${view === n.key ? 'active' : ''}`}
              onClick={() => {
                setView(n.key);
                setScope({});
                // 与侧栏同一份状态：手机上点底部导航也是"回到全库"，
                // 分组树要一起收起（§15.13）。
                setExpanded(new Set());
                setOpenId(null);
              }}
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
        {/* 订阅入口改成"打开配置并停在订阅分类"（§15.15）：位置不变，
            但它现在打开的是弹窗，不再切换主界面 —— 读和配置分开了。 */}
        <button
          className={`tab ${settingsOpen && settingsSection === 'feeds' ? 'active' : ''}`}
          onClick={() => { setSettingsSection('feeds'); setSettingsOpen(true); setOpenId(null); }}
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
  /** 当前是否在按分组/源筛选；有值时空态文案要说明"是这个范围里没有" */
  scopeLabel?: string | null;
  onGoFeeds?: () => void;
  onClearScope?: () => void;
}) {
  // 分组内为空 ≠ 没有订阅。这两种情况的引导动作完全不同：
  // 前者应该"看全部"，后者应该"去添加订阅"。
  if (props.scopeLabel && !props.hasQuery) {
    return (
      <div className="empty">
        <div className="ph-art"><IconFolder size={26} /></div>
        <h2>「{props.scopeLabel}」里还没有条目</h2>
        <p>
          这个分组下的源暂时没有新内容，或者刚添加还没抓到。
        </p>
        <div className="empty-actions">
          {props.onClearScope && (
            <button className="btn" onClick={props.onClearScope}>看全部条目</button>
          )}
          {props.onGoFeeds && (
            <button className="btn" onClick={props.onGoFeeds}>管理订阅</button>
          )}
        </div>
      </div>
    );
  }
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
  prefs: ReaderPrefs;
  prefsOpen: boolean;
  onTogglePrefsOpen: () => void;
  onPrefs: (p: ReaderPrefs) => void;
  onBack: () => void;
  onStar: () => void;
  onToggleRead: () => void;
  onOpenOriginal: () => void;
}) {
  const { detail, loading, prefs } = props;
  const [aiOpen, setAiOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const reportedRef = useRef(0);

  // 阅读进度（§15.11）：滚动时节流上报，1 次 / 2s。
  //
  // 只在"真的往下读"时上报（>5%），打开即关不算读过。
  // 进度条本身用本地 state 画 —— 等接口回来再画会卡顿。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !detail) { setProgress(0); reportedRef.current = 0; return; }
    setProgress(0);
    reportedRef.current = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      const p = max <= 0 ? 0 : Math.min(1, Math.max(0, el.scrollTop / max));
      setProgress(p);
      if (p < 0.05) return;
      if (timer) return;
      // 节流：2s 内最多一次，且必须比上次上报值大（后端也只增不减）
      timer = setTimeout(() => {
        timer = null;
        if (p > reportedRef.current + 0.01) {
          reportedRef.current = p;
          void api.reportProgress(detail.id, Number(p.toFixed(3))).catch(() => { /* 进度不是关键路径 */ });
        }
      }, 2000);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [detail]);

  // 换篇时重置 AI 卡展开状态 —— 否则上一篇折叠了，下一篇也是折叠的，
  // 用户会以为"这篇没有摘要"
  useEffect(() => { setAiOpen(true); }, [detail?.id]);

  if (loading || !detail) {
    return (
      <div className="reader-loading">
        <span className="spinner" />
      </div>
    );
  }

  const a = detail.analysis;
  const hasSite = Boolean(detail.feedSiteUrl);

  return (
    <div className="reader-wrap">
      <div className="reader-bar">
        <button className="icon-btn" onClick={props.onBack} title="返回（Esc）">
          <IconArrowLeft size={17} />
        </button>
        <div className="grow" />
        {/* 去源站：站点首页，不是这篇文章（§15.11 双出口）。
            没有 feed 的条目（网页捕获）不渲染，避免死链。 */}
        {hasSite && (
          <a
            className="icon-btn reader-site"
            href={detail.feedSiteUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={`去源站：${detail.feedTitle ?? detail.siteName ?? ''}`}
          >
            <IconRss size={16} />
          </a>
        )}
        <a
          className="icon-btn"
          href={detail.url}
          target="_blank"
          rel="noopener noreferrer"
          title="在新标签打开原文（v）"
        >
          <IconExternal size={16} />
        </a>
        <button
          className="icon-btn"
          onClick={props.onTogglePrefsOpen}
          title="阅读设置（字号 / 宽度 / 主题）"
          aria-expanded={props.prefsOpen}
        >
          <IconMenu size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={props.onToggleRead}
          title={detail.isRead ? '标为未读（m）' : '标为已读（m）'}
        >
          {detail.isRead ? <IconCircle size={16} /> : <IconCheck size={16} />}
        </button>
        <button
          className={`icon-btn ${detail.isStarred ? 'on' : ''}`}
          onClick={props.onStar}
          title={detail.isStarred ? '取消收藏' : '收藏（s）'}
        >
          <IconStar size={17} filled={detail.isStarred} />
        </button>
      </div>

      {props.prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={props.onPrefs} onClose={props.onTogglePrefsOpen} />
      )}

      {/* 阅读进度条：2px，贴在阅读栏下沿。用 scaleX 而非 width —— width 会触发
          layout，滚动时每帧重排。 */}
      <div className="reader-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      <div className="reader-scroll" ref={scrollRef}>
        <article className="reader">
          {/* 标题可点：新标签打开原文。用户在阅读区看到标题想"这篇我要发给别人"
              时，第一个动作是点标题。 */}
          <h1 className="reader-title">
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              title="在新标签打开原文"
            >
              {detail.title}
            </a>
          </h1>
          <div className="reader-meta">
            {hasSite ? (
              <a
                className="src reader-site-link"
                href={detail.feedSiteUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                title={`去源站：${detail.feedTitle ?? ''}`}
              >
                {detail.siteName ?? detail.feedTitle}
                <IconExternal size={11} className="site-arrow" />
              </a>
            ) : (
              detail.siteName && <span className="src">{detail.siteName}</span>
            )}
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
              // 正文来自我们自己抓取并清洗的 HTML（sanitize.ts 白名单 + 链接新标签）
              dangerouslySetInnerHTML={{ __html: detail.contentHtml }}
            />
          ) : (
            <div className="alert info">
              这篇还没有正文缓存。
              <a href={detail.url} target="_blank" rel="noreferrer">去原文阅读 ↗</a>
            </div>
          )}

          {/* 文末出口：读完之后最常见的两个动作 */}
          <div className="reader-foot">
            <a className="btn" href={detail.url} target="_blank" rel="noopener noreferrer">
              <IconExternal size={14} /> 打开原文
            </a>
            {hasSite && (
              <a className="btn" href={detail.feedSiteUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                <IconRss size={14} /> 访问源站
              </a>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}

/** 阅读偏好面板（§15.11）。三个值都是"本设备生效"，不落服务端。 */
function PrefsPanel(props: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const { prefs } = props;
  return (
    <div className="prefs-panel">
      <div className="prefs-row">
        <span className="prefs-label">字号</span>
        <div className="seg">
          {FONT_SIZES.map((s) => (
            <button
              key={s}
              className={`seg-btn ${prefs.fontSize === s ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, fontSize: s })}
              title={`${s}px`}
            >
              {s === 15 ? '小' : s === 16.5 ? '中' : s === 18 ? '大' : '特大'}
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">宽度</span>
        <div className="seg">
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`seg-btn ${prefs.width === w ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, width: w })}
              title={`${w} 字符`}
            >
              {w}ch
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">底色</span>
        <div className="seg">
          {THEMES.map((t) => (
            <button
              key={t.key}
              className={`seg-btn ${prefs.theme === t.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, theme: t.key })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <button className="btn block prefs-reset" onClick={() => props.onChange({ ...DEFAULT_PREFS })}>
        恢复默认
      </button>
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
