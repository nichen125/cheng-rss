import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure, type DiscoverCandidate, type FeedItem } from './api.ts';
import {
  IconChevronRight, IconExternal, IconPause, IconPlay, IconRefresh, IconRss,
  IconSearch, IconTrash,
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

export function FeedsPage(props: { onOpenInbox: () => void }) {
  const [feeds, setFeeds] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [candidates, setCandidates] = useState<DiscoverCandidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.listFeeds();
      setFeeds(r.items);
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
      // 抓取是异步的，1.5s 后再拉一次列表让用户看到变化
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

  return (
    <div className="feeds-page">
      <header className="feeds-head">
        <div>
          <h1>订阅</h1>
          <p className="muted">
            {feeds.length > 0
              ? `${feeds.length} 个源 · ${feeds.reduce((n, f) => n + f.unread, 0)} 条未读`
              : '还没有订阅任何源'}
          </p>
        </div>
        <div className="feeds-actions">
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
                    ? <img className="favicon" src={c.iconUrl} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
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

      {feeds.length > 0 && (
        <ul className="feed-list">
          {feeds.map((f) => (
            <li key={f.id} className={`feed-row ${f.status}`}>
              <div className="feed-icon">
                {f.iconUrl
                  ? <img src={f.iconUrl} alt="" loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  : <IconRss size={16} />}
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
      )}

      {feeds.length > 0 && (
        <div className="feeds-foot">
          <button className="btn" onClick={() => void refreshAll()} disabled={busy}>
            刷新全部
          </button>
          <button className="btn" onClick={props.onOpenInbox}>去看条目</button>
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
