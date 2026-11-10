// 配置中心的「每日简报」分类（PLAN §9 / §19.5，M3）。
//
// 这一页要回答的问题与 AI 页不同：AI 页是"连哪个模型、花多少钱"，
// 简报页是"什么时候出、为什么今天没有、上次那份在哪儿"。第三个问题
// 决定了它不能只是一个设置表单 —— 必须能在同一屏看到今日状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconClock, IconRefresh, IconSparkle } from '../icons.tsx';
import { fmtElapsed, phaseLabel } from '../digest/run-format.ts';
import { api, ApiFailure, type DigestRunView } from '../api.ts';


interface DigestStatusView {
  enabled: boolean;
  at: string;
  state: 'none' | 'generated' | 'skipped' | 'failed' | 'pending';
  digestId: string | null;
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  nextAt: number;
  /** 单次生成的花费上限（美元）。UI 要回显 —— 用户设过的值不能靠猜 */
  maxCostUsd: number;
  /** 最近一次生成（含正在跑的那次）。没有过则为 null */
  run: DigestRunView | null;
}

/** 跑着的 / 排队着的那一次。不在本地维护这个标志：刷新就不同步了 */
function isActive(r: DigestRunView | null): boolean {
  return r !== null && (r.status === 'queued' || r.status === 'running');
}

const STATE_LABEL: Record<DigestStatusView['state'], string> = {
  none: '今天还没到生成时间',
  generated: '今天的简报已生成',
  skipped: '今天没有值得出简报的内容',
  failed: '今天生成失败，会重试',
  pending: '正在准备今天的简报',
};

