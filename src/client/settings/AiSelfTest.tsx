// 设置页 › AI 分析 › 自检与测速（PLAN §15.30，v2.7 / 步骤 2.10 / 2.11）。
//
// 这一块回答的问题与「测试连接」不同，两者不能互相替代：
//
//   测试连接  2 秒 / ~60 token   key 能不能过鉴权
//   开始自检  10~60 秒 / ~3000  这条链上每一步通不通、不通该怎么办
//   测速      10~20 秒 / ~1500  两个模型谁快，慢在排队还是慢在生成
//
// 线上真实故障是"key 通、但每一篇分析都失败"，而第一颗按钮对它一无所知 ——
// 用户能看到只有"分析失败 N 篇"。
//
// ## 几个刻意的决定
//
// · **常显不折叠**（§15.29 的分层原则按访问频率排）。自检是"为什么不好用"
//   的答案，藏进折叠等于没做。
// · **刷新后仍在**：首屏读 latest，不靠内存状态。刷新就没了等于没测。
// · **状态点用语义色**（`design-ui.md` §2.1 允许：它表达的是 AI 的判断），
//   但四色必须能一眼区分 —— 灰阶在"通过/降级"之间分不出来。
// · **失败必须带 hint**。只给 fail 不给"怎么办"，用户只能对着错误码发呆，
//   那正是这一期要消灭的体验。
import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from '../api.ts';

type Status = 'pass' | 'warn' | 'fail' | 'skip';

interface Step {
  id: string;
  title: string;
  status: Status;
  detail: string;
  hint?: string;
  raw?: string;
  metrics?: { latencyMs?: number | null; inTokens?: number | null; outTokens?: number | null; costUsd?: number | null };
}

interface BenchRow {
  model: string;
  okCount: number;
  // `streamed` 必须带上：不支持流式时首字列要写文案而不是数字，
  // 少了它就分不清"没测到"与"这个网关根本不支持"
  runs: { ok: boolean; streamed: boolean; error?: string }[];
  median: {
    ok: boolean;
    ttftMs: number | null;
    firstReasoningMs: number | null;
    firstContentMs: number | null;
    totalMs: number;
    outTokens: number | null;
    tokensPerSec: number | null;
    range: { ttftMs: [number, number] | null; totalMs: [number, number] | null };
  };
}

const STATUS_LABEL: Record<Status, string> = {
  pass: '通过', warn: '降级', fail: '失败', skip: '跳过',
};

/** 顶层结论条的颜色：fail → 红，有降级/跳过 → 黄，全绿 → 绿。 */
function levelOf(steps: Step[]): string {
  if (steps.some((s) => s.status === 'fail')) return 'ai-level-stop';
  if (steps.some((s) => s.status === 'warn' || s.status === 'skip')) return 'ai-level-warn';
  return 'ai-level-ok';
}

