// 配置中心的「每日简报」分类（PLAN §9 / §19.5，M3）。
//
// 这一页要回答的问题与 AI 页不同：AI 页是"连哪个模型、花多少钱"，
// 简报页是"什么时候出、为什么今天没有、上次那份在哪儿"。第三个问题
// 决定了它不能只是一个设置表单 —— 必须能在同一屏看到今日状态。
import { useCallback, useEffect, useState } from 'react';
import { IconClock, IconRefresh, IconSparkle } from '../icons.tsx';
import { api, ApiFailure } from '../api.ts';

interface DigestStatusView {
  enabled: boolean;
  at: string;
  state: 'none' | 'generated' | 'skipped' | 'failed' | 'pending';
  digestId: string | null;
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  nextAt: number;
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
      const r = await api.runDigest(false);
      if (r.ok) {
        setNotice(`简报已生成（${r.clusterCount} 个事件、${r.entryCount} 条条目）`);
      } else {
        // "没有内容"不是错误，用 notice 而不是 err 展示
        setNotice(r.reason ?? '没有生成简报');
      }
      await reload();
    } catch (e) {
      fail(e, '生成失败');
    } finally {
      setBusy(false);
    }
  };

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
          <button className="btn" onClick={() => void runNow()} disabled={busy}>
            <IconSparkle size={15} /> 现在生成
          </button>
        </div>
        <p className="hint">
          「现在生成」会立刻跑一次（不受时间与"今天已做过"限制），但没有内容时仍然不会产出空白简报。
          每跑一次都会产生模型调用成本。
        </p>
      </section>
    </div>
  );
}
