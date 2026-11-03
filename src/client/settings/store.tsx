// 订阅数据的共享层（PLAN §15.15）。
//
// 为什么要有这一层：配置弹窗把「订阅」和「分组」拆成了两个分类页，
// 它们看的是**同一批数据** —— 源列表、分组列表、当前选中的分组。
// 在 分组 页删掉一个分组，回到 订阅 页必须立刻看到源退回未分组，
// 而不是"改了但界面还是旧的"。
//
// 所以数据（feeds/folders/filter/err/notice/busy）放在一个 context 里，
// 两个分类页只持有自己的**界面态**（哪个源在编辑、选中了哪几个、
// 输入框里是什么）。这条分界也让两边都不需要知道对方存在。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { api, ApiFailure, type FeedItem, type FolderItem } from '../api.ts';

/** 未分组用的伪 id，避免和真实 folder id 混淆 */
export const UNFILED = 'none';

export interface FeedsStore {
  feeds: FeedItem[];
  folders: FolderItem[];
  loading: boolean;
  err: string;
  notice: string;
  busy: boolean;
  /** 当前筛选的分组：null=全部，UNFILED=未分组，其他=分组 id */
  filter: string | null;
  setFilter: (v: string | null) => void;
  setErr: (v: string) => void;
  setNotice: (v: string) => void;
  setBusy: (v: boolean) => void;
  /** 重新拉取源与分组 */
  reload: () => Promise<void>;
  /** 统一把异常转成可读文案（ApiFailure 有用信息，其余兜底） */
  fail: (e: unknown, fallback: string) => void;
  /** 当前筛选下的源 */
  visible: FeedItem[];
  /** 按分组归拢，未分组放最后。组内保持 listFeeds 的排序（失效源已排后） */
  grouped: [string, { name: string | null; items: FeedItem[] }][];
  unfiledCount: number;
  totalUnread: number;
  /** 标记为「失效」的源数（§15.23 v1.17）：>0 时订阅页顶部出现「重试失效源」 */
  brokenCount: number;
  /** 弹应用级 toast（§15.28）；配置弹窗没拿到时不弹，不报错 */
  toast: (t: { text: string; tone?: 'ok' | 'error'; onUndo?: () => void | Promise<void> }) => void;
}

const Ctx = createContext<FeedsStore | null>(null);

export function FeedsProvider(props: {
  children: ReactNode;
  onChanged?: () => void;
  /**
   * 弹一条应用级 toast（§15.28）。配置页的「移到…」也要能用它 ——
   * ≤640px 时侧栏是 display:none，配置页是手机上**唯一**能把源在组间
   * 搬动的入口。如果那里只能弹一条没有撤销的内联 notice，那么
   * "进入/移出分组可撤销"这条目标在手机上就完全达不到。
   */
  onToast?: (t: { text: string; tone?: 'ok' | 'error'; onUndo?: () => void | Promise<void> }) => void;
}) {
  const [feeds, setFeeds] = useState<FeedItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  // onChanged 用 ref 存：它是父组件的回调，每次渲染都是新函数，
  // 放进 reload 的 deps 会让 reload 每帧都变，从而每次渲染都触发加载。
  const changedRef = useRef(props.onChanged);
  changedRef.current = props.onChanged;

  const reload = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      // 一次拿全量：源数量在几十到几百量级，前端自己分组比
      // "切一次分组打一次请求"更跟手，也不会出现切组时闪白。
      const r = await api.listFeeds();
      setFeeds(r.items);
      setFolders(r.folders);
      changedRef.current?.();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const fail = useCallback((e: unknown, fallback: string) => {
    setErr(e instanceof ApiFailure ? e.message : (e instanceof Error ? e.message : fallback));
  }, []);

  const visible = useMemo(() => {
    if (filter === null) return feeds;
    if (filter === UNFILED) return feeds.filter((f) => !f.folderId);
    return feeds.filter((f) => f.folderId === filter);
  }, [feeds, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string | null; items: FeedItem[] }>();
    for (const f of visible) {
      const key = f.folderId ?? UNFILED;
      const cur = map.get(key) ?? { name: f.folderName ?? null, items: [] };
      cur.items.push(f);
      map.set(key, cur);
    }
    const rank = (k: string) => {
      const i = folders.findIndex((x) => x.id === k);
      return i < 0 ? 999 : i;
    };
    // 有分组的按 folders 的 sort 排，未分组永远最后
    const ordered: [string, { name: string | null; items: FeedItem[] }][] = [...map.entries()]
      .filter(([k]) => k !== UNFILED)
      .sort(([a], [b]) => rank(a) - rank(b));
    const unfiled = map.get(UNFILED);
    if (unfiled) ordered.push([UNFILED, unfiled]);
    return ordered;
  }, [visible, folders]);

  const unfiledCount = useMemo(() => feeds.filter((f) => !f.folderId).length, [feeds]);
  const totalUnread = useMemo(() => feeds.reduce((n, f) => n + f.unread, 0), [feeds]);
  const brokenCount = useMemo(() => feeds.filter((f) => f.status === 'broken').length, [feeds]);

  const value: FeedsStore = {
    feeds, folders, loading, err, notice, busy,
    filter, setFilter, setErr, setNotice, setBusy,
    reload, fail, visible, grouped, unfiledCount, totalUnread, brokenCount,
    // 配置弹窗没被传 onToast 时退化成一个空实现：调用方不用到处判空，
    // 而代价只是"这条提示没弹出来"—— 比让整个配置页崩掉好。
    toast: props.onToast ?? (() => {}),
  };

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
export function useFeeds(): FeedsStore {
  const v = useContext(Ctx);
  // 不返回一个"空 store"当兜底：那样组件会渲染成一片空列表，
  // 看起来像"没有订阅"，而实际是忘了包 Provider —— 这类错误必须炸出来。
  if (!v) throw new Error('useFeeds 必须在 <FeedsProvider> 内使用');
  return v;
}

/** 源数量少时 chip 够用，多了必须换下拉（§15.15） */
export const FOLDER_DROPDOWN_THRESHOLD = 3;
