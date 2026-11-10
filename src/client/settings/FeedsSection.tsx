// 配置中心的「订阅」分类（PLAN §15.15）。
//
// 从原来的 FeedsPage 整体迁入，改动只有三处：
//   ① 数据（feeds/folders/filter/err/notice）来自 FeedsProvider，
//      不再自己 load —— 因为「分组」分类页要能改动同一批数据。
//   ② 分组筛选从一排会换行的 chip 改成下拉栏（分组 ≥3 时），
//      分组很少时仍是 chip（§15.15 的 threshold 规则）。
//   ③ 新增订阅时可以顺手选分组 —— 原来必须先订、再去行里编辑。
//
// 一个输入框解决 90% 的用法：贴什么都能订阅。
//   · 完整 feed URL      → 直接用
//   · 网站首页           → 自动发现 <link rel=alternate>
//   · 裸域名（x.com）    → 补 https:// 再发现
//   · 一段带 URL 的文字  → 抠出第一个 URL
//
// "发现到多个 feed" 时让用户选，而不是替他挑 —— 主站和评论区分开的站点不少。
import { useRef, useState } from 'react';
import { api, ApiFailure, type DiscoverCandidate, type FeedItem } from '../api.ts';
import {
  IconCheck, IconChevronRight, IconEdit, IconExternal, IconFolder, IconPause, IconPlay,
  IconRefresh, IconRss, IconSearch, IconTrash,
} from '../icons.tsx';
import { useConfirm } from '../components/ConfirmDialog.tsx';
import { FOLDER_DROPDOWN_THRESHOLD, UNFILED, useFeeds } from './store.tsx';
import { RsshubSearch } from './RsshubSearch.tsx';

interface EditState {
  feed: FeedItem;
  title: string;
  folderId: string;
  intervalMin: number;
}