export function DigestSection() {
  const [st, setSt] = useState<DigestStatusView | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [stopping, setStopping] = useState(false);
  const pollRef = useRef<number | null>(null);

  const run = st?.run ?? null;
  const active = isActive(run);

  const fail = (e: unknown, fb: string) => {
    setErr(e instanceof ApiFailure ? e.message : fb);
  };

  const reload = useCallback(async () => {
    setErr('');
    try {
      const s = await api.digestStatus();
      setSt(s);
      setAt('');
    } catch (e) {
      fail(e, '读取简报状态失败');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const saveAt = async () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      setErr('时间格式应为 HH:MM，例如 08:00');
      return;
    }
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      await api.patchDigestConfig({ at });
      setNotice(`已改为每天 ${at} 生成`);
      await reload();
    } catch (e) {
      fail(e, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      await api.patchDigestConfig({ enabled });
      setNotice(enabled ? '已开启' : '已关闭');
      await reload();
    } catch (e) {
      fail(e, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      // 服务端立刻返回 202 + runId，不在这次请求里等生成完（实测一次要
      // 好几分钟）。跑没跑完由下面的轮询发现 —— 否则按钮会 disabled 到
      // 底，用户连"它在动"都看不到。
      const r = await api.runDigest(false);
      if (!r.queued) {
        setNotice(r.message ?? '已经有一次在生成');
      } else if (r.hint) {
        // 服务端知道这次多半没有内容可出（今天已生成 / 没有簇），
        // 直接说出原因比让用户等一轮再看到"没生成"更好
        setNotice(`已开始，但可能没有内容：${r.hint}`);
      } else {
        setNotice('已开始生成，进度见下方');
      }
      await reload();
    } catch (e) {
      fail(e, '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async () => {
    if (!run) return;
    setStopping(true);
    setErr('');
    try {
      const r = await api.stopDigest(run.id);
      setNotice(r.message);
      await reload();
    } catch (e) {
      fail(e, '停止失败');
    } finally {
      setStopping(false);
    }
  };

  const saveMaxCost = async () => {
    const n = Number(maxCost);
    if (!maxCost.trim() || !Number.isFinite(n) || n <= 0) {
      setErr('上限必须是大于 0 的数字（美元）');
      return;
    }
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      await api.patchDigestConfig({ maxCostUsd: n });
      setNotice(`已把单次上限改为 $${n}`);
      await reload();
    } catch (e) {
      fail(e, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  // 有东西在跑时每 2 秒问一次状态，跑完立刻停。
  // 常开轮询会让这一页一直打扰服务端；而这个页面**恰好**是用户会开着
  // 盯进度的地方，只有跑起来时才是活的。
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.digestStatus();
        if (!alive) return;
        setSt(s);
        const r = s.run;
        if (r && !isActive(r)) {
          // 结束了：状态条会自己更新，这里只补一句人话
          setNotice(
            r.status === 'done' ? '已生成'
              : r.status === 'cancelled' ? `已停止：${r.cancelReason ?? '用户手动停止'}`
                : r.status === 'interrupted' ? '上次生成被中断（进程重启）'
                  : `没生成出来：${r.reason ?? '未知原因'}`,
          );
        }
      } catch { /* 下一轮再试 */ }
    };
    void tick();
    pollRef.current = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [active]);

  const stLabel = st ? STATE_LABEL[st.state] : '';
  const next = st ? new Date(st.nextAt).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';

  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>每日简报</h2>
        <p className="muted">
          每天在固定时间把最近 24 小时的内容聚成事件、跨源归纳，出一份带引用的简报。
          只有一件事时不出 —— 一条孤立新闻不构成"日报"。
        </p>
      </header>

      {err && <div className="alert error inset" role="alert">{err}</div>}
      {notice && <div className="alert ok inset" role="status">{notice}</div>}

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>今日状态</h3>
          <button className="btn sm" onClick={() => void reload()} disabled={busy}>
            <IconRefresh size={14} /> 刷新
          </button>
        </div>

        <div className={`ai-level ai-level-${st?.state === 'failed' ? 'stop' : 'ok'}`}
          data-state={st?.state ?? 'none'}>
          <span className="ai-level-dot" aria-hidden="true" />
          <span className="ai-level-text">{stLabel}</span>
          {st?.state === 'failed' && st.lastError && (
            <span className="ai-level-reason">{st.lastError.slice(0, 60)}</span>
          )}
          {st?.state === 'skipped' && st.skipReason && (
            <span className="ai-level-reason">{st.skipReason}</span>
          )}
        </div>

        <dl className="ai-kv">
          <div>
            <dt>生成时间</dt>
            <dd>{st?.at ?? '08:00'}（本地时区）</dd>
          </div>
          <div>
            <dt>下次</dt>
            <dd>{next || '—'}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{st?.enabled ? '已开启' : '已关闭'}</dd>
          </div>
          <div>
            <dt>今日尝试</dt>
            <dd>{st?.attempts ?? 0} 次</dd>
          </div>
        </dl>

        {st?.digestId && (
          <p className="hint">今天的简报 id：<code>{st.digestId}</code></p>
        )}

        {/* 跑着的时候把进度摆在这儿：这一页的第三个问题就是"现在在干什么"。
            数字全部来自服务端 digest_runs，前端不估算 —— 估出来的进度条
            会在最慢的那一步停住，比没有更像死了。 */}
        {active && run && (
          <div className="digest-progress" data-stale={run.stale ? '1' : '0'}>
            <div className="digest-progress-head">
              <span className="spinner" />
              <span className="digest-progress-phase">
                {run.status === 'queued' ? '排队中' : phaseLabel(run.phase, run.status)}
              </span>
              {run.totalClusters > 0 && (
                <span className="digest-progress-num">
                  {run.doneClusters}/{run.totalClusters}
                </span>
              )}
            </div>
            <div className="digest-progress-bar">
              <span
                style={{
                  width: `${run.totalClusters > 0
                    ? Math.min(100, (run.doneClusters / run.totalClusters) * 100)
                    : 8}%`,
                }}
              />
            </div>
            <div className="digest-progress-meta">
              <span>已花 ${run.costUsd.toFixed(4)}</span>
              {st && <span> · 上限 ${st.maxCostUsd}</span>}
              <span> · 用时 {fmtElapsed(run.elapsedMs)}</span>
              {run.stale && <span className="digest-progress-stale"> · 心跳停了</span>}
            </div>
          </div>
        )}

        {active && (
          <div className="settings-actions">
            <button className="btn danger" onClick={() => void stopRun()} disabled={stopping}>
              {stopping ? '正在停止…' : '停止这次生成'}
            </button>
            <span className="hint" style={{ alignSelf: 'center' }}>
              停止后已经花掉的不会退。
            </span>
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><h3>生成时间</h3></div>
        <p className="hint">
          改时间不会产生第二份简报 —— 同一天的简报按"哪一天"去重，而不是按"几点"。
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">每天几点（留空 = 不改）</span>
            <input
              type="text" value={at}
              onChange={(e) => setAt(e.target.value)}
              placeholder={st?.at ?? '08:00'}
              inputMode="numeric"
            />
          </label>
        </div>
        <div className="settings-actions">
          <button className="btn primary" onClick={() => void saveAt()} disabled={busy || !at}>
            <IconClock size={15} /> 保存时间
          </button>
          <button className="btn" onClick={() => void toggle(!st?.enabled)} disabled={busy}>
            {st?.enabled ? '关闭简报' : '开启简报'}
          </button>
          <button className="btn" onClick={() => void runNow()} disabled={busy || active}>
            <IconSparkle size={15} /> 现在生成
          </button>
        </div>
        <p className="hint">
          「现在生成」会立刻跑一次（不受时间与"今天已做过"限制），但没有内容时仍然不会产出空白简报。
          每跑一次都会产生模型调用成本。
        </p>
      </section>

      <section className="settings-card">
        <div className="settings-card-head"><h3>单次花费上限</h3></div>
        <p className="hint">
          超过这个数就停下 —— 没人在旁边盯着的时候，这是唯一能拦住失控花费的东西。
          实测一次（十几个事件归纳 + 一次正文）约 $0.03。
        </p>
        <div className="field-row">
          <label className="field">
            <span className="field-label">上限（美元，留空 = 不改）</span>
            <input
              type="text" value={maxCost}
              onChange={(e) => setMaxCost(e.target.value)}
              placeholder={st ? String(st.maxCostUsd) : '0.2'}
              inputMode="decimal"
            />
          </label>
        </div>
        <div className="settings-actions">
          <button className="btn" onClick={() => void saveMaxCost()} disabled={busy || !maxCost}>
            保存上限
          </button>
        </div>
        <p className="hint">
          当前生效值：${st?.maxCostUsd ?? '—'}。「现在生成」时如果中途越过这条线，
          这次生成会被停掉（已经花掉的不退），并记下停因。
        </p>
      </section>
    </div>
  );
}
