import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiFailure, type EntryDetail, type EntrySummary, type FeedItem, type FolderItem,
  type HistoryGroup, type User,
} from './api.ts';
import {
  IconBookmark, IconCheckCheck, IconChevronRight, IconCircle, IconClock, IconClose,
  IconFolder, IconInbox, IconRefresh, IconRss, IconSearch, IconSettings, IconSparkle,
  IconStar,
} from './icons.tsx';
import { DigestPage } from './digest/DigestPage.tsx';
import { SettingsModal, type SettingsSection } from './settings/SettingsModal.tsx';
import { ToastHost, type ToastSpec } from './Toasts.tsx';
import { useConfirm } from './components/ConfirmDialog.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { EntryRow } from './components/EntryRow.tsx';
import { EmptyState } from './components/EmptyState.tsx';
import { HistoryMeta } from './components/HistoryMeta.tsx';
import { Reader } from './components/Reader.tsx';
import { useArrange } from './useArrange.ts';
import { createLatest, isAbortError } from './lib/latest.ts';
import { hostOf, markDays } from './lib/format.ts';
import type { View } from './lib/view.ts';
import {
  feedsOfFolder, looseFeedsOf, rowKey, foldersAfterDrop, orderAfterDrop, moveItem,
  type ArrangeRow, type DropTarget,
} from './arrange.ts';
import { applyPrefs, loadPrefs, savePrefs, type ReaderPrefs } from './reader-prefs.ts';

// 主界面 = 三栏（PLAN §15.1/§15.2/§15.3）
//
//   侧栏（导航 + 筛选）│ 列表（扫描）│ 阅读区（内容优先）
//
// 三栏而非两栏的理由：点开一条时列表不能消失——阅读时反复回看列表
// 挑下一篇是 RSS 阅读器最常见的动作，跳页式导航会把它变成两次点击。
//
// M0 的数据能力只有「条目读取 + 已读/收藏」，所以导航里除收件箱外的
// 入口都标了"待接入"，不让用户点了没反应。

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

/**
 * 分割线下面先补多少条已读（§15.24，v1.18）。
 *
 * 与主列表的 30 不同，这里用 40：分割线之后的内容是"上下去看"，用户
 * 通常在翻两下之内就决定要不要继续；40 条足够覆盖一个中等源的全部存量
 * （独库实测：21 个源里 17 个源的存量都不到 40 条），一次就把界面上
 * "看完了"的错觉消掉，不用先看到一条分割线再点加载更多。
 */
const READ_TAIL_LIMIT = 40;

const NAV: NavItem[] = [
  INBOX_NAV,
  { key: 'unread', label: '未读', icon: <IconCircle />, count: 'unread' },
  { key: 'starred', label: '已收藏', icon: <IconStar />, count: 'starred' },
  { key: 'history', label: '历史', icon: <IconClock /> },
  // 简报（§15.4 / 3.5）。它是一等入口而不是"即将支持"：
  // 每天生成的简报如果只能在设置页里看到，等于没做。
  { key: 'digest', label: '简报', icon: <IconSparkle /> },
];

/**
 * 未接入的导航项。
 *
 * 现在是**空的** —— M0~M4 的需求项已全部落地。保留这个数组而不是删掉
 * 整块渲染逻辑：M5（检索）与 M6（备份）会再来加，而"待接入"这个标签
 * 本身是有价值的（点了没反应 vs 明确标注未实现，后者更诚实）。
 */
