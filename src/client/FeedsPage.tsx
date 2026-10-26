import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiFailure, type DiscoverCandidate, type FeedItem, type FolderItem,
} from './api.ts';
import {
  IconCheck, IconChevronRight, IconEdit, IconExternal, IconFolder, IconPause, IconPlay,
  IconRefresh, IconRss, IconSearch, IconTrash,
} from './icons.tsx';

// 订阅管理（PLAN §10、§18）。
//
// 一个输入框解决 90% 的用法：贴什么都能订阅。
//   · 完整 feed URL      → 直接用
//   · 网站首页           → 自动发现 <link rel=alternate>
//   · 裸域名（x.com）    → 补 https:// 再发现
//   · 一段带 URL 的文字  → 抠出第一个 URL
//
// "发现到多个 feed" 时让用户选，而不是替他挑 —— 主站和评论区分开的站点不少。
//
// 分组用一层扁平结构（folders 表没有 parent_id）。理由见 feeds/folders.ts。

/** 未分组用的伪 id，避免和真实 folder id 混淆 */
const UNFILED = 'none';

interface EditState {
  feed: FeedItem;
  title: string;
  folderId: string;
  intervalMin: number;
}

export function FeedsPage(props: { onOpenInbox: () => void }) {
  const [feeds, setFeeds] = useState<FeedItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [candidates, setCandidates] = useState<DiscoverCandidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  /** 当前筛选的分组：null=全部，UNFILED=未分组，其他=分组 id */
  const [filter, setFilter] = useState<string | null>(null);
  /** 正在编辑的订阅；null 表示弹窗关闭 */
  const [editing, setEditing] = useState<EditState | null>(null);
  /** 分组管理面板是否展开 */
  const [managingFolders, setManagingFolders] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 加载失败的图标 id，回退成占位图标而不是留空方块 */
  const [iconFailed, setIconFailed] = useState<Set<string>>(new Set());
  /** 批量管理模式。进入后每行左侧出勾选框，顶部出批量操作栏 */
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      // 一次拿全量：源数量在几十到几百量级，前端自己分组比
      // "切一次分组打一次请求"更跟手，也不会出现切组时闪白。
      const r = await api.listFeeds();
      setFeeds(r.items);
      setFolders(r.folders);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const resetAdd = () => {
    setAdding(false);
    setInput('');
    setCandidates(null);
    setNotes([]);
    setNotice('');
    setErr('');
  };

  /** 先发现；只找到一个就直接订阅，多个让用户选 */
  const discover = async () => {
    const url = input.trim();
    if (!url) return;
    setBusy(true);
    setErr('');
    setNotice('');
    setCandidates(null);
    setNotes([]);
    try {
      const r = await api.discoverFeed(url);
      if (!r.found) {
        setErr(r.message ?? '没有找到可用的 feed');
        setNotes(r.notes);
        return;
      }
      if (r.candidates.length === 1) {
        await subscribe(r.candidates[0]!.url);
      } else {
        setCandidates(r.candidates);
        setNotes(r.notes);
      }
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '发现失败');
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async (url: string) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.addFeed(url);
      setNotice(
        r.created
          ? `已订阅「${r.feed.title ?? url}」，导入 ${r.imported ?? 0} 条`
          : '这个源已经在订阅列表里了',
      );
      setCandidates(null);
      setInput('');
      setAdding(false);
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '订阅失败');
    } finally {
      setBusy(false);
    }
  };

  const refreshOne = async (id: string) => {
    try {
      await api.refreshFeed(id);
      setNotice('已加入抓取队列，稍后刷新');
      setTimeout(() => void load(), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '刷新失败');
    }
  };

  const refreshAll = async () => {
    setBusy(true);
    try {
      const r = await api.refreshAllFeeds();
      setNotice(`已把 ${r.queued} 个源加入抓取队列`);
      setTimeout(() => void load(), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '刷新失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: FeedItem) => {
    const ok = window.confirm(
      `取消订阅「${f.title ?? f.url}」？\n\n`
      + `未读的 ${f.unread} 条会一起删除；已读和已收藏的条目会保留在列表里。`,
    );
    if (!ok) return;
    try {
      await api.deleteFeed(f.id);
      setNotice('已取消订阅');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    }
  };

  const togglePause = async (f: FeedItem) => {
    try {
      await api.updateFeed(f.id, { status: f.status === 'paused' ? 'active' : 'paused' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    }
  };

  const exportOpml = async () => {
    try {
      const xml = await api.exportOpml();
      const blob = new Blob([xml], { type: 'text/x-opml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ai-rss-feeds-${new Date().toISOString().slice(0, 10)}.opml`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导出失败');
    }
  };

  const importOpml = async (file: File) => {
    setBusy(true);
    setErr('');
    try {
      const text = await file.text();
      const r = await api.importOpml(text);
      setNotice(`导入 ${r.created} 个订阅${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '导入失败');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // ── 编辑 ────────────────────────────────────────────────
  const startEdit = (f: FeedItem) => {
    setEditing({
      feed: f,
      title: f.title ?? '',
      folderId: f.folderId ?? UNFILED,
      intervalMin: Math.round(f.fetchInterval / 60),
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setErr('');
    try {
      await api.editFeed(editing.feed.id, {
        title: editing.title.trim() || null,
        folderId: editing.folderId === UNFILED ? null : editing.folderId,
        fetchInterval: Math.max(5, Math.round(editing.intervalMin)) * 60,
      });
      setNotice(`已保存「${editing.title.trim() || editing.feed.url}」`);
      setEditing(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  // ── 分组管理 ────────────────────────────────────────────
  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    try {
      await api.createFolder(name);
      setNewFolderName('');
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '新建分组失败');
    } finally {
      setBusy(false);
    }
  };

  const renameFolder = async (f: FolderItem) => {
    const name = window.prompt('新的分组名', f.name);
    if (name === null) return;
    if (!name.trim()) return;
    try {
      await api.renameFolder(f.id, name.trim());
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '重命名失败');
    }
  };

  const removeFolder = async (f: FolderItem) => {
    const ok = window.confirm(
      `删除分组「${f.name}」？\n\n`
      + `里面的 ${f.feedCount} 个订阅不会被删，会退回「未分组」。`,
    );
    if (!ok) return;
    try {
      await api.deleteFolder(f.id);
      if (filter === f.id) setFilter(null);
      setNotice('分组已删除，里面的订阅退回未分组');
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '删除失败');
    }
  };

  // ── 批量管理（§15.10）──────────────────────────────────
  //
  // 状态只存 id 的 Set。为什么不存"选中对象"：批量操作期间列表可能
  // 因为后台抓取而重载，持有对象会指向旧快照；id 永远有效。
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** 组头的框：本组全选 / 全不选（不影响其它组） */
  const toggleGroup = (items: FeedItem[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = items.every((f) => next.has(f.id));
      for (const f of items) {
        if (allIn) next.delete(f.id); else next.add(f.id);
      }
      return next;
    });
  };

  const enterBulk = () => {
    setBulkMode(true);
    setSelected(new Set());
    setManagingFolders(false);
  };
  const exitBulk = () => {
    setBulkMode(false);
    setSelected(new Set());
  };

  /** 所有批量操作共用的执行器：跑完清空选择、重载、写 notice */
  const runBulk = async (
    label: string,
    fn: (ids: string[]) => Promise<{ done: number; skipped: number; missing: string[] }>,
  ) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    setErr('');
    try {
      const r = await fn(ids);
      const bits = [`${label} ${r.done} 个`];
      if (r.skipped) bits.push(`跳过 ${r.skipped} 个`);
      // missing 单独说：它意味着数据已经不是我们看到的样子了
      if (r.missing.length) bits.push(`${r.missing.length} 个已不存在`);
      setNotice(bits.join('，'));
      setSelected(new Set());
      await load();
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : `${label}失败`);
    } finally {
      setBusy(false);
    }
  };

  const bulkMove = async (folderId: string | null) => {
    const name = folderId === null
      ? '未分组'
      : (folders.find((f) => f.id === folderId)?.name ?? '分组');
    await runBulk(`移入「${name}」`, (ids) => api.bulkMoveToFolder(ids, folderId));
  };

  const bulkPause = async (status: 'active' | 'paused') => {
    await runBulk(status === 'paused' ? '暂停' : '恢复', (ids) => api.bulkSetStatus(ids, status));
  };

  const bulkRefresh = async () => {
    await runBulk('加入抓取队列', (ids) => api.bulkRefresh(ids));
  };

  const bulkRemove = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    // 这条必须确认：是唯一不可撤销的批量操作
    const unread = feeds
      .filter((f) => ids.includes(f.id))
      .reduce((n, f) => n + f.unread, 0);
    const ok = window.confirm(
      `取消订阅这 ${ids.length} 个源？\n\n`
      + `未读的 ${unread} 条会一起删除；已读和已收藏的条目会保留。\n`
      + `这个操作不能撤销。`,
    );
    if (!ok) return;
    await runBulk('取消订阅', (x) => api.bulkDelete(x));
  };

  // ── 分组后的数据 ────────────────────────────────────────
  const visible = useMemo(() => {
    if (filter === null) return feeds;
    if (filter === UNFILED) return feeds.filter((f) => !f.folderId);
    return feeds.filter((f) => f.folderId === filter);
  }, [feeds, filter]);

  /** 按分组归拢，未分组放最后。组内保持 listFeeds 的排序（失效源已排后） */
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string | null; items: FeedItem[] }>();
    for (const f of visible) {
      const key = f.folderId ?? UNFILED;
      const cur = map.get(key) ?? { name: f.folderName ?? null, items: [] };
      cur.items.push(f);
      map.set(key, cur);
    }
    // 有分组的按 folders 的 sort 排，未分组永远最后
    const ordered = [...map.entries()]
      .filter(([k]) => k !== UNFILED)
      .sort(([a], [b]) => {
        const ia = folders.findIndex((x) => x.id === a);
        const ib = folders.findIndex((x) => x.id === b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
    if (map.has(UNFILED)) ordered.push([UNFILED, map.get(UNFILED)!]);
    return ordered;
  }, [visible, folders]);

  const unfiledCount = feeds.filter((f) => !f.folderId).length;
  const totalUnread = feeds.reduce((n, f) => n + f.unread, 0);

  return (
    <div className={`feeds-page ${bulkMode ? 'bulk-on' : ''}`}>
      <header className="feeds-head">
        <div>
          <h1>订阅</h1>
          <p className="muted">
            {feeds.length > 0
              ? `${feeds.length} 个源 · ${totalUnread} 条未读`
                + (folders.length > 0 ? ` · ${folders.length} 个分组` : '')
              : '还没有订阅任何源'}
          </p>
        </div>
        <div className="feeds-actions">
          <button
            className={`btn ${bulkMode ? 'active' : ''}`}
            onClick={() => (bulkMode ? exitBulk() : enterBulk())}
            disabled={feeds.length === 0}
          >
            {bulkMode ? '退出管理' : '管理'}
          </button>
          <button className="btn" onClick={() => setManagingFolders((v) => !v)}>
            分组
          </button>
          <button className="btn" onClick={() => void exportOpml()} disabled={feeds.length === 0}>
            导出 OPML
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            导入 OPML
          </button>
          <input
            ref={fileRef} type="file" accept=".opml,.xml,text/x-opml,application/xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importOpml(f);
            }}
          />
          <button className="btn primary" onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 50); }}>
            + 添加订阅
          </button>
        </div>
      </header>

      {err && <div className="alert error inset">{err}</div>}
      {notice && <div className="alert ok inset">{notice}</div>}

      {/* ── 批量操作栏 ───────────────────────────────────── */}
      {bulkMode && (
        <div className="bulk-bar">
          <div className="bulk-count">
            已选 <strong>{selected.size}</strong> / {visible.length}
          </div>
          <button
            className="btn tiny"
            onClick={() => setSelected(new Set(visible.map((f) => f.id)))}
            disabled={busy || selected.size === visible.length}
          >
            全选
          </button>
          <button
            className="btn tiny"
            onClick={() => setSelected(new Set())}
            disabled={busy || selected.size === 0}
          >
            清空
          </button>
          <div className="grow" />

          <select
            className="bulk-select"
            value=""
            disabled={busy || selected.size === 0}
            onChange={(e) => {
              const v = e.target.value;
              if (v) void bulkMove(v === UNFILED ? null : v);
              e.target.value = '';
            }}
          >
            <option value="">移到分组…</option>
            <option value={UNFILED}>未分组</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>

          <button className="btn tiny" onClick={() => void bulkPause('active')} disabled={busy || selected.size === 0}>
            恢复
          </button>
          <button className="btn tiny" onClick={() => void bulkPause('paused')} disabled={busy || selected.size === 0}>
            暂停
          </button>
          <button className="btn tiny" onClick={() => void bulkRefresh()} disabled={busy || selected.size === 0}>
            刷新
          </button>
          <button className="btn tiny danger" onClick={() => void bulkRemove()} disabled={busy || selected.size === 0}>
            删除
          </button>
        </div>
      )}

      {/* ── 分组管理面板 ─────────────────────────────────── */}
      {managingFolders && (
        <div className="folder-panel">
          <div className="folder-panel-head">
            <strong>分组</strong>
            <span className="muted">用来把几十个源归拢，侧栏也能按组看</span>
          </div>

          <div className="add-row">
            <div className="search-box grow">
              <IconFolder size={15} className="search-icon" />
              <input
                placeholder="新分组名，例如「科技」「财经」"
                value={newFolderName}
                disabled={busy}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addFolder(); }}
              />
            </div>
            <button className="btn primary" onClick={() => void addFolder()} disabled={busy || !newFolderName.trim()}>
              新建
            </button>
          </div>

          {folders.length === 0 ? (
            <p className="hint">还没有分组。建一个之后，可以从订阅行的「编辑」里放进去。</p>
          ) : (
            <ul className="folder-manage-list">
              {folders.map((f) => (
                <li key={f.id}>
                  <IconFolder size={14} />
                  <span className="folder-name">{f.name}</span>
                  <span className="muted">{f.feedCount} 个源</span>
                  <div className="grow" />
                  <button className="btn tiny" onClick={() => void renameFolder(f)}>重命名</button>
                  <button className="btn tiny danger" onClick={() => void removeFolder(f)}>删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── 筛选条 ───────────────────────────────────────── */}
      {feeds.length > 0 && (folders.length > 0 || filter !== null) && (
        <div className="folder-filter">
          <button
            className={`chip ${filter === null ? 'active' : ''}`}
            onClick={() => setFilter(null)}
          >
            全部 <span className="chip-count">{feeds.length}</span>
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              className={`chip ${filter === f.id ? 'active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.name} <span className="chip-count">{f.feedCount}</span>
            </button>
          ))}
          {unfiledCount > 0 && (
            <button
              className={`chip ${filter === UNFILED ? 'active' : ''}`}
              onClick={() => setFilter(UNFILED)}
            >
              未分组 <span className="chip-count">{unfiledCount}</span>
            </button>
          )}
        </div>
      )}

      {adding && (
        <div className="add-panel">
          <div className="add-row">
            <div className="search-box grow">
              <IconSearch size={15} className="search-icon" />
              <input
                ref={inputRef}
                placeholder="贴网站地址或 feed 地址，例如 https://sspai.com"
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void discover();
                  if (e.key === 'Escape') resetAdd();
                }}
              />
            </div>
            <button className="btn primary" onClick={() => void discover()} disabled={busy || !input.trim()}>
              {busy ? '查找中…' : '查找并订阅'}
            </button>
            <button className="btn" onClick={resetAdd} disabled={busy}>取消</button>
          </div>
          <p className="hint">
            直接贴网站首页也可以 —— 会自动从页面里找订阅地址。
          </p>

          {notes.length > 0 && (
            <ul className="notes">
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          {candidates && candidates.length > 0 && (
            <div className="candidates">
              <div className="candidates-title">找到 {candidates.length} 个订阅地址，选一个：</div>
              {candidates.map((c) => (
                <button
                  key={c.url}
                  className="candidate"
                  onClick={() => void subscribe(c.url)}
                  disabled={busy}
                >
                  {c.iconUrl
                    ? <img className="favicon" src={c.iconUrl} alt=""
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                    : <IconRss size={15} />}
                  <div className="candidate-main">
                    <div className="candidate-title">{c.title ?? c.url}</div>
                    <div className="candidate-url">{c.url}</div>
                  </div>
                  <span className="candidate-count">{c.itemCount} 条</span>
                  <IconChevronRight size={15} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && feeds.length === 0 && (
        <div className="empty"><span className="spinner" /></div>
      )}

      {!loading && feeds.length === 0 && !adding && (
        <div className="empty">
          <div className="ph-art"><IconRss size={26} /></div>
          <h2>还没有订阅</h2>
          <p>添加第一个 RSS 源，或从别的阅读器导入 OPML。没有源的话也可以直接用 Huntly 插件保存网页。</p>
          <div className="empty-actions">
            <button className="btn primary" onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 50); }}>
              添加订阅
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>导入 OPML</button>
          </div>
        </div>
      )}

      {visible.length > 0 && grouped.map(([key, g]) => (
        <section key={key} className="feed-group">
          <div className="feed-group-head">
            {bulkMode && (
              <button
                className="bulk-check"
                title={g.items.every((f) => selected.has(f.id)) ? '取消本组' : '选中本组'}
                onClick={() => toggleGroup(g.items)}
              >
                <IconCheck
                  size={16} checked={g.items.length > 0 && g.items.every((f) => selected.has(f.id))}
                  className={
                    g.items.length > 0 && g.items.every((f) => selected.has(f.id))
                      ? 'checked' : ''
                  }
                />
              </button>
            )}
            <IconFolder size={13} />
            <span>{g.name ?? '未分组'}</span>
            <span className="muted">{g.items.length} 个源</span>
            <div className="grow" />
            <span className="muted">
              {g.items.reduce((n, f) => n + f.unread, 0)} 未读
            </span>
          </div>

          <ul className="feed-list">
            {g.items.map((f) => (
              <li key={f.id} className={`feed-row ${f.status} ${selected.has(f.id) ? 'picked' : ''}`}>
                {bulkMode && (
                  <button
                    className="bulk-check"
                    title={selected.has(f.id) ? '取消选择' : '选择'}
                    onClick={() => toggleSelect(f.id)}
                  >
                    <IconCheck size={16} checked={selected.has(f.id)} className={selected.has(f.id) ? 'checked' : ''} />
                  </button>
                )}
                <div className="feed-icon">
                  {/* 占位图标始终渲染在底下，favicon 叠在上面。
                      这样"正在加载"和"加载失败"两种情况都不会出现空方块 ——
                      只在 onError 时才换成占位图标的话，DNS 卡住的那几秒
                      依然是个空格子（实测就长这样）。 */}
                  <IconRss size={16} className="feed-icon-fallback" />
                  {f.iconUrl && !iconFailed.has(f.id) && (
                    <img
                      src={f.iconUrl} alt="" loading="lazy"
                      onError={() => setIconFailed((prev) => new Set(prev).add(f.id))}
                    />
                  )}
                </div>
                <div className="feed-main">
                  <div className="feed-title">
                    <span className="feed-title-text">{f.title ?? hostOf(f.url) ?? f.url}</span>
                    {f.status === 'broken' && <span className="tag bad">失效</span>}
                    {f.status === 'paused' && <span className="tag">已暂停</span>}
                  </div>
                  <div className="feed-meta">
                    <span>{f.total > 0 ? `共 ${f.total} 条` : '还没有条目'}</span>
                    {f.lastFetchedAt && (
                      <>
                        <span>·</span>
                        <span>{timeAgo(f.lastFetchedAt)}抓取</span>
                      </>
                    )}
                    {f.errorCount > 0 && f.status !== 'broken' && (
                      <>
                        <span>·</span>
                        <span className="warn">{f.errorCount} 次失败</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="feed-ops">
                  {f.unread > 0 && <span className="feed-unread">{f.unread}</span>}
                  <button className="icon-btn" title="编辑" onClick={() => startEdit(f)}>
                    <IconEdit size={15} />
                  </button>
                  <button className="icon-btn" title="立即刷新" onClick={() => void refreshOne(f.id)}>
                    <IconRefresh size={15} />
                  </button>
                  <button className="icon-btn" title={f.status === 'paused' ? '恢复抓取' : '暂停抓取'} onClick={() => void togglePause(f)}>
                    {f.status === 'paused' ? <IconPlay size={15} /> : <IconPause size={15} />}
                  </button>
                  {f.siteUrl && (
                    <a className="icon-btn" href={f.siteUrl} target="_blank" rel="noreferrer" title="访问网站">
                      <IconExternal size={15} />
                    </a>
                  )}
                  <button className="icon-btn danger" title="取消订阅" onClick={() => void remove(f)}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {feeds.length > 0 && visible.length === 0 && (
        <div className="empty">
          <div className="ph-art"><IconFolder size={26} /></div>
          <h2>这个分组里还没有订阅</h2>
          <p>从其它分组里编辑订阅、把它移到这里，或者直接添加新的源。</p>
          <div className="empty-actions">
            <button className="btn" onClick={() => setFilter(null)}>看全部订阅</button>
          </div>
        </div>
      )}

      {feeds.length > 0 && (
        <div className="feeds-foot">
          <button className="btn" onClick={() => void refreshAll()} disabled={busy}>
            刷新全部
          </button>
          <button className="btn" onClick={props.onOpenInbox}>去看条目</button>
        </div>
      )}

      {/* ── 编辑弹窗 ─────────────────────────────────────── */}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>编辑订阅</h2>
            <p className="hint modal-sub">{editing.feed.url}</p>

            <div className="field">
              <label htmlFor="ed-title">标题</label>
              <input
                id="ed-title" autoFocus
                value={editing.title}
                placeholder="留空则显示域名"
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); }}
              />
            </div>

            <div className="field">
              <label htmlFor="ed-folder">分组</label>
              <select
                id="ed-folder"
                value={editing.folderId}
                onChange={(e) => setEditing({ ...editing, folderId: e.target.value })}
              >
                <option value={UNFILED}>未分组</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              {folders.length === 0 && (
                <p className="hint" style={{ marginTop: 6 }}>
                  还没有分组，先在「分组」里建一个。
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="ed-int">抓取间隔（分钟）</label>
              <input
                id="ed-int" type="number" min={5} max={10080}
                value={editing.intervalMin}
                onChange={(e) => setEditing({ ...editing, intervalMin: Number(e.target.value) })}
              />
              <p className="hint" style={{ marginTop: 6 }}>
                最小 5 分钟，最大 7 天。频繁更新用 30，周更博客用 1440。
              </p>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)} disabled={busy}>取消</button>
              <button className="btn primary" onClick={() => void saveEdit()} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
