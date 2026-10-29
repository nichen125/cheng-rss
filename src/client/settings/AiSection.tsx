// 配置中心的「AI 分析」分类（PLAN §8 / §8.5，M2）。
//
// 这一页的核心不是"填一串参数"，而是回答三个问题：
//   1. 现在到底连的是哪个服务商、用的哪个模型？（配了三层，最容易搞混）
//   2. 今天/这个月已经花了多少，还剩多少？
//   3. 为什么没分析？（没 key / 超预算 / 分析失败）
//
// 第 1 点做成**只读展示 + 覆盖输入**：`baseURL` 多数部署是从环境变量
// 注入的（Docker、NAS），若这一页把空输入框直接提交，会把部署期配好的
// 地址打回默认服务商 —— 那正是 service.ts 里 composeAiConfig 要防的坑。
// 所以留空 = 不动部署期配置，UI 上明确写出来。
import { useCallback, useEffect, useState } from 'react';
import { IconSparkle, IconRefresh } from '../icons.tsx';
import { api, ApiFailure } from '../api.ts';

interface AiStats {
  analyzed: number;
  failed: number;
  dims: Record<string, number>;
  level: 'ok' | 'fast_only' | 'stop';
  todayUsd: number;
  monthUsd: number;
  dailyLimit: number;
  monthlyLimit: number;
  todayCalls: number;
  todayFailures: number;
  reason: string;
}

interface AiConfigView {
  baseURL: string;
  apiKeyEnv: string;
  models: { fast: string; strong: string; embed: string };
  budget: { dailyUsd: number; monthlyUsd: number };
  hasKey: boolean;
  source: 'settings' | 'deployed';
}

const LEVEL_LABEL: Record<string, string> = {
  ok: '正常运行',
  fast_only: '降级：只用快模型',
  stop: '已暂停',
};

