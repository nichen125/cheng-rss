import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiFailure, type EntryDetail, type EntrySummary, type FeedItem, type FolderItem,
  type HistoryGroup, type User,
} from './api.ts';
import {
  IconArrowLeft, IconBookmark, IconCheck, IconCheckCheck, IconChevronRight, IconCircle,
  IconClock, IconClose, IconExternal, IconFolder, IconInbox, IconMenu, IconRefresh, IconRss,
  IconSearch, IconSettings, IconSparkle, IconStar,
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

/**
 * 打开应用时的视图（§15.19，v1.16）。
 *
 * 从 'inbox' 改成 'unread'：用户打开应用最常见的目的是看新内容，
 * 而不是"再读一遍读过的"。默认值等于最常见的那次操作 —— 否则每次
 * 都要先手动筛掉已读。
 *
 * 抽成常量而不是在 useState 里写字面量：这个值在 `pickFolder` /
 * `pickFeed` 里也要用（切分组时不能把「未读」悄悄改成「全部」），
 * 写两处迟早会不一致。
 */
const DEFAULT_VIEW: View = 'unread';

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
  // 默认只看未读（§15.19，v1.16）。改之前是 'inbox' —— 打开就把读过的
  // 一起塞进来，用户得先手动筛掉。默认值应该等于最常见的那次操作。
  //
  // 刻意**不持久化**：把"上次点了全部"记住，下次打开又是混着的列表，
  // 与这条需求相反。刷新回未读才是对的。
  const [view, setView] = useState<View>(DEFAULT_VIEW);
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
   * 就地改未读角标（§15.14 修订，v1.17）。
   *
   * 起因：读完一篇之后侧栏那个红点不动，用户得去点刷新才看到数字掉下来。
   * 之前只有 `refreshStats` 会因为列表变化重取一次 —— 它只更新**全局**
   * 未读数（`/stats`），侧栏分组树上的两个数字分别来自 `folders` 与
   * `feeds` 两份状态，它们只在 `reloadTick` 变化时重取（关配置弹窗/点刷新）。
   * 所以读完一篇：侧栏「未读」的角标掉了，分组行和源行的数字却纹丝不动 ——
   * 同一个界面里三个数字说三件事。
   *
   * 为什么在本地减而不是再发一次请求：`markRead` 已经落库了，这次只是把
   * 已知的变化同步到另外两份本地状态上。再发一次 `/feeds` + `/folders`
   * 是两次往返换一个"服务器可能会告诉我"的数字，而结果是确定的。
   *
   * `Math.max(0, …)` 不是防御性废话：重复打开同一篇（`read_count` 会再 +1
   * 但 `is_read` 早已是 1）、或者在「全部」视图里读一篇已读的，都会走到
   * 这里而不该产生负角标。调用方负责只在**真正的未读→已读**时调它。
   */
  const adjustUnread = useCallback((feedId: string | null, delta: number) => {
    setStats((s) => (s ? { ...s, unread: Math.max(0, s.unread + delta) } : s));
    if (!feedId) return; // 网页捕获的条目不属于任何源，只影响全局未读数
    // folderId 在 updater **外面**取：updater 必须是纯函数，
    // StrictMode 下会被调两次，在里面赋值会写出看不见的副作用。
    const folderId = feeds.find((f) => f.id === feedId)?.folderId ?? null;
    setFeeds((prev) => prev.map((f) => (
      f.id === feedId ? { ...f, unread: Math.max(0, f.unread + delta) } : f
    )));
    // 分组的未读数是组内各源之和，所以跟着同一篇一起动
    if (folderId) {
      setFolders((prev) => prev.map((f) => (
        f.id === folderId ? { ...f, unread: Math.max(0, f.unread + delta) } : f
      )));
    }
  }, [feeds]);

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
   * 从分组树里选中一个范围后，决定用哪个读/全部状态（§15.20，v1.17）。
   *
   * 规则：**如果这个范围一条未读都没有，就直接显示它的「全部」。**
   * 场景是"点进一个已经读完的源"——进去看到「未读已经清零」再点「看全部」，
   * 是两次点击换一次信息。用户点的是一个源，他要看的就是这个源的文章；
   * 而这个源里只剩读过的，那"文章"就等于"全部"。
   *
   * 三处刻意的取舍：
   *   1. **只在点选时判断，不在列表空了之后判断。** 读完最后一条的那一刻
   *      仍会显示空态（带「看全部」按钮）—— 因为"读完这一篇"和"我要看
   *      读过的"是两件事，自动跳过去会让「未读」这个视图在读完最后一篇时
   *      静默消失，用户会以为未读还有内容。
   *   2. **判据是未读数 0，不是列表为空。** 列表空可能是搜索词没命中，
   *      那时切「全部」也不会变出内容，只是把用户的搜索意图改掉。
   *   3. **已经手动选了「全部」就不动。** 用户点「全部」是一次明确表态，
   *      再点别的地方不该把它改回去。
   */
  const viewForScope = useCallback((folderId: string | null, feedId: string | null): View => {
    // 从收藏/历史进来：先回到列表型视图，再由下面的未读判断决定具体是哪个
    const base: View = view === 'inbox' || view === 'unread' ? view : DEFAULT_VIEW;
    if (base === 'inbox') return 'inbox'; // 已经是全部，没有可切的
    const unread = feedId
      ? feeds.find((f) => f.id === feedId)?.unread
      : folders.find((f) => f.id === folderId)?.unread;
    // 查不到（源/组刚被删，或列表还没取回来）→ 不动态度。
    // 这里**不能**用 `?? 0` 兜底：那等于"未知就当没未读"，会把一个还有
    // 200 条未读的源判成"读完了"，直接跳到全部 —— 错得毫无痕迹。
    if (unread === undefined) return base;
    return unread === 0 ? 'inbox' : 'unread';
  }, [view, feeds, folders]);

  /**
   * 点侧栏的一个分组（§15.13）。
   *
   * 三件事必须一起发生，少一件用户都会困惑：
   *   1. 选中整组（scope = {folderId}）—— 取消可能存在的源筛选
   *   2. 展开这一组 —— 否则点了分组却看不到组内的源
   *   3. 离开「收藏 / 历史」—— 否则点分组什么也不会发生
   *
   * 第 3 条（§15.19，v1.16）：原来是无条件 `setView('inbox')`，在默认值
   * 还是 inbox 的年代看不出问题。现在默认是未读，无条件设 inbox 会把
   * "只看未读"悄悄改成"全部" —— 用户切个分组，读过的条目突然全冒出来。
   * 所以只在当前视图不是列表型（starred / history）时才改，且改到**默认值**
   * 而不是硬编码 inbox。
   *
   * v1.17 再补一层（§15.20）：这个组已经 0 未读时，直接进「全部」。
   */
  const pickFolder = useCallback((folderId: string) => {
    setView(viewForScope(folderId, null));
    setScope({ folderId });
    setExpanded((prev) => {
      const next = new Set(prev);
      next.clear();
      next.add(folderId);
      return next;
    });
  }, [viewForScope]);

  /** 点组内的一个源：再点同一个 = 取消源筛选，回整组（§15.13） */
  const pickFeed = useCallback((folderId: string, feedId: string) => {
    setView(viewForScope(folderId, feedId));
    setScope((s) => (s.feedId === feedId ? { folderId } : { folderId, feedId }));
  }, [viewForScope]);


  /**
   * 打开一条（§15.11）。首次打开同时标记已读。
   *
   * v1.17：标记已读之后**就地**把侧栏未读角标减 1（§15.14 修订）。
   * 条件是 `!d.isRead` —— 打开一条已经读过的不会再减（后端 `is_read`
   * 是幂等的，`read_count` 才 +1）。
   *
   * 不能靠 `refreshStats` 代替：它只更新全局 `/stats`，分组与源的
   * 两个数字在 `folders` / `feeds` 里，重取要等 `reloadTick`。
   */
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
        adjustUnread(d.feedId ?? null, -1);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '打开失败');
    } finally {
      setDetailLoading(false);
    }
  }, [adjustUnread, refreshStats]);

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
    const feedId = cur.feedId ?? null;
    try {
      if (cur.isRead) {
        await api.markUnread(id);
        setDetail((d) => (d && d.id === id ? { ...d, isRead: false } : d));
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: false } : x)));
        // v1.17：标回未读 → 角标 +1（与 open 的 -1 对称）
        adjustUnread(feedId, +1);
        refreshStats();
      } else {
        await api.markRead(id);
        setDetail((d) => (d && d.id === id ? { ...d, isRead: true } : d));
        setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isRead: true } : x)));
        adjustUnread(feedId, -1);
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
  }, [detail, items, view, open, refreshStats, adjustUnread]);

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

  /** 当前范围的未读数。feed 优先于 folder（选了源时用户看的是那个源） */
  const scopeUnread = scope.feedId
    ? (feeds.find((f) => f.id === scope.feedId)?.unread ?? 0)
    : scope.folderId
      ? (folders.find((f) => f.id === scope.folderId)?.unread ?? 0)
      : 0;

  /**
   * 把当前范围（分组 / 单个源）的未读一次清空（§15.21，v1.17）。
   *
   * 三件事按顺序做，顺序不能反：
   *   1. 先问 —— 这个动作没有撤销入口（批量标未读得一条条来），
   *      所以必须确认，且确认文案里要写明**多少条**会消失。
   *   2. 再写库，拿后端返回的真实条数（不是本地那个可能已经过时的角标）。
   *   3. 最后同步本地状态并重取列表 —— 重取而不是本地过滤：后端可能
   *      还有本页没加载的未读，本地过滤会留下一个和标题数字矛盾的列表。
   *
   * 不清阅读历史（后端不写 first_read_at/last_read_at），所以「历史」页
   * 不会凭空多出这些条目 —— 见 routes/entries.ts 里那段注释。
   */
  const markScopeRead = useCallback(async () => {
    if (!scope.feedId && !scope.folderId) return;
    const n = scopeUnread;
    if (n === 0) return; // 已经是空的，不必弹一个"清 0 条"的确认框
    const yes = window.confirm(
      `把「${listTitle}」里的 ${n} 条未读全部标为已读？\n\n`
      + `它们不会进入「历史」（那里记录的是你真的打开过的）。\n`
      + `这个操作没有撤销按钮。`,
    );
    if (!yes) return;
    try {
      const r = await api.markAllRead({ feedId: scope.feedId, folderId: scope.folderId });
      if (scope.feedId) {
        // 单个源：全局、分组、源三处都能精确减
        adjustUnread(scope.feedId, -Math.min(r.count, n));
      } else {
        // 整个分组：全局减 r.count，分组角标归零；组内各源拿不到逐条数字，
        // 交给 reloadTick 触发的 /feeds 重取去校正（否则展开组时子行还是旧数字）
        setStats((s) => (s ? { ...s, unread: Math.max(0, s.unread - r.count) } : s));
        setFolders((prev) => prev.map((f) => (
          f.id === scope.folderId ? { ...f, unread: 0 } : f
        )));
        setReloadTick((t) => t + 1);
      }
      await load(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '标记失败');
    }
  }, [scope.feedId, scope.folderId, scopeUnread, listTitle, adjustUnread, load]);

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

        {/* 「订阅源」这一块原先挂在侧栏（一个「订阅」入口 + 一个「分组」标题）。
            v1.13 之后两样都不需要了：
              · 订阅管理本来就在配置弹窗里（§15.15），留着入口等于有两个门；
              · 分组树自带「分组」标题，再挂一个同名标题是重复。
            唯一的配置入口是右下角那个齿轮 —— 一个入口比两个清楚。 */}

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
          {/* 标题行（§15.22，v1.17 重构）。
              原来这一行是「h1 + 计数 + × + 分段控件 + 刷新」五个东西挤在
              一个 baseline 对齐的 flex 里，各自用 align-self 找位置 ——
              结果三样东西三种光学高度：文字坐在基线上、控件坐在中线上，
              中间栏看起来一行是歪的。而且分段控件在收藏/历史视图下隐藏，
              `margin-left: auto` 一消失，刷新按钮就贴着计数往左跳。

              现在拆成两段，语义上也就是两件事：
                · 左边「我在看什么」：标题 + 条数
                · 右边「能对它做什么」：分段 / 全部已读 / 清除范围 / 刷新
              右段整块 `margin-left: auto`，里面匀速 gap，任何一个按钮
              显隐都不会让其余的跳位。全部 align-items: center + 统一
              22px 行高，中线就是行高的一半，不再靠 align-self 逐个纠正。 */}
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

            <div className="pane-actions">
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

              {/* 清除这个范围的未读（§15.21，v1.17）。
                  按钮只在"有范围 + 确实有未读"时出现：范围是全库时不显示
                  （需求方只要求分组和单源两档），未读为 0 时显示则是一个
                  按下去什么都不会发生的按钮。 */}
              {(scope.folderId || scope.feedId) && scopeUnread > 0 && (
                <button
                  className="icon-btn tiny mark-read-btn"
                  onClick={() => void markScopeRead()}
                  title={`把「${listTitle}」的 ${scopeUnread} 条未读全部标为已读`}
                  aria-label="清除未读"
                >
                  <IconCheckCheck size={14} />
                </button>
              )}

              {/* 清除筛选：从一整块实心按钮改成标题行里的小 ×（§15.12）。
                  原来的 129×40 实心块夹在搜索框和列表之间，视觉重量和
                  "取消一个筛选"这件小事完全不匹配 —— 它只是按钮基样式的副作用。 */}
              {(scope.folderId || scope.feedId) && (
                <button
                  className="icon-btn tiny scope-clear"
                  onClick={() => { setScope({}); setExpanded(new Set()); }}
                  title="清除分组与源筛选"
                  aria-label="清除筛选"
                >
                  <IconClose size={13} />
                </button>
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

          {/* 空态要等两份数据都到位才渲染（v1.17）。
              「未读清零」还是「还没有订阅」取决于库里有没有源，而源列表
              与条目列表是并行发的两个请求 —— 少了 `feedsLoaded`，源列表
              慢一拍的那一瞬间会先画一帧「收件箱是空的 / 还没有订阅任何源」，
              一个已经订阅了 12 个源的用户会看到它闪一下。 */}
          {!loading && feedsLoaded && items.length === 0 && view !== 'history' && (
            <EmptyState
              hasQuery={Boolean(debounced)}
              view={view}
              scopeLabel={scope.folderId ? listTitle : null}
              hasFeeds={feeds.length > 0}
              onGoFeeds={() => { setSettingsSection('feeds'); setSettingsOpen(true); }}
              onClearScope={() => { setScope({}); setExpanded(new Set()); }}
              onShowAll={() => setView('inbox')}
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
                                // 必须 stopPropagation：行本身也有 onClick，
                                // 不拦就会 **调用两次 open()**。第一次打开了、
                                // 标了已读、角标减一；第二次拿到的详情说
                                // "已经读过"（不重复减），但两次都在飞，
                                // 期间任何一次 setState 都会叠加 ——
                                // 实测未读角标从 2 直接掉到 0（§15.22）。
                                e.stopPropagation();
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
                        // 必须 stopPropagation：行本身也有 onClick，不拦就会
                        // **调用两次 open()**（详见移动端那份注释）。
                        e.stopPropagation();
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
        {/* 配置入口（§15.15 v1.13）：手机上侧栏是隐藏的，这一格是**唯一**
            能打开配置的地方，所以不能跟着桌面那个「订阅」一起删。
            改名成「配置」+ 齿轮，是为了让名字和行为对上 —— 它打开的是
            整个配置弹窗（订阅/分组/账户），不是"订阅页"。 */}
        <button
          className={`tab ${settingsOpen ? 'active' : ''}`}
          onClick={() => { setSettingsOpen(true); setOpenId(null); }}
          title="配置（订阅 / 分组 / 账户）"
          aria-label="打开配置"
        >
          <span className="tab-icon"><IconSettings size={18} /></span>
          <span className="tab-label">配置</span>
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
  /** 库里到底有没有订阅源。没有源时的空态是"去添加"，不是"看全部" */
  hasFeeds?: boolean;
  onGoFeeds?: () => void;
  /** 清掉分组与源筛选（回到全库） */
  onClearScope?: () => void;
  /**
   * 看**当前范围**的全部（保留分组/源，只把「未读」切成「全部」）。
   *
   * 与 onClearScope 是两个不同的动作，v1.17 之前只有一个按钮包办了
   * 前者：在某个源里读完了最后一条，空态上写着「看全部条目」，点下去
   * 却跳到了全库 —— 用户想看的是"这个源里都读过什么"。见 §15.20。
   */
  onShowAll?: () => void;
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

  // 「未读」清零 ≠ 收件箱里什么都没有（§15.20，v1.17）。
  //
  // 改之前这里落到最后一个 return，文案是「收件箱是空的 / 还没有订阅任何源」——
  // 一个已经把 300 篇都读完的用户会被告知"你还没有订阅"，而他明明有 12 个源。
  // 空态必须区分"这个范围没有未读"和"这个范围没有条目"，因为下一步动作不同：
  // 前者是"去看读过的"，后者才是"去添加订阅"。
  //
  // 库里真的一条源都没有时不能走这里：新装用户要的是「去添加订阅」。
  if (props.view === 'unread' && props.hasFeeds !== false) {
    return (
      <div className="empty">
        <div className="ph-art"><IconCircle size={26} /></div>
        <h2>{props.scopeLabel ? `「${props.scopeLabel}」里没有未读` : '未读已经清零'}</h2>
        <p>
          {props.scopeLabel
            ? '这个范围里的文章都读过了，或者刚添加还没抓到。'
            : '所有订阅里的文章都读过了。新的内容会自动出现在这里。'}
        </p>
        <div className="empty-actions">
          {props.onShowAll && (
            <button
              className="btn"
              onClick={props.onShowAll}
              title="只切换读/全部，不改当前的分组与源筛选"
            >
              看全部
            </button>
          )}
          {props.onGoFeeds && (
            <button className="btn" onClick={props.onGoFeeds}>管理订阅</button>
          )}
        </div>
      </div>
    );
  }

  // 分组内为空 ≠ 没有订阅。这两种情况的引导动作完全不同：
  // 前者应该"看全部"，后者应该"去添加订阅"。
  if (props.scopeLabel) {
    return (
      <div className="empty">
        <div className="ph-art"><IconFolder size={26} /></div>
        <h2>「{props.scopeLabel}」里还没有条目</h2>
        <p>
          这个范围下的源暂时没有新内容，或者刚添加还没抓到。
        </p>
        <div className="empty-actions">
          {props.onClearScope && (
            <button className="btn" onClick={props.onClearScope}>看全库条目</button>
          )}
          {props.onGoFeeds && (
            <button className="btn" onClick={props.onGoFeeds}>管理订阅</button>
          )}
        </div>
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

/** 目录项：正文里一个 h2/h3 的锚点（§15.18） */
interface TocItem {
  id: string;
  text: string;
  /** 2 = h2，3 = h3，用来做缩进 */
  level: 2 | 3;
}

/**
 * 目录右侧需要的空间（px）：目录 190 + 与正文的间距 20。
 *
 * 目录**只放在正文右侧的空白里**，不参与排版。所以判断"放不放得下"要用
 * 实际的右侧空白 `(面板宽 − 纸宽) / 2`，而不是写一个视口断点 —— 后者会
 * 在用户把正文宽度调到 96ch 之后失效（纸变宽、空白变窄，断点却还成立，
 * 于是目录压到正文上）。
 */
const TOC_NEED = 210;

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

  // ── 侧边目录（§15.18）─────────────────────────────────────
  /** 正文里的小标题。从 DOM 读，不在服务端另解析一份 */
  const [toc, setToc] = useState<TocItem[]>([]);
  /** 面板右侧空白够不够放目录。不够就整个不渲染 */
  const [tocFits, setTocFits] = useState(false);
  /** 当前所在的小节 id —— 滚动时更新，目录里对应项高亮 */
  const [tocActive, setTocActive] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 「舞台」：包住纸与目录的那层，用来量右侧还剩多少空白 */
  const stageRef = useRef<HTMLDivElement>(null);

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

  // ── 目录：从 DOM 读小标题（§15.18）────────────────────────
  //
  // 为什么不叫服务端在详情接口里多返回一份 toc：
  //   ① 要为 10 万条历史正文回填，成本远大于收益；
  //   ② 清洗后的 HTML 才是唯一真相（§11.2 的同一原则），
  //      从别处再解析一遍会漂移 —— 清洗规则一改，两份就不同步。
  //
  // 依赖里必须有 loading（而不只是 contentHtml）：
  // 详情接口返回时 `detail` 与 `loading=false` 不保证在同一次提交里生效。
  // 如果 effect 在 `loading` 还是 true 的那次提交后跑，组件返回的是
  // loading 占位，`.article-body` 根本没挂上，bodyRef.current 是 null ——
  // 目录就永远静默为空。把 loading 放进依赖，等它转 false 时再跑一次。
  //
  // 同理，依赖里放 contentHtml：同一篇文章的 HTML 变了（重新提取）也要重算。
  useEffect(() => {
    if (loading) return;
    const root = bodyRef.current;
    if (!root) { setToc([]); setTocActive(null); return; }

    const heads = [...root.querySelectorAll('h2, h3')] as HTMLElement[];
    // ≥2 个才出目录：1 个标题没有导航价值，0 个是空栏。
    // 实测 20 篇真实文章里绝大多数（短讯/日报/通稿）是 0 个。
    if (heads.length < 2) { setToc([]); setTocActive(null); return; }

    const items: TocItem[] = heads.map((h, i) => {
      // 没 id 的补一个。用下标而不是文本做 id：标题可能重复、可能含
      // 空格与标点，拼成 id 后 querySelector 还得再转义一次。
      if (!h.id) h.id = `sec-${i}`;
      return {
        id: h.id,
        text: (h.textContent ?? '').trim(),
        level: h.tagName === 'H2' ? 2 : 3,
      };
    });
    setToc(items);
    setTocActive(items[0]?.id ?? null);
  }, [loading, detail?.id, detail?.contentHtml]);

  // ── 目录：放得下就显示（§15.18）──────────────────────────
  //
  // 判据是**实际可用宽度**，不是一个写死的视口断点。写断点的话，
  // 用户把正文宽度调到 96ch 之后纸变宽，断点却还成立，目录就压到正文上。
  //
  // 用 stage.clientWidth（内容宽，不含 padding）而不是 scrollWidth：
  // 后者会把已经溢出的内容算进去，一旦显示目录就永远"放得下"。
  // 不需要每次滚动都算 —— 只有尺寸变化才可能改变结论，交给 ResizeObserver。
  useEffect(() => {
    if (loading) return;
    const stage = stageRef.current;
    if (!stage) return;
    const paperW = () => {
      const paper = stage.querySelector('.reader') as HTMLElement | null;
      return paper ? paper.getBoundingClientRect().width : 0;
    };
    const check = () => {
      const sw = stage.clientWidth;
      const pw = paperW();
      // 纸与目录这一组由 justify-content 居中：显示目录后纸会向左偏，
      // 但**正文宽度不变**。判据是"扣掉纸之后还剩多少"，不是"两侧各一半"。
      setTocFits(pw > 0 && sw - pw >= TOC_NEED);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(stage);
    const paper = stage.querySelector('.reader');
    if (paper) ro.observe(paper);
    return () => ro.disconnect();
  }, [loading, detail?.id, prefs.width, prefs.fontSize]);

  // ── 目录：滚动时高亮当前小节（§15.18）────────────────────
  //
  // 判据是"最后一个「顶部已经越过基准线」的标题"，不是"离视口中心最近"：
  // 后者在一屏只有 2 段时会在两个标题之间来回跳，读起来像故障。
  useEffect(() => {
    const el = scrollRef.current;
    const root = bodyRef.current;
    if (!el || !root || toc.length === 0) return;

    const onScroll = () => {
      const heads = [...root.querySelectorAll('h2, h3')] as HTMLElement[];
      if (heads.length === 0) return;
      // 基准线 = 滚动容器顶部往下 90px。取 90 而不是 0：标题正好压在
      // 上边缘时还没"开始读"，再往下 90px 才算是当前小节。
      const line = el.getBoundingClientRect().top + 90;
      let current = heads[0]!.id;
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= line) current = h.id;
        else break;
      }
      setTocActive(current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [toc]);

  if (loading || !detail) {
    return (
      <div className="reader-loading">
        <span className="spinner" />
      </div>
    );
  }

  const a = detail.analysis;
  const hasSite = Boolean(detail.feedSiteUrl);
  const showToc = tocFits && toc.length >= 2;

  /** 点目录项：滚到标题。用 scrollIntoView 不用算 y —— 算出来的 y 会被
   *  图片懒加载改变（图片撑开时高度在变），滚不到位。 */
  const jumpTo = (id: string) => {
    const root = bodyRef.current;
    const target = root?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocActive(id);
  };

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
        {/* 「舞台」包住纸与目录（§15.18）：纸居中，目录挂在纸右侧的空白里。
            目录用 position: fixed 会跟随滚动而错位，所以在 stage 里用
            绝对定位 + sticky 的容器，目录自己吸顶。 */}
        <div className="reader-stage" ref={stageRef}>
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
              ref={bodyRef}
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

          {/* 侧边目录（§15.18）：只吃纸右侧的空白，不参与排版。
              面板不够宽或文章没有小标题时整个不渲染 —— 不是渲染成空的。 */}
          {showToc && (
            <nav className="reader-toc" aria-label="文章目录">
              <div className="toc-inner">
                <div className="toc-head">目录</div>
                <ul className="toc-list">
                  {toc.map((it) => (
                    <li key={it.id} className={`toc-item lv${it.level}`}>
                      <button
                        className={`toc-link ${tocActive === it.id ? 'on' : ''}`}
                        // aria-current 给读屏用，同时是验收脚本的判据 ——
                        // 只看 class 的话，样式改了测试就跟着失效
                        aria-current={tocActive === it.id ? 'true' : undefined}
                        onClick={() => jumpTo(it.id)}
                        title={it.text}
                      >
                        {it.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          )}
        </div>
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