const ms = (v: number | null | undefined): string =>
  (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

const tok = (v: number | null | undefined): string =>
  (v === null || v === undefined ? '—' : String(v));

const usd = (v: number | null | undefined): string =>
  (v === null || v === undefined ? '—' : `$${v.toFixed(5)}`);

export function AiSelfTest() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);

  const [running, setRunning] = useState(false);
  const [bench, setBench] = useState<BenchRow[] | null>(null);
  const [benching, setBenching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');
  const [showCopy, setShowCopy] = useState(false);

  /** 首屏读上次结果 —— 这是"刷新后还在"的唯一来源 */
  const loadLatest = useCallback(async () => {
    try {
      const r = await api.getAiSelfTestLatest();
      if (r?.id) {
        setSteps(r.steps ?? []);
        setVerdict(r.verdict ?? null);
        setRanAt(r.finishedAt ?? r.startedAt ?? null);
        setCost(r.costUsd ?? null);
      }
    } catch {
      // 读历史失败不该挡住"再跑一次"这件事，静默即可
    }
  }, []);

  useEffect(() => { void loadLatest(); }, [loadLatest]);

  const runTest = async () => {
    setRunning(true);
    setErr('');
    setNotice('');
    try {
      const r = await api.runAiSelfTest();
      setSteps(r.steps ?? []);
      setVerdict(r.verdict);
      setRanAt(r.finishedAt);
      setCost(r.costUsd);
      // "全部通过"只能在没有 fail、没有 warn、也没有 skip 时说。
      // 只说 fail 的话，7 步通过 + 1 步降级也报"全部通过" —— 而用户来跑
      // 自检恰恰是为了看见那一步降级（v2.7 实测那次就有 3 项降级）。
      const tally = (st: Status) => (r.steps ?? []).filter((s) => s.status === st).length;
      const parts: string[] = [];
      if (tally('fail') > 0) parts.push(`${tally('fail')} 步失败`);
      if (tally('warn') > 0) parts.push(`${tally('warn')} 项降级`);
      if (tally('skip') > 0) parts.push(`${tally('skip')} 步跳过`);
      setNotice(parts.length === 0 ? '自检完成，全部通过' : `自检完成：${parts.join('，')}`);
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '自检失败（网络或服务端错误）');
    } finally {
      setRunning(false);
    }
  };

  const runBench = async () => {
    setBenching(true);
    setErr('');
    setNotice('');
    try {
      const r = await api.benchAiModels();
      setBench(r.results ?? []);
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '测速失败');
    } finally {
      setBenching(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setErr('');
    setNotice('');
    try {
      const r = await api.retryFailedAnalyze();
      setNotice(`已复位 ${r.reset} 条，入队 ${r.queued} 条${r.remaining > 0 ? `（还有 ${r.remaining} 条待入队）` : ''}`);
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : '重跑失败');
    } finally {
      setRetrying(false);
    }
  };

  /** 把结果转成 Markdown。复制不出去时降级成一个可全选的文本框 */
  const toMarkdown = (): string => {
    const when = ranAt ? new Date(ranAt).toLocaleString() : '未知时间';
    const lines = [
      '## AI 自检报告',
      '',
      `- 结论：${verdict ?? '（无）'}`,
      `- 时间：${when}`,
      `- 花费：${usd(cost)}`,
      '',
      '| 步骤 | 状态 | 说明 | 耗时 | token |',
      '|---|---|---|---|---|',
      ...steps.map((s) => `| ${s.title} | ${STATUS_LABEL[s.status]} | ${s.detail.replace(/\|/g, '\\|')} | ${
        ms(s.metrics?.latencyMs)} | ${tok(s.metrics?.inTokens)}/${tok(s.metrics?.outTokens)} |`),
    ];
    for (const s of steps.filter((x) => x.hint)) {
      lines.push('', `> ${s.title}：${s.hint}`);
    }
    return lines.join('\n');
  };

  const copyReport = async () => {
    const md = toMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      setNotice('报告已复制到剪贴板');
    } catch {
      // 无 HTTPS / 无权限时 clipboard 会抛。降级成可全选的文本框，
      // 而不是弹一句"复制失败"就把内容丢掉。
      setShowCopy(true);
    }
  };

  return (
    <section className="settings-card" id="ai-selftest-card">
      <div className="settings-card-head">
        <h3>AI 自检</h3>
        <span className="muted" data-testid="selftest-time">
          {ranAt ? `上次：${new Date(ranAt).toLocaleString()}` : '还没跑过'}
          {cost !== null ? ` · ${usd(cost)}` : ''}
        </span>
      </div>

      <p className="hint">
        跑八步：key / 模型清单 / 对话 / <strong>system 角色</strong> / 结构化输出 /
        向量模型 / 真实分析一篇 / 真实总结一篇。约 3000 token、10~60 秒。
        <br />
        <strong>会真实分析并总结一篇条目</strong>（优先挑还没分析过的，失败也不抹掉已有结果）。
        「测试连接」是它的 2 秒版，只验 key 能不能过鉴权。
      </p>

      {err && <div className="alert error inset" role="alert">{err}</div>}
      {notice && <div className="alert ok inset" role="status">{notice}</div>}

      <div className="settings-actions">
        <button className="btn primary" onClick={() => void runTest()} disabled={running || benching}>
          {running ? '自检中…' : '开始自检'}
        </button>
        <button className="btn" onClick={() => void runBench()} disabled={running || benching}>
          {benching ? '测速中…' : '测试模型速度'}
        </button>
        <button className="btn" onClick={() => void copyReport()} disabled={steps.length === 0}>
          复制报告
        </button>
      </div>

      {/* 结论：一行话。用户先看它，需要细节才往下看表。
          三档颜色而不是两档：有降级也涂绿的话，用户会以为"没问题"，
          而他来跑自检就是为了看见降级（实测那次有 3 项）。 */}
      {verdict && (
        <div className={`ai-level ${levelOf(steps)}`}>
          <span className="ai-level-dot" aria-hidden="true" />
          <span className="ai-level-text" data-testid="selftest-verdict">{verdict}</span>
        </div>
      )}

      {steps.length > 0 && (
        <table className="selftest-table" data-testid="selftest-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>状态</th>
              <th>步骤</th>
              <th>说明</th>
              <th style={{ width: 84 }}>耗时</th>
              <th style={{ width: 84 }}>token</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.id} data-step={s.id} data-status={s.status}>
                <td>
                  <span className={`ai-dot ai-dot-${s.status}`} title={STATUS_LABEL[s.status]}>
                    {STATUS_LABEL[s.status]}
                  </span>
                </td>
                <td>{s.title}</td>
                <td>
                  {s.detail}
                  {s.hint && <div className="hint warn">{s.hint}</div>}
                  {s.raw && (
                    <details className="selftest-raw">
                      <summary>上游原始回复</summary>
                      <pre>{s.raw}</pre>
                    </details>
                  )}
                </td>
                <td>{ms(s.metrics?.latencyMs)}</td>
                <td>{tok(s.metrics?.inTokens)}/{tok(s.metrics?.outTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 测速：每模型一行。不支持流式时首字写文案，不写数字 */}
      {bench && bench.length > 0 && (
        <>
          <h4 style={{ margin: '18px 0 6px' }}>模型速度</h4>
          <table className="selftest-table" data-testid="bench-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>首字</th>
                <th>思考首字</th>
                <th>总耗时</th>
                <th>输出速度</th>
                <th>成功率</th>
              </tr>
            </thead>
            <tbody>
              {bench.map((b) => {
                const m = b.median;
                const noStream = b.runs.every((r) => r.ok && r.streamed === false);
                const rng = (v: [number, number] | null) => (v ? `（${Math.round(v[0])}~${Math.round(v[1])}）` : '');
                const firstErr = b.runs.find((r) => !r.ok)?.error;
                return (
                  <tr key={b.model} data-model={b.model}>
                    <td>{b.model}</td>
                    <td>
                      {noStream ? '不支持流式'
                        : m.ttftMs === null ? '—' : `${Math.round(m.ttftMs)} ms${rng(m.range.ttftMs)}`}
                    </td>
                    <td>{noStream ? '—' : ms(m.firstReasoningMs)}</td>
                    {/* 全失败时 totalMs 是 0（没测到），不能渲染成「0 ms」——
                        那看起来像"快得不可思议"，而事实是一次都没成功。 */}
                    <td>{m.totalMs > 0 ? `${Math.round(m.totalMs)} ms${rng(m.range.totalMs)}` : '—'}</td>
                    <td>{m.tokensPerSec === null ? '—' : `${m.tokensPerSec} tok/s`}</td>
                    <td>
                      {/* 1/3 成功与 3/3 成功都会出中位数，不显示这个数就是在骗人 */}
                      {b.okCount}/{b.runs.length} 次成功
                      {firstErr && <div className="hint warn">{firstErr}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            每个模型跑 3 次取中位数（括号里是最小~最大）。推理模型的「思考首字」
            早于「首字」是正常的 —— 它在思考，不是慢。
            {bench.some((b) => b.runs.every((r) => r.ok && r.streamed === false)) && (
              <> 该网关不支持流式，只能测总耗时，所以首字一列没有数字。</>
            )}
          </p>
        </>
      )}

      {/* 复制失败时的降级出口 */}
      {showCopy && (
        <div className="field-row" style={{ marginTop: 10 }}>
          <label className="field grow">
            <span className="field-label">报告（Ctrl+A 全选后复制）</span>
            <textarea rows={8} readOnly value={toMarkdown()} className="prompt-area" />
          </label>
        </div>
      )}

      {/* 积压重跑：修好投递方式不会让那些判死的条目自己消失 */}
      <div className="settings-actions" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => void retry()} disabled={retrying || running}>
          {retrying ? '复位中…' : '重跑 AI 失败条目'}
        </button>
        <span className="muted">
          只复位与 AI 有关的失败（schema / bad-json / empty / reasoning-only /
          upstream-quota / timeout / network / http-*），不动抓取失败与提取质量不足。
          会按队列慢慢跑，随时可在预算里叫停。
        </span>
      </div>
    </section>
  );
}
