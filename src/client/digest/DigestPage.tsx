import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DigestSummary, type DigestCluster, type DigestDetail } from '../api.ts';
import { parseMarkdown, renderInline, type CiteInfo } from './markdown.tsx';

// 简报页（PLAN §15.4 / 3.5）。三栏里复用一个"列表 + 阅读区"的形状：
// 左栏是日期列表，右栏是简报正文 —— 与收件箱同一套肌肉记忆，
// 不因为换了个功能就要重新学怎么用。
//
// 三个刻意的取舍：
//   · **日期列表分页用 cursor 而不是"最近 N 份"**：简报是长期资产，
//     用户可能翻三个月前的。一次性拉 20 份再加"加载更多"就够，
//     不需要虚拟滚动。
//   · **脚注点开是浮层卡片，不是跳转**：用户读正文到一半点 [2]，
//     他要知道"第 2 条是哪件事"，而不是离开正文。跳走会丢失阅读位置。
//   · **冲突的视觉克制**（§15.4）：左侧细色条 + 小字，不用红色感叹号。
//     冲突是常态，不是警报。

export interface DigestPageProps {
  /** 侧栏是否收窄（复用阅读区的三栏布局） */
  narrow: boolean;
}

export function DigestPage(props: DigestPageProps) {
  const [items, setItems] = useState<DigestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DigestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [status, setStatus] = useState<{
    enabled: boolean; at: string; state: string; skipReason: string | null;
    nextAt: number | null; attempts: number; lastError: string | null;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [list, st] = await Promise.all([api.listDigests(30), api.digestStatus()]);
      setItems(list.items);
      setStatus(st);
      // 默认打开最新一份：进简报页的目的几乎总是"看今天这份"
      if (list.items.length > 0 && openId === null) setOpenId(list.items[0]!.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [openId]);

  useEffect(() => { void load(); }, []);   // 只在挂载时拉一次

  const open = useCallback(async (id: string) => {
    setOpenId(id);
    setDetailLoading(true);
    setActiveCite(null);
    try {
      setDetail(await api.getDigest(id));
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (openId) void open(openId);
  }, [openId, open]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenMsg('');
    try {
      const r = await api.runDigest();
      if (r.ok && r.digestId) {
        setGenMsg('已生成');
        await load();
        await open(r.digestId);
      } else {
        // "没有内容"不是错误 —— 用说明文字而不是红框
        setGenMsg(r.reason ?? '没有可以生成的内容');
      }
    } catch (e) {
      setGenMsg(e instanceof Error ? e.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  }, [load, open]);

  const byIndex = useMemo(() => {
    const m = new Map<number, CiteInfo>();
    for (const c of detail?.clusters ?? []) m.set(c.index, { index: c.index, title: c.title });
    return m;
  }, [detail]);

  // 脚注浮层必须能关掉。
  //
  // 它是 sticky 的，会盖住正文底部一块 —— 不给关闭路径的话用户只能点
  // 另一个 [n]，或者滚到看不见它为止，那等于"读正文时永久挡一条"。
  // 三个关闭途径：右上角 ×、点浮层外面、Esc。
  useEffect(() => {
    if (activeCite === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setActiveCite(null); }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.digest-cite-card')) return;
      // 点脚注本身不算"外面" —— 那是在切换目标，由它自己的 onClick 处理
      if (t?.closest('.digest-cite')) return;
      setActiveCite(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [activeCite]);

  const blocks = useMemo(() => parseMarkdown(detail?.bodyMd ?? ''), [detail?.bodyMd]);
  const cite = activeCite === null ? null : (detail?.clusters ?? []).find((c) => c.index === activeCite);

  return (
    <div className="digest-page">
      {/* ── 左：日期列表 ─────────────────────────────────── */}
      <section className="digest-list">
        <header className="pane-head">
          <div className="pane-title">
            <h1>简报</h1>
            {items.length > 0 && <span className="pane-count">{items.length}</span>}
          </div>
          <button
            className="btn sm"
            disabled={generating}
            onClick={() => void generate()}
            title="立刻生成今天的简报（跳过定时）"
          >
            {generating ? '生成中…' : '现在生成'}
          </button>
        </header>

        {genMsg && <div className="digest-gen-msg">{genMsg}</div>}

        {/* 今日状态条：没有简报时必须说清"为什么没有、什么时候会有"。
            只给一个空列表的话用户不知道是在等还是坏了。 */}
        {status && items.length === 0 && !loading && (
          <div className="digest-empty">
            <h2>还没有简报</h2>
            <p>
              {status.state === 'skipped' && status.skipReason
                ? `今天没有生成：${status.skipReason}`
                : status.enabled
                  ? `每天 ${status.at} 自动生成。也可以点上面的「现在生成」。`
                  : '简报目前是关闭的。可以在配置里打开，或点上面「现在生成」。'}
            </p>
            {status.lastError && <p className="muted">上次失败：{status.lastError}</p>}
          </div>
        )}

        {loading && items.length === 0 && <div className="empty"><span className="spinner" /></div>}
        {err && <div className="alert error inset">{err}</div>}

        <ul className="digest-date-list">
          {items.map((d) => (
            <li key={d.id}>
              <button
                className={`digest-date-item${openId === d.id ? ' active' : ''}`}
                onClick={() => void open(d.id)}
              >
                <span className="digest-date">{fmtDay(d.dayKey ?? d.periodStart)}</span>
                <span className="digest-date-title">{d.title}</span>
                <span className="digest-date-meta">
                  {d.clusterCount} 个事件 · {d.entryCount} 篇
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 右：正文 ─────────────────────────────────────── */}
      <section className="digest-reader">
        {!openId && (
          <div className="reader-placeholder">
            {items.length === 0 ? (
              <>
                {/* 没有任何简报时，左栏根本没有日期可选，"左栏选日期"
                    是把用户指向一个不存在的东西。这里直接讲下一步动作。 */}
                <h2>还没有可读的简报</h2>
                <p>点左上角「现在生成」，或在配置里确认自动生成时间。</p>
              </>
            ) : (
              <>
                <h2>选一份简报</h2>
                <p>左栏选日期。</p>
              </>
            )}
          </div>
        )}
        {openId && detailLoading && <div className="reader-loading"><span className="spinner" /></div>}
        {openId && !detailLoading && !detail && (
          <div className="alert info">这份简报读不出来（可能已被删除）。</div>
        )}
        {detail && !detailLoading && (
          <article className="digest-doc">
            <h1 className="digest-title">{detail.title}</h1>
            <div className="digest-period">
              {fmtRange(detail.periodStart, detail.periodEnd)} · {detail.entryCount} 篇 ·{' '}
              {detail.clusterCount} 个事件
            </div>

            {/* 今日要点：3 条粗体各一行 */}
            {detail.intro.length > 0 && (
              <ul className="digest-points">
                {detail.intro.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}

            <div className="digest-body">
              {blocks.map((b, i) => {
                if (b.kind === 'hr') return <hr key={i} />;
                if (b.kind === 'h2') return <h2 key={i}>{b.text}</h2>;
                if (b.kind === 'h3') return <h3 key={i}>{b.text}</h3>;
                if (b.kind === 'ul') {
                  return (
                    <ul key={i}>
                      {b.items.map((it, j) => (
                        <li key={j}>
                          {renderInline(it, byIndex, (n) => setActiveCite(activeCite === n ? null : n), activeCite)}
                        </li>
                      ))}
                    </ul>
                  );
                }
                return (
                  <p key={i}>
                    {renderInline(b.text, byIndex, (n) => setActiveCite(activeCite === n ? null : n), activeCite)}
                  </p>
                );
              })}
            </div>

            {/* 事件卡片：每个引用事件一条，含一致/分歧 */}
            {(detail.clusters ?? []).length > 0 && (
              <section className="digest-clusters">
                <h2 className="digest-section-head">
                  今日事件
                  <span className="digest-section-count">{detail.clusters.length}</span>
                </h2>
                {(detail.clusters ?? []).map((c) => (
                  <div className="digest-cluster" key={c.id} data-missing={c.missing ? '1' : '0'}>
                    {/* 序号独立成一列：它与正文里的 [n] 是同一条竖线，
                        点正文脚注时眼睛能直接落回这里 */}
                    <span className="digest-cluster-index">[{c.index}]</span>
                    <div className="digest-cluster-body">
                      <h3 className="digest-cluster-title">{c.title}</h3>
                      <div className="digest-cluster-meta">
                        {c.entry_count ?? '?'} 篇 · {c.source_count ?? '?'} 个来源
                      </div>
                      {c.summary && <p className="digest-cluster-summary">{c.summary}</p>}
                      {c.consensus.length > 0 && (
                        <div className="digest-consensus">
                          <span className="digest-tag">一致</span>
                          {c.consensus.join('；')}
                        </div>
                      )}
                      {c.conflicts.map((cf, i) => (
                        <div className="digest-conflict" key={i}>
                          <span className="digest-tag">分歧</span>
                          {cf.claim}
                          {cf.sources.length > 0 && (
                            <span className="digest-conflict-src">（{cf.sources.join(' vs ')}）</span>
                          )}
                        </div>
                      ))}
                      {c.missing && (
                        <div className="digest-cluster-gone">
                          这件事的详细数据已被清理（简报保留当时的引用）
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* 值得一读 */}
            {(detail.worthReading ?? []).length > 0 && (
              <section className="digest-wr-section">
                <h2 className="digest-section-head">值得一读</h2>
                <ul className="digest-wr">
                  {(detail.worthReading ?? []).map((w) => {
                    // 这件事如果也在正文引用里，就给一个与正文同款的 [n] ——
                    // 用户读完正文想回头找它时，不用滚回去数脚注。
                    const same = (detail.clusters ?? []).find((c) => c.id === w.id);
                    return (
                      <li key={w.id}>
                        <span className="digest-wr-title">{w.title}</span>
                        {same && (
                          <button
                            className={`digest-cite${activeCite === same.index ? ' active' : ''}`}
                            onClick={() => setActiveCite(activeCite === same.index ? null : same.index)}
                            title="看这件事的细节"
                          >
                            {same.index}
                          </button>
                        )}
                        <span className="digest-wr-meta">
                          {w.entryCount !== null ? `${w.entryCount} 篇` : ''}
                          {w.heat !== null && w.heat !== undefined ? ` · 热度 ${w.heat}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="digest-foot">
              {detail.model && <span className="muted">模型 {detail.model}</span>}
              {detail.costUsd !== null && detail.costUsd !== undefined && (
                <span className="muted"> · 成本 ${Number(detail.costUsd).toFixed(4)}</span>
              )}
              <span className="spacer" />
              <button className="btn sm" onClick={() => void generate()} disabled={generating}>
                {generating ? '生成中…' : '重新生成今天这份'}
              </button>
            </div>

            {/* 脚注浮层：点 [n] 就地展开，不离开正文 */}
            {cite && (
              <div className="digest-cite-card">
                <div className="digest-cite-card-head">
                  <span className="digest-cite-card-idx">[{cite.index}]</span>
                  <strong>{cite.title}</strong>
                  <button className="icon-btn" onClick={() => setActiveCite(null)} title="关闭">×</button>
                </div>
                {cite.summary && <p>{cite.summary}</p>}
                <div className="digest-cite-card-meta">
                  共 {cite.entry_count ?? '?'} 篇报道，来自 {cite.source_count ?? '?'} 个来源
                  {cite.heat !== null && cite.heat !== undefined
                    ? ` · 热度 ${cite.heat}` : ''}
                </div>
                {cite.conflicts.length > 0 && (
                  <div className="digest-cite-card-conflict">
                    {cite.conflicts.length} 处说法不一致
                  </div>
                )}
              </div>
            )}
          </article>
        )}
      </section>
    </div>
  );
}

/** 2026-10-29 */
function fmtDay(ms: number | null): string {
  if (!ms) return '未知日期';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtRange(a: number | null, b: number | null): string {
  const hh = (ms: number | null) => {
    if (!ms) return '--:--';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${fmtDay(a)} ${hh(a)} — ${hh(b)}`;
}

/** 让 DigestCluster 的类型在本文件可见（避免与后端同名类型混淆） */
export type { DigestCluster };