const SOON: { label: string; icon: React.ReactNode }[] = [];

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
        <div className="auth-brand">
          <span className="brand-mark">澄</span>
        </div>
        <p className="hint">私人知识库 · 订阅、沉淀、回看</p>
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
        <div className="auth-brand"><span className="brand-mark">澄</span></div>
        <p className="hint">第一次使用，先建一个管理员。数据全部保存在本地。</p>
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
  const confirm = useConfirm();
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
  /**
   * 「未读读光了」之后补在分割线下面的已读条目（§15.24，v1.18）。
   *
   * null = 不该有分割线（还有未读 / 没有范围 / 有搜索词 / 全库）。
   * 数组 = 该范围剩下的已读条目，按 published_at 倒序，接在未读部分后面。
   *
   * 为什么用 null 而不是空数组：空数组会让 "正在取" 和 "取到了 0 条"
   * 都渲染成没有分割线，但前者需要的是等一下，后者需要的是显示
   * 「更早的 N 条已读」都不存在的那种真空——两者在界面上不该一样。
   */
  const [readTail, setReadTail] = useState<EntrySummary[] | null>(null);
  const [readTailTotal, setReadTailTotal] = useState(0);
  const [readTailCursor, setReadTailCursor] = useState<string | null>(null);
  const [tailLoading, setTailLoading] = useState(false);
  /**
   * 尾段正在取。与 `tailLoading` 分开：那个是"翻下一页"，
   * 这个是"该不该画分割线还不确定"。空态要等它 —— 否则读光的源会先闪
   * 一帧「未读已经清零」，然后才被尾段顶掉（§15.24）。
   */
  const [tailFetching, setTailFetching] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  /**
   * `cursor` 的 ref 镜像（P0 竞态修复，docs/plans/refactor-p0.md §1）。
   *
   * 为什么需要它：`load` 既要服务「重置」也要服务「加载更多」，而后者
   * 必须读到**发起那一刻**的游标。直接闭包捕获 `cursor` 会让 `load`
   * 依赖 `cursor`，于是列表一翻页，那个按 `[view, debounced, scope]`
   * 重取首页的 effect 也会跟着重跑 —— 结果就是每翻一页都把列表重置回第一页。
   * 之前那行 eslint-disable-next-line 注释就是在掩盖这个矛盾：
   * 依赖写全会让列表翻不动，写不全就是旧闭包。ref 把"最新值"和
   * "谁触发重取"这两件事拆开了，两边都不必让步。
   */
  const cursorRef = useRef<string | null>(null);
  /** 改游标只走这一个入口，state 与 ref 不会分叉 */
  const commitCursor = useCallback((next: string | null) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);
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
  /** 排列模式（§15.28）：侧栏长按进入，行可拖、可点 ↑↓ */
  const [arranging, setArranging] = useState(false);
  /** 底部提示条（§15.28）：只在跨组移动时出现，带撤销 */
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((t: Omit<ToastSpec, 'id'>) => {
    toastSeq.current += 1;
    setToast({ ...t, id: toastSeq.current });
  }, []);

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

  /**
   * 请求序号守卫（P0 竞态修复）。
   *
   * 「序号」和「AbortController」是两道独立的保险，不是重复：
   *   - abort 只能拦住**还在飞**的请求。响应已经到了、`await` 已经返回，
   *     但这次 `setItems` 还没执行完的那一刻，abort 是拦不住的。
   *   - 序号能拦住任何晚到的响应，但它不会让旧请求早点结束。
   * 一起用：切视图时立刻 abort（省流量、省服务端），任何漏网的晚到响应
   * 再被 `isLatest` 丢掉（省状态一致性）。
   */
  const latestRef = useRef(createLatest());
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (reset: boolean) => {
    // 简报视图用的是 /digests，与条目列表无关。不加这一句的话切到简报
    // 会白跑一次 listEntries（服务端把未知 view 当 inbox 处理，返回一大堆
    // 用不上的数据），而且它会覆盖 items 让"返回上一视图"时列表闪一下。
    if (view === 'digest') { setLoading(false); return; }
    // 新请求 = 上一次在途请求立刻过期。先 abort 再领号，顺序无关紧要，
    // 但两句之间不要有 await：否则中间那一刻两条请求都"合法"。
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const seq = latestRef.current.begin();
    setLoading(true);
    setErr('');
    try {
      const r = await api.listEntries({
        view,
        q: debounced || undefined,
        cursor: reset ? null : cursorRef.current,
        limit: 30,
        feedId: scope.feedId ?? null,
        folderId: scope.folderId ?? null,
        signal: ctrl.signal,
      });
      // 双保险的第二道：abort 没赶上（响应已落地）时，只有最新那发能写 state。
      // 少了这一句的后果不是"多一次渲染"，而是旧视图的 items 盖掉新视图的、
      // 且 cursor 被旧响应的 nextCursor 带走，后续「加载更多」从错误位置续读。
      if (!latestRef.current.isLatest(seq)) return;
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      // total 是后端算的命中总数，不是本页条数 —— 分页后
      // items.length 会一直涨到 30/60/90，用它当"多少条"会骗人。
      setTotal(typeof r.total === 'number' ? r.total : null);
      commitCursor(r.nextCursor);
    } catch (e) {
      // 用户切走视图/改了搜索词导致的 abort 不是错误：不写 state、
      // 不 setLoading、不 toast。写进去的话，切到简报页会看到一条
      // "This operation was aborted"。
      if (isAbortError(e) || !latestRef.current.isLatest(seq)) return;
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      // loading 同理：过期请求收尾时不能再把它置回 false，
      // 否则新请求正在加载，按钮却已经可点。
      if (latestRef.current.isLatest(seq)) setLoading(false);
    }
  }, [view, debounced, scope, commitCursor]);

  // 依赖写全：`load` 已经用 ref 读游标，所以这里不需要 `cursor`，
  // 也就不会出现"翻一页就把列表重置回第一页"。
  useEffect(() => {
    void load(true);
    // 卸载/换条件时把在途请求放掉。不 abort 的话它会跑完、然后被
    // 序号守卫丢掉 —— 结果正确，只是白烧一次请求。
    return () => { abortRef.current?.abort(); };
  }, [load]);

  /**
   * 分割线下补出来的已读条目（§15.24，v1.18）。
   *
   * 需求方原话：「我切换未读之后，如果某一个里面没有未读…是指在列表栏中
   * 分割线，补充上全部的列表，可以参考 huntly 实现」。
   *
   * 五个准入条件，每一条都有具体的反例：
   *   1. `view === 'unread'` —— 「全部」视图本来就没有东西要补。
   *   2. `!debounced` —— 用户搜"xx"是在找含这个词的未读，补已读等于
   *      把搜索意图改掉（搜到 0 条时应说 0 条，而不是铺一堆不相关的）。
   *   3. `scoped` —— 有分组/源才有"这个范围里的上下文"可言；全库补出来
   *      等于把整个阅读历史铺进列表（几百上千条）。
   *   4. `total === 0` —— **只在未读为 0 时补**。还有未读时补上已读，
   *      会让「未读」这个分段控件和列表内容对不上。
   *   5. `cursor === null && !loading` —— 未读本身还没翻完页时不能插分割线，
   *      否则分割线后面还有未读，位置是错的。
   *
   * 失败时静默置 null：分割线是锦上添花，取不到就当没有，不该让整个列表
   * 变成错误状态。
   */
  useEffect(() => {
    const scoped = Boolean(scope.folderId || scope.feedId);
    const eligible = view === 'unread' && !debounced && scoped
      && total === 0 && cursor === null && !loading;
    if (!eligible) {
      setReadTail(null);
      setReadTailTotal(0);
      setReadTailCursor(null);
      setTailFetching(false);
      return;
    }
    let alive = true;
    setTailFetching(true);
    api.listEntries({
      view: 'read',
      limit: READ_TAIL_LIMIT,
      feedId: scope.feedId ?? null,
      folderId: scope.folderId ?? null,
    })
      .then((r) => {
        if (!alive) return;
        setReadTail(r.items);
        setReadTailTotal(typeof r.total === 'number' ? r.total : r.items.length);
        setReadTailCursor(r.nextCursor);
      })
      .catch(() => {
        if (!alive) return;
        setReadTail(null);
      })
      .finally(() => {
        if (alive) setTailFetching(false);
      });
    return () => { alive = false; };
  }, [view, debounced, scope, total, cursor, loading]);

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
        // 走 commitCursor 而不是 setCursor：游标的 state 与 ref 必须同时更新，
        // 少更新 ref 的话，从历史页切回列表时「加载更多」会拿着旧游标续读。
        commitCursor(r.nextCursor);
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
  //
  // §15.28 起组内顺序由 `sort` 决定（用户能拖能点箭头），所以这里不能
  // 只 push —— 要按 sort、标题兜底排好。排序规则集中在 arrange.ts 的
  // feedsOfFolder 里，配置页与侧栏共用同一份，两处给不出不同顺序。
  const feedsByFolder = useMemo(() => {
    const m = new Map<string, FeedItem[]>();
    for (const f of feeds) {
      if (!f.folderId) continue;
      const list = m.get(f.folderId);
      if (list) list.push(f); else m.set(f.folderId, [f]);
    }
    for (const id of m.keys()) m.set(id, feedsOfFolder(feeds, id));
    return m;
  }, [feeds]);

  /** 当前分组内的源（标题「组名 · 源名」与自愈判据都要用） */
  const folderFeeds = useMemo(
    () => (scope.folderId ? feedsByFolder.get(scope.folderId) ?? [] : []),
    [scope.folderId, feedsByFolder],
  );

  /**
   * 未分组的源（§15.26，v2.0；§15.28 起位置改到最前）。
   *
   * 侧栏把它们**平铺在分组区块里**，与分组行同级 —— 需求方原话是
   * 「未分组的直接在组的地方显示，没有分组就意味着在最外面直接看」。
   *
   * 顺序：先按 `sort`（用户在排列模式里拖过的），并列时按标题的 `zh-CN`
   * 拼音序。**不能让默认比较器接手并列项**：它按码点排，中文会得到
   * "零、七、三"这种完全无序的结果（实测码点序 零 96F6 > 七 4E03），
   * 而这不报错、只是看起来很乱。m1-26 ① 就是抓这个的。
   *
   * 排序规则在 arrange.ts 的 looseFeedsOf 里，配置页共用同一份。
   */
  const looseFeeds = useMemo(() => looseFeedsOf(feeds), [feeds]);

  /**
   * 当前范围里的源清单，含「未分组」这个伪范围。
   *
   * 为什么需要这一层：`feedsByFolder` 只装真的分组（folder_id 非空），
   * 而 `folderId='none'` 是**列表 API 认得的一个取值**（它表示"没有分组的源"），
   * 不是一个真实的目录 id。少了这个分支，选中未分组源时 `folderFeeds`
   * 恒为空，下面的自愈逻辑会立刻把 feedId 清掉 —— 症状是"点了未分组的源，
   * 高亮闪一下就消失，列表回到全部"。
   */
  const feedsInScope = useMemo(
    () => (scope.folderId === 'none' ? looseFeeds : folderFeeds),
    [scope.folderId, looseFeeds, folderFeeds],
  );

  // 源筛选的自愈：当前筛的源已不在**这个范围**里（被移出 / 被删），退回该范围。
  //
  // 不自愈的话会出现"侧栏里那个源还高亮着，列表却永远是空的" ——
  // 请求带的是 {folderId: 新组, feedId: 旧组的源}，交集必然为空，
  // 用户看到的是"这个组里没有文章"，而不是"你的筛选失效了"。
  //
  // 判据必须是「这个范围里有没有它」，不是「库里有没有它」：源被移出分组
  // 时它还在库里（只是 folder_id 变了），用全局 feeds 判会永远不触发。
  // 第一版 v1.13 就是这么写的，m1-11 ⑩ 当场抓到。
  //
  // v2.0：判据里用 `feedsInScope` 而不是 `folderFeeds` —— 后者只认识真分组，
  // 遇到 `folderId='none'`（未分组，§15.26）会恒为空，于是选中未分组源后
  // 自愈逻辑立刻把 feedId 清掉（"点了没反应"）。
  useEffect(() => {
    if (!scope.feedId) return;
    if (!feedsLoaded) return; // 还在加载，不能据此判定
    if (!feedsInScope.some((f) => f.id === scope.feedId)) {
      // 只丢源、保留分组 —— 顺手把 folderId 也清掉会让用户以为自己
      // 被弹出了分组（树收起、标题变回收件箱）。m1-11 的
      // 「自愈只丢源、不丢分组」那条就是专门抓这个的。
      setScope((s) => ({ folderId: s.folderId }));
    }
  }, [feedsInScope, feedsLoaded, scope.feedId, scope.folderId]);

  /**
   * 落位：把一次拖动变成一次提交（§15.28）。
   *
   * 三种结果，走同一套接口：
   *   · 拖分组行 → `reorderFolders`
   *   · 拖源到行间 → 在同组内调序（`arrangeFeeds`，只换 sort）
   *   · 拖源到分组行上 → 换组（`arrangeFeeds` 带新 folderId），弹 toast
   *
   * 失败时**不退出排列模式**：退出等于用户刚做的调整无声消失，
   * 他只会以为"又白弄了"。改成弹一条不自动消失的错误 toast。
   */
  const handleDrop = useCallback(async (row: ArrangeRow, target: DropTarget | null) => {
    if (!target) return;   // 松手在空处/自己身上 = 取消，不发请求

    try {
      if (row.kind === 'folder') {
        const ids = foldersAfterDrop(folders, row.id, target);
        if (!ids) return;
        await api.reorderFolders(ids);
        refreshShell();
        return;
      }

      // ── 源：先确定目标组，再算新顺序 ─────────────────────
      const toFolder = target.kind === 'into' ? target.folderId : row.folderId;
      // 目标组当前的显示顺序（跨组时不含被拖的那个，它还在原组里）
      const siblings = (toFolder === null ? looseFeeds : (feedsByFolder.get(toFolder) ?? []))
        .map((f) => f.id);

      let ids: string[] | null;
      if (target.kind === 'into') {
        // 放进某组：落在末尾。拖到组行上没有"插到中间"这回事 ——
        // 组行只有一个整体，没有可供落点的行间位置
        ids = [...siblings.filter((x) => x !== row.id), row.id];
      } else {
        // 行间落位。findDropTarget 只在同组时才给 line，所以这里
        // siblings 一定含 row.id
        ids = orderAfterDrop(siblings, row.id, target);
      }
      if (!ids) return;

      await api.arrangeFeeds(toFolder, ids);

      // toast 只在**跨组**时弹：同组调序是原地微调，弹一条比不弹更吵
      if (toFolder !== row.folderId) {
        const destName = toFolder === null
          ? '未分组'
          : (folders.find((f) => f.id === toFolder)?.name ?? '分组');
        const fromFolder = row.folderId;
        const fromName = fromFolder === null
          ? '未分组'
          : (folders.find((f) => f.id === fromFolder)?.name ?? '分组');
        const back = fromFolder === null ? looseFeeds : (feedsByFolder.get(fromFolder) ?? []);
        showToast({
          text: `「${row.label}」已移入「${destName}」`,
          action: {
            label: '撤销',
            onRun: async () => {
              try {
                // 撤销要把归属和位置一起还原：只改 folderId 的话，
                // 它会落在原组末尾而不是原来的位置
                await api.arrangeFeeds(fromFolder, [...back.map((f) => f.id).filter((x) => x !== row.id), row.id]);
                showToast({ text: `已撤销，回到「${fromName}」` });
              } catch {
                showToast({ text: '撤销失败，请手动移回', tone: 'error' });
              }
              refreshShell();
            },
          },
        });
      }
      refreshShell();
    } catch (e) {
      showToast({
        text: e instanceof ApiFailure ? e.message : '调整失败，顺序未改变',
        tone: 'error',
      });
    }
  }, [folders, feedsByFolder, looseFeeds, refreshShell, showToast]);

  const arrange = useArrange({
    inArrange: arranging,
    enterArrange: () => {
      setArranging(true);
      // 进入排列模式时收起全部手风琴（§15.28）：展开的组行高几十像素，
      // 落点计算会漂；拖动时子行跟着父行走还会让整块跳。
      setExpanded(new Set());
    },
    onDrop: (row, target) => { void handleDrop(row, target); },
  });

  /**
   * ↑↓ 走一格（§15.28）。这是拖拽的兜底通道 —— 键盘、触控板、
   * 或者"就想挪一位"的时候用它，不必拖。
   *
   * 与拖拽共用 `moveItem` 与同一套提交接口，所以两条路给出的顺序
   * 不可能不一致；差别只在落点怎么算出来。
   */
  const moveFolderBy = useCallback(async (folderId: string, delta: number) => {
    const ids = folders.map((f) => f.id);
    const i = ids.indexOf(folderId);
    if (i < 0) return;
    const dst = i + delta;
    if (dst < 0 || dst >= ids.length) return;   // 首行 ↑ / 末行 ↓ 已经在按钮上禁用
    try {
      await api.reorderFolders(moveItem(ids, i, dst));
      refreshShell();
    } catch (e) {
      showToast({ text: e instanceof ApiFailure ? e.message : '调整失败', tone: 'error' });
    }
  }, [folders, refreshShell, showToast]);

  const moveFeedBy = useCallback(async (folderId: string | null, feedId: string, delta: number) => {
    const kids = folderId === null ? looseFeeds : (feedsByFolder.get(folderId) ?? []);
    const ids = kids.map((f) => f.id);
    const i = ids.indexOf(feedId);
    if (i < 0) return;
    const dst = i + delta;
    if (dst < 0 || dst >= ids.length) return;   // 首行 ↑ / 末行 ↓ 已经在按钮上禁用
    try {
      await api.arrangeFeeds(folderId, moveItem(ids, i, dst));
      refreshShell();
    } catch (e) {
      showToast({ text: e instanceof ApiFailure ? e.message : '调整失败', tone: 'error' });
    }
  }, [feedsByFolder, looseFeeds, refreshShell, showToast]);

  // 排列模式的 Esc 退出（§15.28）。挂在 window 上：焦点可能在任意一行上，
  // 而"退出"是全局语义，不该要求先点到某个容器里。
  //
  // ⚠️ **拖动进行中不退出**：那时 Esc 的语义是"取消这次拖动"，
  // 由 useArrange 自己处理。这里再退一次，用户会把整个排列现场一起丢掉。
  useEffect(() => {
    if (!arranging || arrange.drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 阅读区/搜索框里的 Esc 各有各的用处，别抢 —— 只在没有输入焦点时生效
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (typing) return;
      e.preventDefault();
      setArranging(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arranging, arrange.drag]);

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
   * 从分组树里选中一个范围后用哪个读/全部状态（§15.20 / §15.24，v1.18 改）。
   *
   * **每次点选都按这个范围重新判断，不沿用上一个范围的选择。**
   *
   * v1.17 的写法是 `if (base === 'inbox') return 'inbox'` —— 一旦进过
   * 「全部」，之后再点任何分组都还是「全部」。需求方报的就是这个：
   * 「从长知识的无未读，切换到其他分组（有未读）还是在全部里面」。
   * 那个 if 的本意是"尊重用户手动选的全部"，但它把**状态**当成了
   * **范围的属性**：用户在一个分组里点「全部」，表达的是"这一组我想看全部"，
   * 不是"以后所有分组都看全部"。
   *
   * 现在规则只有一条：点选范围 = 回到默认的「未读」。0 未读的情况不再靠
   * 切视图处理，而是由列表底部的分割线补出已读部分（§15.24）——
   * 所以这里不需要看未读数，也就不存在"判断错了就跳到全部"的隐患。
   */
  const viewForScope = useCallback((): View => DEFAULT_VIEW, []);

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
   *
   * v1.18 起第 3 条简化成"回默认值"（§15.24）：不再看当前是不是 inbox。
   * 原因见 viewForScope —— 那个判断把"视图状态"当成了"范围的属性"。
   */
  const pickFolder = useCallback((folderId: string) => {
    setView(viewForScope());
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
    // 再点同一个 = 取消源筛选。此时范围"变了"（变回整组），所以也要
    // 重新判断读/全部 —— 用户在一个源里点了「全部」，取消筛选后回到
    // 整组时应该是那个组默认的「未读」，否则同一个位置两副面孔。
    setView(viewForScope());
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
    // v2.0（§15.26）：`none` 是"未分组"这个伪范围，不是真实目录 id
    const f = scope.folderId === 'none'
      ? { name: '未分组' }
      : folders.find((x) => x.id === scope.folderId);
    const base = f ? f.name : current.label;
    // 再叠一层源筛选时，标题要同时说清"哪个组 + 哪个源"（§15.13），
    // 否则标题还写「科技IT」，而列表只剩一个源的内容，看起来像丢数据。
    if (!scope.feedId) return base;
    const feed = feedsInScope.find((x) => x.id === scope.feedId);
    return feed ? `${base} · ${feed.title ?? hostOf(feed.url) ?? '该源'}` : base;
  }, [scope.folderId, scope.feedId, folders, feedsInScope, current.label]);

  /** 当前范围的未读数。feed 优先于 folder（选了源时用户看的是那个源） */
  const scopeUnread = scope.feedId
    ? (feeds.find((f) => f.id === scope.feedId)?.unread ?? 0)
    : scope.folderId === 'none'
      // 未分组没有文件夹行可以读角标，只能把组内各源加起来
      ? looseFeeds.reduce((n, f) => n + f.unread, 0)
      : scope.folderId
        ? (folders.find((f) => f.id === scope.folderId)?.unread ?? 0)
        : 0;

  /**
   * 渲染用的尾段：`null` = 不画分割线，数组 = 画分割线并接上这些已读条目。
   *
   * 抽成变量而不是在 JSX 里写 `readTail && readTail.length > 0 &&`：空数组
   * 和 null 在 JSX 里都需要"什么都不画"，但语义不同（前者是"取到了 0 条"）。
   * 统一在这里收敛成一个判断，读的人不需要追问"那 0 条到底画不画"。
   */
  const tail = readTail && readTail.length > 0 ? readTail : null;

  /**
   * 标题行显示的条数（§15.24）。
   *
   * 补了尾段之后，列表里实际有 `未读 + 已读` 两段，而 `total` 只是未读的
   * 命中数（此时为 0）。继续显示「0 条」会和眼睛看到的 4 条直接矛盾 ——
   * 用户会以为界面坏了。所以有尾段时用尾段的 total 顶上。
   *
   * 这不改变 `total` 本身的语义（它仍是"当前筛选的命中数"），只是标题行
   * 这一处要回答的问题是"这个范围里有多少条"，答案不是未读数。
   */
  const displayCount = tail ? readTailTotal : total;

  /**
   * 尾段翻页（§15.24）。
   *
   * 与 `load` 分开而不是复用它：`load` 会把结果 append 到 `items` 并把
   * `cursor` 往前推 —— 那会污染主列表的游标，下一次 `load(true)` 重取时
   * 从尾段的位置开始，主列表就少了一截。两个列表有各自的游标，就该是
   * 两个函数。
   */
  const loadMoreTail = useCallback(async () => {
    if (!readTailCursor) return;
    setTailLoading(true);
    try {
      const r = await api.listEntries({
        view: 'read',
        cursor: readTailCursor,
        limit: READ_TAIL_LIMIT,
        feedId: scope.feedId ?? null,
        folderId: scope.folderId ?? null,
      });
      setReadTail((prev) => [...(prev ?? []), ...r.items]);
      setReadTailCursor(r.nextCursor);
    } catch { /* 尾段翻页失败保持现状，主列表不受影响 */ }
    finally { setTailLoading(false); }
  }, [readTailCursor, scope.feedId, scope.folderId]);

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
    const yes = await confirm({
      title: `把「${listTitle}」里的 ${n} 条未读全部标为已读？`,
      message: `它们不会进入「历史」（那里记录的是你真的打开过的）。\n`
        + `这个操作没有撤销按钮。`,
      confirmText: '全部标为已读',
    });
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
  }, [scope.feedId, scope.folderId, scopeUnread, listTitle, adjustUnread, load, confirm]);

  const scopeHasEntries = readTailTotal > 0 || items.length > 0;

  // 日号栏的分层标记（设计方案 §2.2）：只在"这一天的第一行"上带日期，
  // 其余行为空 —— 日期是结构，重复 30 次就退化成元信息了。
  // 计算结果按 items 的顺序一一对应，长度始终与 items 相等。
  const dayMarks = useMemo(() => markDays(items.map((x) => x.publishedAt)), [items]);

  return (
    <div className="app">
      {/* ── 侧栏 ─────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="brand">
          {/* 标记：三道逐级变短的横线 —— 浑浊静置后逐层沉底。
              这是"澄"这个字在做的事，也是这个工具对信息做的事。
              比直接把字再写一遍更有信息量。 */}
          <span className="brand-mark" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M2 4h12M2 8h8M2 12h4" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-name">澄</span>
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
              · 范围的选择全在左栏一处，符合"左=范围 / 中=列表 / 右=内容"

            v2.0（§15.26）：未分组源**平铺**在这一块里，与分组行同级。
            条件从 `folders.length > 0` 改成「有分组或有未分组源」——
            一个分组都没有但有 2 个未分组源的用户，原来整个区块不渲染，
            那 2 个源在侧栏完全不可见。 */}
        {(folders.length > 0 || looseFeeds.length > 0) && (
          <>
            {/* 区块标题在排列模式下换成操作条（§15.28）：标题说了现在是什么
                状态、右侧给出口。不用浮层工具条 —— 侧栏只有 196px，
                浮层会盖住正在排的那几行。 */}
            {arranging ? (
              <div className="nav-section arrange-head">
                <span>调整顺序</span>
                <button
                  className="btn tiny"
                  onClick={() => setArranging(false)}
                  title="结束调整（Esc）"
                >
                  完成
                </button>
              </div>
            ) : (
              <div className="nav-section">分组</div>
            )}
            <nav
              className={`nav tree ${arranging ? 'arranging' : ''}`}
              aria-label="分组与订阅源"
              aria-grabbed={arrange.drag ? 'true' : undefined}
            >
              {/* 未分组源在最前（§15.28 位置调整，推翻 §15.26 的"排在所有分组之后"）。
                  仍然不造伪分组：它是个不可展开的行。
                  排列模式下它们也参与 —— 可以拖动，拖到分组行上 = 放进该组。
                  外面这层 div 保留 `data-testid`：m1-26 ⑥ 靠"块整块不渲染"
                  判断"全部源都有分组后不留空壳"，去掉它那条断言会失去抓手。 */}
              {looseFeeds.length > 0 && (
              <div className="tree-loose" data-testid="loose-feeds">
              {looseFeeds.map((fd) => {
                const on = scope.feedId === fd.id && scope.folderId === 'none';
                const row: ArrangeRow = {
                  key: rowKey('loose', fd.id), kind: 'loose', id: fd.id, folderId: null,
                  label: fd.title ?? hostOf(fd.url) ?? '未命名源',
                };
                const t = arrange.target;
                const isTargetLine = t?.kind === 'line' && t.key === row.key;
                return (
                  <div
                    key={fd.id}
                    // ⚠️ 这个外层 div **不带** `data-arrange-kind`：
                    // 那是"一行"的标记，会被 `findDropTarget` 与验收脚本按行计数。
                    // 容器也带上的话，行数会翻倍，落点也会命中容器而不是行。
                    className={`arrange-row tree-loose-row-wrap`}
                  >
                    <button
                      // 与分组行**同级**：不加 tree-leaf 的缩进、不加脊线。
                      // 用 tree-row 的形状（含一个空白箭头位）让文字起点
                      // 与分组行对齐 —— 差 15px 会让"它们是一类"这件事垮掉。
                      className={`nav-item tree-row tree-loose-row ${on ? 'active' : ''} ${
                        arrange.drag?.row.key === row.key ? 'dragging' : ''
                      } ${isTargetLine ? 'drop-' + t.pos : ''}`}
                      onClick={() => { if (!arranging) pickFeed('none', fd.id); }}
                      onPointerDown={(e) => arrange.press(row, e)}
                      title={arranging ? `拖动调整「${row.label}」` : (fd.title ?? hostOf(fd.url) ?? fd.url)}
                      aria-pressed={arranging ? undefined : on}
                      data-feed-id={fd.id}
                      data-arrange-kind="loose"
                      data-arrange-id={fd.id}
                      data-arrange-folder=""
                    >
                      <span className="tree-caret" aria-hidden="true">
                        {arranging ? <span className="drag-grip"><i /><i /><i /></span> : null}
                      </span>
                      <span className="nav-label">{row.label}</span>
                      {!arranging && fd.unread > 0 && (
                        <span className="badge">{fd.unread > 999 ? '999+' : fd.unread}</span>
                      )}
                    </button>
                    {arranging && (
                      <span className="arrange-move">
                        <button
                          className="arrange-arrow"
                          disabled={looseFeeds.findIndex((x) => x.id === fd.id) === 0}
                          onClick={() => void moveFeedBy(null, fd.id, -1)}
                          title="上移一位"
                          aria-label={`「${row.label}」上移`}
                        >↑</button>
                        <button
                          className="arrange-arrow"
                          disabled={looseFeeds.findIndex((x) => x.id === fd.id) === looseFeeds.length - 1}
                          onClick={() => void moveFeedBy(null, fd.id, 1)}
                          title="下移一位"
                          aria-label={`「${row.label}」下移`}
                        >↓</button>
                      </span>
                    )}
                  </div>
                );
              })}
              </div>
              )}

              {folders.map((f, fi) => {
                const open = expanded.has(f.id) && !arranging;
                const kids = feedsByFolder.get(f.id) ?? [];
                // 选中整组（没有源筛选）时组行才是"当前范围"；
                // 选了组内某个源时高亮转移到子行，组行只保留展开箭头的高亮。
                const groupActive = scope.folderId === f.id && !scope.feedId;
                const row: ArrangeRow = {
                  key: rowKey('folder', f.id), kind: 'folder', id: f.id, folderId: f.id, label: f.name,
                };
                const t = arrange.target;
                const isDropLine = t?.kind === 'line' && t.key === row.key;
                // 拖着一个源悬在这一组上 = "放进这一组"
                const isInto = t?.kind === 'into' && t.folderId === f.id
                  && arrange.drag?.row.kind !== 'folder';
                return (
                  <div className="tree-group" key={f.id}>
                    {/* ⚠️ 排列模式下 ↑↓ **不能**嵌在行按钮里 —— `<button>` 里
                        套 `<button>` 是无效 HTML：浏览器会把它拆成兄弟节点，
                        键盘焦点与无障碍树都跟着坏，而 React 不会报错。
                        所以排列模式下这一行改成 div 容器 + 行按钮 + 箭头兄弟。

                        非排列模式仍是单个 `<button>`：m1-26 量的 labelLeft /
                        height / caretW 全挂在 `.tree-row` 上，多包一层会让那三条
                        一起偏。也正因为如此，包与不包必须条件切换而不是统一包。 */}
                    {arranging ? (
                      <div
                        className={`arrange-row ${isDropLine ? 'drop-' + t.pos : ''} ${
                          isInto ? 'into' : ''
                        } ${arrange.drag?.row.key === row.key ? 'dragging' : ''}`}
                        data-arrange-kind="folder"
                        data-arrange-id={f.id}
                      >
                        <button
                          className="nav-item tree-row"
                          onPointerDown={(e) => arrange.press(row, e)}
                          title={`拖动调整「${f.name}」的位置${arrange.drag?.row.kind === 'feed' ? '，或把源放进来' : ''}`}
                          tabIndex={0}
                        >
                          <span className="tree-caret" aria-hidden="true">
                            <span className="drag-grip"><i /><i /><i /></span>
                          </span>
                          <span className="nav-label">{f.name}</span>
                        </button>
                        <span className="arrange-move">
                          <button
                            className="arrange-arrow"
                            disabled={fi === 0}
                            onClick={() => void moveFolderBy(f.id, -1)}
                            title="上移一位"
                            aria-label={`「${f.name}」上移`}
                          >↑</button>
                          <button
                            className="arrange-arrow"
                            disabled={fi === folders.length - 1}
                            onClick={() => void moveFolderBy(f.id, 1)}
                            title="下移一位"
                            aria-label={`「${f.name}」下移`}
                          >↓</button>
                        </span>
                      </div>
                    ) : (
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
                      // 非排列模式下 `data-arrange-*` 也必须挂在这一行上：
                      // 长按要按它找到这一行的矩形（算抓取点偏移），
                      // 而验收脚本按它数行 —— 只在排列分支加的话，
                      // 进模式前一行都数不到，长按也无从开始。
                      data-arrange-kind="folder"
                      data-arrange-id={f.id}
                      // 长按从这里起算：不进模式的那一下仍是普通点击
                      onPointerDown={(e) => arrange.press(row, e)}
                    >
                      <span className="tree-caret" aria-hidden="true">
                        <IconChevronRight size={13} />
                      </span>
                      <span className="nav-label">{f.name}</span>
                      {f.unread > 0 && (
                        <span className="badge">{f.unread > 999 ? '999+' : f.unread}</span>
                      )}
                    </button>
                    )}

                    {/* 子行：组内每个源一行。0 未读也显示 —— "没新内容"是信息。
                        组里 0 个源时不渲染，避免一条空脊线。
                        排列模式下也渲染（否则组内源没法排），但收起状态不渲染。 */}
                    {(open || (arranging && kids.length > 0)) && kids.length > 0 && (
                      <ul className="tree-kids">
                        {kids.map((fd, ki) => {
                          const on = scope.feedId === fd.id;
                          const krow: ArrangeRow = {
                            key: rowKey('feed', fd.id), kind: 'feed', id: fd.id,
                            folderId: f.id, label: fd.title ?? hostOf(fd.url) ?? '未命名源',
                          };
                          const kIsLine = t?.kind === 'line' && t.key === krow.key;
                          return (
                            <li key={fd.id}>
                              {/* 同组行：排列模式下拆成 div + 按钮 + 箭头兄弟，
                                  避免 `<button>` 套 `<button>`（无效 HTML）。 */}
                              {arranging ? (
                                <div
                                  className={`arrange-row ${kIsLine ? 'drop-' + t.pos : ''} ${
                                    arrange.drag?.row.key === krow.key ? 'dragging' : ''
                                  }`}
                                  data-arrange-kind="feed"
                                  data-arrange-id={fd.id}
                                  data-arrange-folder={f.id}
                                >
                                  <button
                                    className="tree-leaf"
                                    onPointerDown={(e) => arrange.press(krow, e)}
                                    title={`拖动调整「${krow.label}」的位置`}
                                    tabIndex={0}
                                  >
                                    <span className="tree-leaf-name">{krow.label}</span>
                                  </button>
                                  <span className="arrange-move">
                                    <button
                                      className="arrange-arrow"
                                      disabled={ki === 0}
                                      onClick={() => void moveFeedBy(f.id, fd.id, -1)}
                                      title="上移一位"
                                      aria-label={`「${krow.label}」上移`}
                                    >↑</button>
                                    <button
                                      className="arrange-arrow"
                                      disabled={ki === kids.length - 1}
                                      onClick={() => void moveFeedBy(f.id, fd.id, 1)}
                                      title="下移一位"
                                      aria-label={`「${krow.label}」下移`}
                                    >↓</button>
                                  </span>
                                </div>
                              ) : (
                              <button
                                className={`tree-leaf ${on ? 'active' : ''}`}
                                onClick={() => pickFeed(f.id, fd.id)}
                                title={fd.title ?? hostOf(fd.url) ?? fd.url}
                                aria-pressed={on}
                                // 同上：非排列模式也要能长按这一行
                                data-arrange-kind="feed"
                                data-arrange-id={fd.id}
                                data-arrange-folder={f.id}
                                onPointerDown={(e) => arrange.press(krow, e)}
                              >
                                <span className="tree-leaf-name">{krow.label}</span>
                                {/* 未读数用文字而不是 badge：子行里再挂一个
                                    胶囊会和父行的角标抢同一种视觉重量，
                                    展开后整块看起来像一排按钮。 */}
                                <span className={`tree-leaf-count ${fd.unread > 0 ? 'has' : ''}`}>
                                  {fd.unread > 999 ? '999+' : fd.unread}
                                </span>
                              </button>
                              )}
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

        {/* 「即将支持」整块在 SOON 为空时不渲染 ——
            一个只有标题、下面什么都没有的分区比没有更糟。 */}
        {SOON.length > 0 && (
          <>
            <div className="nav-section">即将支持</div>
            <nav className="nav">
              {SOON.map((s2) => (
                <button key={s2.label} className="nav-item soon" disabled>
                  <span className="nav-icon">{s2.icon}</span>
                  <span className="nav-label">{s2.label}</span>
                  <span className="soon-tag">待接入</span>
                </button>
              ))}
            </nav>
          </>
        )}

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
          // 配置页的「移到…」也走应用级 toast（§15.28）：
          // ≤640px 没有侧栏，那是手机上唯一能搬动源的入口，
          // 不给它撤销入口的话「移出分组可撤销」这条在手机上就达不到
          onToast={(t) => showToast({
            text: t.text,
            tone: t.tone,
            action: t.onUndo ? { label: '撤销', onRun: t.onUndo } : undefined,
          })}
        />
      )}

      {/* 简报视图：整块替换「列表 + 阅读区」。
          它是同层的另一种布局（日期列表 + 简报正文），
          塞进 list-pane 会渲染出一个空着的阅读区。 */}
      {view === 'digest' && <DigestPage narrow={false} />}

      {view !== 'digest' && (
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
            {(displayCount !== null || items.length > 0) && (
              <span className="pane-count">
                {/* 数字统一来自后端的 `total`（命中总数），不是 items.length。
                    第一版用 items.length，截图里就出现过「科技IT 30 条」
                    而该组真实 40 条 —— 首页只取 30，滚到底才补齐。

                    v1.9 又收窄了一层：原来只在「有搜索词 / 有分组」时才用
                    total，其余情况用 stats.entries。加了「未读」分段之后，
                    这个条件就是错的 —— 切到「未读」时既没有搜索词也没有分组，
                    于是标题仍显示全库条数，而列表只有未读那几条。一律用
                    total 之后，「当前这个视图有多少条」天然成立，
                    不需要为每个新筛选再补一个分支。

                    v1.18 再收一层（§15.24）：补了已读尾段时，`total` 是
                    未读的命中数（0），而列表里有未读+已读两段。继续显示
                    「0 条」会和眼睛看到的 4 条直接矛盾。此时改用尾段的
                    total，答案才是"这个范围里有多少条"。 */}
                {`${displayCount ?? items.length} 条${debounced ? '结果' : ''}`}
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
              一个已经订阅了 12 个源的用户会看到它闪一下。

              还要等分割线尾段（`tail`）：v1.18 起"这个范围的未读读光了"
              不等于列表要空 —— 已读部分会被补在分割线下面。少了这一条，
              读光的源会先闪一帧「未读已经清零」，然后才被已读列表顶掉。 */}
          {!loading && feedsLoaded && items.length === 0 && tail === null
            && !tailFetching && view !== 'history' && (
            <EmptyState
              hasQuery={Boolean(debounced)}
              view={view}
              scopeLabel={scope.folderId ? listTitle : null}
              hasFeeds={feeds.length > 0}
              scopeHasEntries={scopeHasEntries}
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
                      <EntryRow
                        key={it.id}
                        it={it}
                        active={openId === it.id}
                        onOpen={() => void open(it.id)}
                        onStar={() => void toggleStar(it.id)}
                        meta={<HistoryMeta it={it} />}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )
          )}

          {view !== 'history' && (
          <ul className="entry-list">
            {items.map((it, i) => (
              <EntryRow
                key={it.id}
                it={it}
                active={openId === it.id}
                onOpen={() => void open(it.id)}
                onStar={() => void toggleStar(it.id)}
                day={dayMarks[i]}
              />
            ))}
            {/* 分割线 + 已读尾段（§15.24，v1.18）。
                需求方原话：「我切换未读之后，如果某一个里面没有未读…
                是指在列表栏中分割线，补充上全部的列表」。

                为什么和主列表放在**同一个 <ul>** 里、而不是第二个列表：
                它表达的是"同一个列表继续往下"，分割线是列表内部的分节。
                拆成两个 <ul> 会多出一层块级边界，行距在分割线两侧对不上，
                而且"加载更多"该挂在哪一个上会变成一个问题。

                为什么保留「未读」分段不动：用户点的就是"未读"，被偷偷
                改成「全部」会让人以为自己点错了。分割线把这个变化说在
                明面上 —— 上面是未读，下面是更早读过的。 */}
            {tail && (
              <li className="list-divider" data-count={String(readTailTotal)} role="separator">
                <span className="list-divider-text">
                  {readTailTotal > tail.length
                    ? `更早的 ${readTailTotal} 条已读`
                    : `更早的 ${tail.length} 条已读`}
                </span>
              </li>
            )}
            {tail?.map((it) => (
              <EntryRow
                key={it.id}
                it={it}
                active={openId === it.id}
                onOpen={() => void open(it.id)}
                onStar={() => void toggleStar(it.id)}
              />
            ))}
          </ul>
          )}

          {/* 尾段没取全时单独给一个"加载更多"（§15.24）。
              与主列表的 `cursor` 分开：主列表此时已经到底（total=0），
              它那个加载更多不会出现；尾段自己还有下一页。 */}
          {tail && readTailCursor && (
            <div className="load-more">
              <button
                className="btn"
                disabled={tailLoading}
                onClick={() => void loadMoreTail()}
              >
                {tailLoading ? '加载中…' : `继续加载更早的 ${Math.max(0, readTailTotal - tail.length)} 条`}
              </button>
            </div>
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
          // 阅读区单独兜底：正文解析、目录生成、surroundContents 包高亮都在
          // Reader 里，是全局最容易抛异常的一段。根部边界一触发就换掉整个
          // App，列表和筛选跟着没了；这里炸只丢这一栏，onReset 复用列表行
          // 本来就有的返回动作，列表原样还在。
          <ErrorBoundary
            label="阅读区"
            onReset={() => { setOpenId(null); setDetail(null); }}
          >
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
          </ErrorBoundary>
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

      {/* 浮起的拖动卡片（§15.28）。
          为什么用 fixed 且 pointer-events: none：
            · fixed 才能脱离侧栏的 overflow 裁剪 —— 侧栏是 overflow-y: auto，
              拖出侧栏右边界的部分会被切掉；
            · pointer-events: none 关掉自身命中，否则它永远在指针正下方，
              findDropTarget 会一直落回它自己，落点永远不动。
          位置用 transform 而不是 left/top：拖动每帧都要改，transform 走合成层，
          left/top 会触发布局。 */}
      {arrange.drag && (
        <div
          className="drag-ghost"
          style={{
            transform: `translate(${arrange.drag.x - arrange.drag.grabX}px, ${
              arrange.drag.y - arrange.drag.grabY}px)`,
          }}
          aria-hidden="true"
        >
          {arrange.drag.row.kind === 'folder' ? <IconFolder size={13} /> : <IconRss size={13} />}
          <span className="drag-ghost-label">{arrange.drag.row.label}</span>
        </div>
      )}

      {/* 底部提示条（§15.28）：跨组移动后的确认与撤销。
          挂在根 div 里而不是每个视图里 —— 它跟着操作走，不跟着视图走。 */}
      <ToastHost toast={toast} onDone={(id) => {
        setToast((cur) => (cur && cur.id === id ? null : cur));
      }} />
    </div>
  );
}
