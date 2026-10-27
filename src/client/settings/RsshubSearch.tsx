// RSSHub 订阅搜索面板（PLAN §10）。
//
// 为什么嵌在「添加订阅」里而不是单开一个入口：用户的目标始终是
// "把这个网站订上"，RSSHub 只是"这个网站没有原生 feed 时的办法"。
// 单开一个"RSSHub 搜索"菜单项会让人以为这是两个功能、要走两条路。
//
// 交互只做三段，对应 §10.3 的三条路径：
//   ① 一个输入框：贴 URL 就反查，输关键词就搜路由
//   ② 选中候选：路径里的 `:param` 自动变成输入框
//   ③ 预览：真的抓一次，看到条目才允许订阅
//
// 第 ③ 步不能省。不预览就订阅，等于把一个可能是死链的地址存进库里，
// 之后它在订阅列表中永远 broken —— 而用户完全不知道为什么。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiFailure, type RsshubPreviewResponse, type RsshubRoute } from '../api.ts';
import {
  IconCheck, IconChevronRight, IconExternal, IconRefresh, IconSearch, IconSparkle,
} from '../icons.tsx';

interface Props {
  /** 确认订阅时把完整地址交回上层（走与"贴地址订阅"完全相同的路径） */
  onSubscribe: (url: string) => Promise<void> | void;
  disabled?: boolean;
}

/** 把 `:name` 占位替换成已填的值；`?` 后缀的可选参数留空时整段删掉 */
function buildPath(template: string, values: Record<string, string>): string {
  let out = template.replace(/\/:([A-Za-z0-9_]+)\?/g, (_a, n: string) => {
    const v = values[n];
    return v ? `/${encodeURIComponent(v)}` : '';
  });
  out = out.replace(/:([A-Za-z0-9_]+)/g, (_a, n: string) => {
    const v = values[n];
    return v ? encodeURIComponent(v) : `:${n}`;
  });
  return out;
}

