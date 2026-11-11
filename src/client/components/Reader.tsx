import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type EntryDetail } from '../api.ts';
import {
  IconArrowLeft, IconCheck, IconCircle, IconExternal, IconMenu, IconRss, IconSparkle, IconStar,
} from '../icons.tsx';
import { SummaryMarkdown, sumFailHint } from '../summary/SummaryMarkdown.tsx';
import { useHighlights } from '../highlights/useHighlights.ts';
import { HighlightList, HighlightToolbar } from '../highlights/HighlightUI.tsx';
import type { ReaderPrefs } from '../reader-prefs.ts';
import { tierLabel } from '../lib/format.ts';
import { PrefsPanel } from './PrefsPanel.tsx';

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

export function Reader(props: {
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

  // ── 单篇总结（§15.27，v2.0）───────────────────────────────
  //
  // 三种状态收敛成一个：'idle'（没总结过）/'busy'（生成中）/'done'。
  // 不用两个布尔（loading + hasSummary）：那会有"两个都 true"的非法组合，
  // 而它对应的界面是"骨架条下面同时有内容"，看着像渲染 bug。
  const [sum, setSum] = useState<{
    state: 'idle' | 'busy' | 'done';
    text: string | null;
    createdAt: number | null;
    fail: { kind: string; message: string } | null;
  }>({ state: 'idle', text: null, createdAt: null, fail: null });

  // 打开另一篇时重置并预取缓存 —— 不预取的话按钮永远写「总结」，
  // 而库里可能早有一份，用户再点一次会命中缓存却看不出"它本来就在"。
  useEffect(() => {
    const id = detail?.id;
    if (!id) { setSum({ state: 'idle', text: null, createdAt: null, fail: null }); return; }
    let alive = true;
    setSum({ state: 'idle', text: null, createdAt: null, fail: null });
    api.getEntrySummary(id)
      .then((r) => {
        if (!alive || !r.summary) return;
        setSum({ state: 'done', text: r.summary, createdAt: r.createdAt, fail: null });
      })
      .catch(() => { /* 读缓存失败不该阻断阅读 */ });
    return () => { alive = false; };
  }, [detail?.id]);

  /** 点「总结」：有缓存直接展开，没有就现生成；`force` 时强制重算 */
  const makeSummary = useCallback(async (force: boolean) => {
    const id = detail?.id;
    if (!id) return;
    setSum((s) => ({ ...s, state: 'busy', fail: null }));
    try {
      const r = await api.makeEntrySummary(id, { force });
      if (!r.ok || !r.summary) {
        setSum({
          state: 'idle', text: null, createdAt: null,
          fail: r.failure ? { kind: r.failure.kind, message: r.failure.message } : null,
        });
        return;
      }
      setSum({ state: 'done', text: r.summary, createdAt: Date.now(), fail: null });
    } catch (e) {
      setSum({
        state: 'idle', text: null, createdAt: null,
        fail: { kind: 'request', message: e instanceof Error ? e.message : '生成失败' },
      });
    }
  }, [detail?.id]);

  // ── 侧边目录（§15.18）─────────────────────────────────────
  /** 正文里的小标题。从 DOM 读，不在服务端另解析一份 */
  const [toc, setToc] = useState<TocItem[]>([]);
  /** 面板右侧空白够不够放目录。不够就整个不渲染 */
  const [tocFits, setTocFits] = useState(false);
  /** 当前所在的小节 id —— 滚动时更新，目录里对应项高亮 */
  const [tocActive, setTocActive] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 划词高亮（§11.3）。rootRef 复用 bodyRef —— 阅读区已经有一个正文容器的
  // ref，再挂一个只会让两处各自失效时互相不知道。
  const hl = useHighlights(detail?.id ?? null, detail?.contentHtml ?? null, bodyRef);
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

        {/* AI 动作组（设计方案 §5.4）：摘要 / 总结 收成一组，放在顶部右侧。
            为什么收到这里：它们是"对这篇文章做点什么"，与返回、收藏、设置
            属于同一类动作 —— 都属于工具条，而非文章内容。
            之前总结按钮埋在纸面里、摘要折叠头埋在正文上方，两个 AI 动作
            分居两处，用户找不到"这类功能在哪"。 */}
        {a && (
          <div className="ai-group" role="group" aria-label="AI 功能">
            <button
              className={`ai-btn ${aiOpen ? 'on' : ''}`}
              onClick={() => setAiOpen((v) => !v)}
              aria-pressed={aiOpen}
              title={aiOpen ? '收起 AI 摘要' : '展开 AI 摘要'}
            >
              <IconSparkle size={13} />
              摘要
            </button>
            <button
              className={`ai-btn ${sum.state === 'done' ? 'on' : ''}`}
              onClick={() => void makeSummary(sum.state === 'done')}
              disabled={sum.state === 'busy'}
              title={sum.state === 'done' ? '按当前提示词重新生成' : '按当前提示词生成一份速读摘要'}
            >
              <IconSparkle size={13} />
              {sum.state === 'busy' ? '生成中' : sum.state === 'done' ? '重总结' : '总结'}
            </button>
          </div>
        )}

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
            <span className="time">{new Date(detail.publishedAt).toLocaleString('zh-CN', {
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit',
            })}</span>
            {a?.readingTime ? <span>约 {a.readingTime} 分钟</span> : null}
          </div>

          {a && aiOpen && (
            <div className="ai-card">
              <div className="ai-label">
                <span>AI 摘要</span>
                {a.tier && <span className={`tier tier-${a.tier}`}>{tierLabel(a.tier)}</span>}
              </div>
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
            </div>
          )}

          {/* 单篇总结（§15.27，v2.0）。
              触发按钮在顶部工具条的 AI 组里，这里只渲染结果 ——
              一个动作只有一个入口，按钮与内容分居两处会让人以为
              它们是两件事。

              放在正文之前：先看结论再决定读不读；放正文之后等于读完
              才看到，那时它已经没用了。 */}
          {(sum.state === 'busy' || sum.state === 'done' || sum.fail) && (
            <div className="sum-card" data-testid="summary-card" data-state={sum.state}>
              <div className="ai-label">
                <span>总结</span>
                {sum.state === 'done' && sum.createdAt && (
                  <span className="ai-label-time">
                    {new Date(sum.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                )}
              </div>

              {sum.state === 'busy' && (
                <div className="sum-skeleton" aria-live="polite" aria-label="正在生成总结">
                  <span /><span /><span />
                </div>
              )}

              {sum.state === 'done' && sum.text && (
                <div className="sum-body">
                  {/* 复用简报页的 Markdown 渲染器（§8.9）：它产出 React 节点、
                      不用 dangerouslySetInnerHTML，所以模型输出不经过 HTML 解析。 */}
                  <SummaryMarkdown md={sum.text} />
                </div>
              )}

              {sum.fail && (
                <div className="sum-fail" role="alert">
                  {sumFailHint(sum.fail.kind)}
                  <div className="sum-fail-hint">{sum.fail.message}</div>
                </div>
              )}
            </div>
          )}

          {/* 正文 + 划词工具条（§11.3）。
              **工具条必须和正文同一个定位父级**：`useHighlights` 算的
              x/y 是「相对 `.article-body` 左上角」，而工具条原先直接挂在
              `.reader` 下 —— 那个元素才有 `position: relative`，于是
              绝对定位按它解，坐标里「纸顶到正文顶」那段距离（标题 + meta
              + AI 摘要卡 + 总结卡）被重复算了一次，工具条浮到纸的顶部。
              这毛病一直都在，只是 M4 时期那段距离只有约 72px，落在
              m4-03 的 ±120px 容差里；v2.0 加了总结卡之后涨到 179px，
              容差被顶破才暴露。
              修法是把两者放进同一个 `position: relative` 的包裹层，
              于是「计算时的参照系」与「定位时的参照系」是同一个盒子。
              包裹层不加 padding/margin，所以它的左上角与正文完全重合。 */}
          <div className="article-wrap">
            {detail.contentHtml ? (
              <div
                className="article-body"
                ref={bodyRef}
                // 划词结束（松手/抬键）时算选区。用声明式事件而不是
                // addEventListener：后者在某次渲染 ref 为 null 时会静默漏挂，
                // 表现是"划词没反应"且毫无报错（见 useHighlights 里的注释）。
                onMouseUp={hl.onSelectionEnd}
                onKeyUp={hl.onSelectionEnd}
                // 正文来自我们自己抓取并清洗的 HTML（sanitize.ts 白名单 + 链接新标签）
                dangerouslySetInnerHTML={{ __html: detail.contentHtml }}
              />
            ) : (
              <div className="alert info">
                这篇还没有正文缓存。
                <a href={detail.url} target="_blank" rel="noreferrer">去原文阅读 ↗</a>
              </div>
            )}

            {/* 划词工具条。坐标由选区算出，参照系就是外面这层 .article-wrap */}
            {hl.sel && (
              <HighlightToolbar
                x={hl.sel.x}
                y={hl.sel.y}
                onPick={(c) => void hl.create(c)}
                onAnnotate={(note) => void hl.annotate(note)}
              />
            )}
          </div>
          {hl.err && <div className="alert error inset">{hl.err}</div>}

          {/* 本文高亮（§11.3）。放在正文之后而不是侧栏第二列：
              侧栏已经有了目录与 AI 卡片，再加一栏会把正文挤窄。 */}
          <section className="reader-hl">
            <h3 className="reader-hl-head">
              高亮
              {hl.items.filter((x) => !x.isOrphaned).length > 0
                && <span className="muted"> {hl.items.filter((x) => !x.isOrphaned).length}</span>}
            </h3>
            <HighlightList
              items={hl.items}
              onScrollTo={hl.scrollTo}
              onDelete={(id) => void hl.remove(id)}
              onRecolor={(id, c) => void hl.recolor(id, c)}
              onSaveNote={(id, n) => void hl.updateNote(id, n)}
              onInsight={(id) => void hl.insight(id)}
              insightBusy={hl.insightBusy}
            />
          </section>

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