export function AiSection() {
  const [cfg, setCfg] = useState<AiConfigView | null>(null);
  const [stats, setStats] = useState<AiStats | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // 表单只放**用户可覆盖**的字段。apiKey 不在这里 —— 它只能从环境变量读，
  // 让它出现在输入框里等于邀请用户把 key 填进数据库。
  const [baseURL, setBaseURL] = useState('');
  const [fastModel, setFastModel] = useState('');
  const [strongModel, setStrongModel] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [dailyUsd, setDailyUsd] = useState('');

  const fail = (e: unknown, fb: string) => {
    setErr(e instanceof ApiFailure ? e.message : fb);
  };

  const reload = useCallback(async () => {
    setErr('');
    try {
      const [c, s] = await Promise.all([api.getAiConfig(), api.stats()]);
      setCfg(c);
      setStats((s as { ai?: AiStats }).ai ?? null);
      setBaseURL('');
      setFastModel('');
      setStrongModel('');
      setEmbedModel('');
      setDailyUsd('');
    } catch (e) {
      fail(e, '读取 AI 配置失败');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const save = async () => {
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      // 只提交**填了**的字段。空串表示"不改"，服务端 composeAiConfig
      // 对空串也是这个语义 —— 但这里先过滤掉，避免让人误以为清了值。
      const patch: Record<string, unknown> = {};
      if (baseURL.trim()) patch.baseURL = baseURL.trim();
      const models: Record<string, string> = {};
      if (fastModel.trim()) models.fast = fastModel.trim();
      if (strongModel.trim()) models.strong = strongModel.trim();
      if (embedModel.trim()) models.embed = embedModel.trim();
      if (Object.keys(models).length > 0) patch.models = models;
      if (dailyUsd.trim()) {
        const v = Number(dailyUsd);
        if (!Number.isFinite(v) || v < 0) throw new Error('每日预算必须是非负数字');
        patch.budget = { dailyUsd: v };
      }
      if (Object.keys(patch).length === 0) {
        setNotice('没有要保存的改动');
        return;
      }
      await api.patchAiConfig(patch);
      setNotice('已保存');
      await reload();
    } catch (e) {
      fail(e, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const dims = stats?.dims ?? {};
  const dimList = Object.entries(dims);
  const pct = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>AI 分析</h2>
        <p className="muted">
          条目入库后会自动排队做分类分级与向量化。这里只放"连哪个模型"和"花多少钱"，
          提示词与分类法不开放编辑（改了会让历史数据与新数据不可比）。
        </p>
      </header>

      {err && <div className="alert error inset" role="alert">{err}</div>}
      {notice && <div className="alert ok inset" role="status">{notice}</div>}

      {/* ── 状态摘要：这一块是"为什么没分析"的答案 ── */}
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>运行状态</h3>
          <button className="btn sm" onClick={() => void reload()} disabled={busy}>
            <IconRefresh size={14} /> 刷新
          </button>
        </div>

        <div className={`ai-level ai-level-${stats?.level ?? 'ok'}`} data-level={stats?.level ?? 'ok'}>
          <span className="ai-level-dot" aria-hidden="true" />
          <span className="ai-level-text">{LEVEL_LABEL[stats?.level ?? 'ok']}</span>
          {stats?.reason && <span className="ai-level-reason">{stats.reason}</span>}
        </div>

        {cfg && !cfg.hasKey && (
          <p className="hint warn">
            环境变量 <code>{cfg.apiKeyEnv}</code> 里没有 API key —— 现在不会调用任何模型。
            key 只从环境变量读，不写进数据库（备份包里不会有它）。
          </p>
        )}

        <dl className="ai-kv">
          <div>
            <dt>今日花费 / 额度</dt>
            <dd>
              ${stats?.todayUsd?.toFixed(3) ?? '—'} / {stats?.dailyLimit ? `$${stats.dailyLimit}` : '不限'}
              {stats && stats.dailyLimit > 0 && (
                <span className="ai-bar" aria-hidden="true">
                  <span style={{ width: `${pct(stats.todayUsd, stats.dailyLimit)}%` }} />
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>本月花费 / 额度</dt>
            <dd>
              ${stats?.monthUsd?.toFixed(3) ?? '—'} / {stats?.monthlyLimit ? `$${stats.monthlyLimit}` : '不限'}
            </dd>
          </div>
          <div>
            <dt>今日调用</dt>
            <dd>
              {stats?.todayCalls ?? 0} 次
              {stats && stats.todayFailures > 0 && (
                <span className="muted">（失败 {stats.todayFailures}）</span>
              )}
            </dd>
          </div>
          <div>
            <dt>已分析 / 失败</dt>
            <dd>
              {stats?.analyzed ?? 0} 篇
              {stats && stats.failed > 0 && <span className="muted">（{stats.failed} 篇失败）</span>}
            </dd>
          </div>
        </dl>

        {/* 维度分布：换过 embedding 模型时这里会同时出现两种维度 */}
        {dimList.length > 1 && (
          <p className="hint warn">
            库里同时存在 {dimList.length} 种向量维度（
            {dimList.map(([d, n]) => `${d} 维 ${n} 条`).join('、')}
            ）。不同维度的向量无法互相比较，建议清空旧向量后重跑。
          </p>
        )}
        {dimList.length === 1 && (
          <p className="hint">
            向量维度：{dimList[0]?.[0]} 维，共 {dimList[0]?.[1]} 条。
          </p>
        )}
      </section>

      {/* ── 连接配置 ── */}
      <section className="settings-card">
        <div className="settings-card-head">
          <h3>模型连接</h3>
          <span className="muted">
            当前来源：{cfg?.source === 'settings' ? '设置页（覆盖了部署配置）' : '部署配置（环境变量 / config.json）'}
          </span>
        </div>

        <p className="hint">
          下面的输入框留空 = 不修改。部署期注入的值（Docker / NAS 的
          <code>AI_BASE_URL</code>）不会被空输入框打回默认值 —— 这是刻意的。
        </p>

        <label className="field">
          <span className="field-label">接口地址</span>
          <input
            type="text"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder={cfg?.baseURL ?? 'https://api.deepseek.com/v1'}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">快模型（粗筛）</span>
            <input
              type="text" value={fastModel}
              onChange={(e) => setFastModel(e.target.value)}
              placeholder={cfg?.models.fast ?? 'deepseek-chat'}
            />
          </label>
          <label className="field">
            <span className="field-label">强模型（摘要）</span>
            <input
              type="text" value={strongModel}
              onChange={(e) => setStrongModel(e.target.value)}
              placeholder={cfg?.models.strong ?? 'deepseek-chat'}
            />
          </label>
        </div>

        <label className="field">
          <span className="field-label">向量模型</span>
          <input
            type="text" value={embedModel}
            onChange={(e) => setEmbedModel(e.target.value)}
            placeholder={cfg?.models.embed ?? 'text-embedding-3-small'}
          />
        </label>

        <label className="field">
          <span className="field-label">每日预算（美元）</span>
          <input
            type="text" value={dailyUsd}
            onChange={(e) => setDailyUsd(e.target.value)}
            placeholder={cfg ? String(cfg.budget.dailyUsd) : '1'}
            inputMode="decimal"
          />
        </label>

        <p className="hint">
          超过每日预算会自动降级到快模型继续分析；超过每月预算则暂停，第二天/下个月自动恢复。
          填 0 表示不限额。
        </p>

        <div className="settings-actions">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            <IconSparkle size={15} /> 保存
          </button>
        </div>
      </section>
    </div>
  );
}