export function RsshubSearch({ onSubscribe, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [items, setItems] = useState<RsshubRoute[] | null>(null);
  const [type, setType] = useState<'url' | 'keyword'>('keyword');
  const [stale, setStale] = useState(false);
  const [libSize, setLibSize] = useState<{ routes: number; radar: number } | null>(null);

  /** 选中的路由 + 参数表 */
  const [picked, setPicked] = useState<RsshubRoute | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<RsshubPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const runSearch = useCallback(async (text: string) => {
    const key = text.trim();
    if (!key) { setItems(null); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await api.searchRsshub(key);
      setItems(r.items);
      setType(r.type);
      setStale(r.stale);
      setLibSize(r.library);
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '搜索失败');
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, []);

  // 边打边搜（240ms 防抖，与主搜索框一致）。RSSHub 搜索是纯本地计算，
  // 每次按键都发也不会打上游 —— 上游只在「刷新路由库」时才访问。
  const onChange = (v: string) => {
    setQ(v);
    setPicked(null);
    setPreview(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(v), 240);
  };

  const pick = (r: RsshubRoute) => {
    setPicked(r);
    setPreview(null);
    // 示例地址里已经给出真实参数值时预填，用户只改需要改的
    const init: Record<string, string> = {};
    if (r.example) {
      const exParts = r.example.split('/').filter(Boolean);
      const tplParts = r.path.split('/').filter(Boolean);
      for (let i = 0; i < tplParts.length; i++) {
        const t = tplParts[i] ?? '';
        if (t.startsWith(':')) {
          const name = t.replace(/^:/, '').replace(/\?$/, '');
          const v = exParts[i];
          if (v && !v.startsWith(':')) init[name] = decodeURIComponent(v);
        }
      }
    }
    setParams(init);
  };

  const doPreview = async () => {
    if (!picked) return;
    setPreviewing(true);
    setErr('');
    try {
      const path = buildPath(picked.path, params);
      const r = await api.previewRsshub(path, params);
      setPreview(r);
      if (!r.ok) setErr(r.error ?? '这个地址没有内容');
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '预览失败');
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const doRefresh = async () => {
    setBusy(true);
    setRefreshMsg('');
    setErr('');
    try {
      const r = await api.refreshRsshub();
      setRefreshMsg(r.ok
        ? `已更新：${r.routes} 条路由 / ${r.radar} 条域名规则（${r.ms}ms）`
        : `更新失败：${r.errors.join('；')}（继续用缓存）`);
      if (r.ok) {
        setLibSize({ routes: r.routes, radar: r.radar });
        setStale(false);
        if (q.trim()) await runSearch(q);
      }
    } catch (e) {
      setRefreshMsg(e instanceof ApiFailure ? `更新失败：${e.message}` : '更新失败');
    } finally {
      setBusy(false);
    }
  };

  const missing = useMemo(() => {
    if (!picked) return [];
    return picked.params.filter((p) => !params[p]);
  }, [picked, params]);

  const subscribedUrl = preview?.ok ? preview.url : null;

  if (!open) {
    return (
      <button
        className="btn rsshub-open"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="用 RSSHub 搜站点（没有原生 RSS 的网站也能订）"
      >
        <IconSparkle size={14} /> 用 RSSHub 搜
      </button>
    );
  }

  return (
    <div className="rsshub-panel">
      <div className="rsshub-head">
        <IconSparkle size={14} />
        <span>RSSHub 订阅搜索</span>
        <span className="grow" />
        {libSize && (
          <span className="rsshub-lib" title="本地缓存的路由数量">
            {libSize.routes} 路由 · {libSize.radar} 域名
          </span>
        )}
        <button
          className="icon-btn tiny"
          onClick={() => void doRefresh()}
          disabled={busy}
          title="刷新路由库（缓存 7 天）"
          aria-label="刷新路由库"
        >
          <IconRefresh size={13} />
        </button>
        <button className="btn tiny" onClick={() => { setOpen(false); setPicked(null); setPreview(null); }}>
          收起
        </button>
      </div>

      {stale && (
        <p className="hint warn">
          路由库缓存已超过 7 天，点右上角刷新可以拿到最新路由（不刷新也能搜）。
        </p>
      )}
      {refreshMsg && <p className="hint">{refreshMsg}</p>}
      {err && <div className="alert error">{err}</div>}

      <div className="search-box grow rsshub-search">
        <IconSearch size={15} className="search-icon" />
        <input
          ref={inputRef}
          placeholder="输关键词（如 少数派 / bilibili），或直接贴网站地址"
          value={q}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>

      {items !== null && items.length === 0 && !busy && (
        <p className="hint">
          没找到对应的路由。换个词试试，或确认这个站点在 RSSHub 里有支持
          （公共实例的路由不一定全）。
        </p>
      )}

      {items && items.length > 0 && (
        <div className="rsshub-results">
          <div className="candidates-title">
            {type === 'url' ? '按网站地址反查到 ' : '找到 '}
            {items.length} 条路由
          </div>
          {items.slice(0, 30).map((r) => (
            <button
              key={`${r.path}-${r.viaDomain ?? ''}`}
              className={`candidate ${picked?.path === r.path ? 'active' : ''}`}
              onClick={() => pick(r)}
              disabled={disabled}
            >
              <IconChevronRight size={14} />
              <div className="candidate-main">
                <div className="candidate-title">
                  {r.title}
                  <span className="rsshub-ns">{r.namespace}</span>
                </div>
                <div className="candidate-url">{r.path}</div>
                {r.description && <div className="candidate-desc">{r.description}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      {picked && (
        <div className="rsshub-form">
          <div className="rsshub-form-title">
            {picked.title}
            <code>{picked.path}</code>
          </div>

          {picked.params.length === 0 ? (
            <p className="hint">这条路由不需要参数。</p>
          ) : (
            <div className="rsshub-params">
              {picked.params.map((name) => {
                const doc = picked.paramDocs.find((d) => d.name === name)?.description ?? '';
                return (
                  <label className="field" key={name}>
                    <span>
                      {name}
                      {doc && <em className="param-doc">{doc}</em>}
                    </span>
                    <input
                      value={params[name] ?? ''}
                      placeholder={doc || `填写 ${name}`}
                      disabled={previewing}
                      onChange={(e) => {
                        setParams((p) => ({ ...p, [name]: e.target.value }));
                        setPreview(null);
                      }}
                    />
                  </label>
                );
              })}
            </div>
          )}

          <div className="rsshub-actions">
            <button
              className="btn"
              onClick={() => void doPreview()}
              disabled={previewing || missing.length > 0 || Boolean(disabled)}
            >
              {previewing ? '抓取中…' : '预览最近几条'}
            </button>
            {missing.length > 0 && (
              <span className="hint">还需要填：{missing.join('、')}</span>
            )}
            {subscribedUrl && (
              <button
                className="btn primary"
                onClick={() => void onSubscribe(subscribedUrl)}
                disabled={Boolean(disabled)}
              >
                <IconCheck size={14} /> 订阅这个地址
              </button>
            )}
            {subscribedUrl && (
              <a
                className="btn"
                href={subscribedUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="在新标签打开这个 feed 看看"
              >
                <IconExternal size={13} /> 打开
              </a>
            )}
          </div>

          {preview && preview.ok && (
            <div className="rsshub-preview">
              <div className="candidates-title">
                预览：{preview.title ?? '（无标题）'} · 前 {preview.items.length} 条
              </div>
              <ul>
                {preview.items.map((it, i) => (
                  <li key={`${it.link ?? i}`}>
                    {it.link
                      ? <a href={it.link} target="_blank" rel="noopener noreferrer">{it.title}</a>
                      : it.title}
                  </li>
                ))}
              </ul>
              <div className="candidate-url">{preview.url}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