export function FeedsSection(props: { onClose: () => void }) {
  const {
    feeds, folders, loading, err, notice, busy, filter,
    setFilter, setErr, setNotice, setBusy, reload, fail,
    visible, grouped, unfiledCount, totalUnread, brokenCount,
  } = useFeeds();

  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  /** 添加时顺手选的归属分组；UNFILED = 未分组，空串表示跟随当前筛选 */
  const [addFolder, setAddFolder] = useState('');
  const [candidates, setCandidates] = useState<DiscoverCandidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [editing, setEditing] = useState<EditState | null>(null);
  const confirm = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 加载失败的图标 id，回退成占位图标而不是留空方块 */
  const [iconFailed, setIconFailed] = useState<Set<string>>(new Set());
  /** 批量管理模式。进入后每行左侧出勾选框，顶部出批量操作栏 */
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const resetAdd = () => {
    setAdding(false);
    setInput('');
    setAddFolder('');
    setCandidates(null);
    setNotes([]);
  };

  /** 添加面板打开时的默认归属：跟随当前筛选，避免"在 A 组里加源却落到未分组" */
  const openAdd = () => {
    setAdding(true);
    setAddFolder(filter === null || filter === UNFILED ? (filter ?? '') : filter);
    setTimeout(() => inputRef.current?.focus(), 50);
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
      fail(e, '发现失败');
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async (url: string) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.addFeed(url, addFolder === '' || addFolder === UNFILED ? null : addFolder);
      setNotice(
        r.created
          ? `已订阅「${r.feed.title ?? url}」，导入 ${r.imported ?? 0} 条`
          : '这个源已经在订阅列表里了',
      );
      setCandidates(null);
      setInput('');
      setAdding(false);
      await reload();
    } catch (e) {
      fail(e, '订阅失败');
    } finally {
      setBusy(false);
    }
  };

  const refreshOne = async (id: string) => {
    try {
      await api.refreshFeed(id);
      setNotice('已加入抓取队列，稍后刷新');
      setTimeout(() => void reload(), 1500);
    } catch (e) {
      fail(e, '刷新失败');
    }
  };

  const refreshAll = async () => {
    setBusy(true);
    try {
      const r = await api.refreshAllFeeds();
      setNotice(`已把 ${r.queued} 个源加入抓取队列`);
      setTimeout(() => void reload(), 2000);
    } catch (e) {
      fail(e, '刷新失败');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 复活所有「失效」源（§15.23，v1.17）。
   *
   * 为什么要一个按钮而不是自动做：broken 是终态，sweep 只挑 active，
   * 所以判据修好之后已经坏掉的那批不会自己回来 —— 但反过来"每小时
   * 自动复活一次"对真的死掉的源只是往日志里添一排失败。让用户按一次，
   * 比让服务自己猜要诚实。
   */
  const retryBroken = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.retryBrokenFeeds();
      setNotice(
        r.revived === 0
          ? '没有标记为失效的源'
          : `已恢复 ${r.revived} 个源并加入抓取队列，稍后看结果`,
      );
      await reload();
    } catch (e) {
      fail(e, '重试失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: FeedItem) => {
    const yes = await confirm({
      title: `取消订阅「${f.title ?? f.url}」？`,
      message: `未读的 ${f.unread} 条会一起删除；已读和已收藏的条目会保留在列表里。`,
      confirmText: '取消订阅',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.deleteFeed(f.id);
      setNotice('已取消订阅');
      await reload();
    } catch (e) {
      fail(e, '删除失败');
    }
  };

  const togglePause = async (f: FeedItem) => {
    try {
      await api.updateFeed(f.id, { status: f.status === 'paused' ? 'active' : 'paused' });
      await reload();
    } catch (e) {
      fail(e, '操作失败');
    }
  };

  const exportOpml = async () => {
    try {
      const xml = await api.exportOpml();
      const blob = new Blob([xml], { type: 'text/x-opml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cheng-rss-feeds-${new Date().toISOString().slice(0, 10)}.opml`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      fail(e, '导出失败');
    }
  };

  const importOpml = async (file: File) => {
    setBusy(true);
    setErr('');
    try {
      const text = await file.text();
      const r = await api.importOpml(text);
      setNotice(`导入 ${r.created} 个订阅${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`);
      await reload();
    } catch (e) {
      fail(e, '导入失败');
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
      await reload();
    } catch (e) {
      fail(e, '保存失败');
    } finally {
      setBusy(false);
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
      await reload();
    } catch (e) {
      fail(e, `${label}失败`);
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
    const yes = await confirm({
      title: `取消订阅这 ${ids.length} 个源？`,
      message: `未读的 ${unread} 条会一起删除；已读和已收藏的条目会保留。\n`
        + `这个操作不能撤销。`,
      confirmText: '取消订阅',
      danger: true,
    });
    if (!yes) return;
    await runBulk('取消订阅', (x) => api.bulkDelete(x));
  };

  // 分组少时 chip 够用（一次点击直达），多了才换下拉 —— 见 §15.15
  const useDropdown = folders.length >= FOLDER_DROPDOWN_THRESHOLD;

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
          {/* 复活失效源（§15.23，v1.17）。只在确实有失效源时出现 ——
              没有坏源时它就是一个永远按不出效果的按钮。 */}
          {brokenCount > 0 && (
            <button
              className="btn"
              onClick={() => void retryBroken()}
              disabled={busy}
              title={`把 ${brokenCount} 个标记为「失效」的源改回正常并立刻重抓一次`}
            >
              重试失效源 · {brokenCount}
            </button>
          )}
          <button
            className={`btn ${bulkMode ? 'active' : ''}`}
            onClick={() => (bulkMode ? exitBulk() : enterBulk())}
            disabled={feeds.length === 0}
          >
            {bulkMode ? '退出管理' : '管理'}
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
          <button className="btn primary" onClick={openAdd}>
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

      {/* ── 分组筛选（§15.15：≥3 个分组换下拉，否则 chip）──── */}
      {feeds.length > 0 && (folders.length > 0 || filter !== null) && (
        useDropdown ? (
          <div className="folder-filter select-mode">
            <label className="folder-label" htmlFor="folder-filter-select">分组</label>
            <select
              id="folder-filter-select"
              className="folder-select"
              value={filter ?? ''}
              onChange={(e) => setFilter(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">全部（{feeds.length} 个源）</option>
              {unfiledCount > 0 && <option value={UNFILED}>未分组（{unfiledCount} 个源）</option>}
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}（{f.feedCount} 个源）</option>
              ))}
            </select>
            <span className="muted">
              共 {visible.length} 个源
            </span>
          </div>
        ) : (
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
        )
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
            {/* 添加时就选分组：原来必须先订、再回行里编辑，两步才能归组 */}
            <select
              className="add-folder"
              value={addFolder}
              disabled={busy}
              onChange={(e) => setAddFolder(e.target.value)}
              title="新订阅放进哪个分组"
            >
              <option value="">不分组</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <button className="btn primary" onClick={() => void discover()} disabled={busy || !input.trim()}>
              {busy ? '查找中…' : '查找并订阅'}
            </button>
            <button className="btn" onClick={resetAdd} disabled={busy}>取消</button>
          </div>
          <p className="hint">
            直接贴网站首页也可以 —— 会自动从页面里找订阅地址。
          </p>

          {/* RSSHub 搜索（§10）：没有原生 feed 的站点走这条路。
              它嵌在「添加订阅」面板里而不是单开入口 —— 用户的目标始终是
              "把这个网站订上"，RSSHub 只是手段。 */}
          <RsshubSearch onSubscribe={subscribe} disabled={busy} />

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
            <button className="btn primary" onClick={openAdd}>添加订阅</button>
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
                    <span className="feed-total">{f.total > 0 ? `共 ${f.total} 条` : '还没有条目'}</span>
                    {f.lastFetchedAt && (
                      <>
                        <span>·</span>
                        <span className="feed-when">{timeAgo(f.lastFetchedAt)}抓取</span>
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
          {/* 「去看条目」只关弹窗，**不碰 scope**（§15.13 的自愈回程就靠这条）：
              如果这里顺手把分组/源筛选也清了，源被移出组之后
              "自动退回整组"那段逻辑一次都不会执行，验收会假绿。 */}
          <button className="btn" onClick={props.onClose}>去看条目</button>
        </div>
      )}

      {/* ── 编辑弹窗 ─────────────────────────────────────── */}
      {editing && (
        <div className="modal-backdrop modal-inset" onClick={() => setEditing(null)}>
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
                  还没有分组，先去左边的「分组」里建一个。
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
