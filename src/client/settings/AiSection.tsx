// 配置中心的「AI 分析」分类（PLAN §8 / §8.5，M2；§15.29 分层折叠，v2.2）。
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
//
// ## 分层折叠（§15.29，v2.2）
//
// 改之前四张卡全部常显：6 个输入框 + 8 个按钮，垂直约 1400px，在 900px 高的
// 弹窗里要滚三屏。问题是**访问频率差两个数量级的东西并排堆着** ——
// 日常看用量、一辈子填一次模型名、可选改提示词，三者视觉重量一样。
//
// 所以按访问频率分四层，后两层默认收起：
//   ① 概览（常显）  运行档位 / 今日·本月花费 / 调用数 / 已分析
//   ② 常用（常显）  API Key 卡 + 每日预算
//   ③ 高级（收起）  接口地址 + 三个模型名
//   ④ 提示词（收起）单篇总结的提示词
//
// 为什么 Key 卡不折叠：§8.8 的整个动机就是"用户能在界面上填 key"，
// 藏进折叠等于把它变回"去改环境变量"。它是唯一值得占屏的写操作。
//
// 为什么把「模型连接」拆开、只折叠地址与模型名：预算（dailyUsd）是这一页
// **唯一高频的写操作**（"这个月想省点钱"），整卡折叠会让它多两次点击。
import { useCallback, useEffect, useState } from 'react';
import { IconSparkle, IconRefresh } from '../icons.tsx';
import { api, ApiFailure } from '../api.ts';
import { AiSelfTest } from './AiSelfTest.tsx';

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
  keySource: 'file' | 'env' | 'none';
  keyMasked: string | null;
  source: 'settings' | 'deployed';
  summaryPrompt: string;
  summaryPromptDefault: string;
  summaryPromptIsDefault: boolean;
}

const LEVEL_LABEL: Record<string, string> = {
  ok: '正常运行',
  fast_only: '降级：只用快模型',
  stop: '已暂停',
};

const KEY_SOURCE_LABEL: Record<AiConfigView['keySource'], string> = {
  file: '界面上填的（data/secrets.json）',
  env: '环境变量',
  none: '未配置',
};

export function AiSection() {
  const [cfg, setCfg] = useState<AiConfigView | null>(null);
  const [stats, setStats] = useState<AiStats | null>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // 表单只放**用户可覆盖**的字段。key 有独立的输入框（见下面的「API Key」卡）：
  // 它与其它字段的语义不同 —— 其它字段留空 = 不改，而 key 留空 = 不改、
  // 点「删除」才是清空。混在同一张表单里会让"清空"没有明确的入口。
  const [baseURL, setBaseURL] = useState('');
  const [fastModel, setFastModel] = useState('');
  const [strongModel, setStrongModel] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [dailyUsd, setDailyUsd] = useState('');

  // 新 key 的输入框：写进 data/secrets.json（§8.8）。
  // 用 type="password" 只是防肩窥，不是安全措施 —— 真正的措施是
  // 服务端从不回显、且文件不进库与备份。
  const [newKey, setNewKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 单篇总结的提示词（§8.9）
  const [promptDraft, setPromptDraft] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);

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
      setNewKey('');
      setPromptDraft(c.summaryPromptIsDefault ? '' : c.summaryPrompt);
    } catch (e) {
      fail(e, '读取 AI 配置失败');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * 写入 key（§8.8）。不传参就用输入框的值；传明确的值用于「删除」。
   *
   * 为什么删除要传参而不是先 setNewKey('') 再调：React 的 setState 是异步的，
   * 同一次事件里读到的 newKey 仍是旧值 —— 那样点「删除」会先把 key 存一遍
   * 再删，多来一次写盘，而且中间那一刻文件里是新 key。
   */
  const saveKey = async (explicit?: string) => {
    setKeyBusy(true);
    setErr('');
    setNotice('');
    setTestMsg(null);
    try {
      const k = (explicit ?? newKey).trim();
      await api.setApiKey(k);
      setNewKey('');
      setNotice(k ? 'API key 已保存' : 'API key 已删除，回落到环境变量');
      await reload();
    } catch (e) {
      fail(e, '保存 API key 失败');
    } finally {
      setKeyBusy(false);
    }
  };

  const testKey = async () => {
    setKeyBusy(true);
    setTestMsg(null);
    try {
      const r = await api.testAiKey();
      if (r.ok) {
        setTestMsg({ kind: 'ok', text: `连接正常（${r.model}）` });
      } else {
        // 文案按 kind 分流：401 与 network 的处置完全不同，
        // 统一说"测试失败"等于什么都没说。
        const base = r.hint ?? r.failure?.message ?? '测试失败';
        setTestMsg({ kind: 'err', text: `${base}${r.failure?.kind ? `（${r.failure.kind}）` : ''}` });
      }
    } catch (e) {
      setTestMsg({ kind: 'err', text: e instanceof ApiFailure ? e.message : '测试失败' });
    } finally {
      setKeyBusy(false);
    }
  };

  /** 保存总结提示词（§8.9）。空串 = 恢复默认 */
  const savePrompt = async () => {
    setPromptBusy(true);
    setErr('');
    setNotice('');
    try {
      await api.patchAiConfig({ summaryPrompt: promptDraft.trim() });
      setNotice(promptDraft.trim() ? '总结提示词已保存' : '总结提示词已恢复默认');
      await reload();
    } catch (e) {
      fail(e, '保存提示词失败');
    } finally {
      setPromptBusy(false);
    }
  };

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

  /**
   * 只保存预算。与 `save()` 分开是因为它**不属于折叠区**（§15.29）：
   * 预算是这一页唯一高频的写操作，不该被"先展开高级设置"挡两道。
   */
  const saveBudget = async () => {
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      if (!dailyUsd.trim()) {
        setNotice('没有要保存的改动');
        return;
      }
      const v = Number(dailyUsd);
      if (!Number.isFinite(v) || v < 0) throw new Error('每日预算必须是非负数字');
      await api.patchAiConfig({ budget: { dailyUsd: v } });
      setNotice('预算已保存');
      await reload();
    } catch (e) {
      fail(e, '保存预算失败');
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
          条目入库后会自动排队做分类分级与向量化。这里放"用哪个 key、连哪个模型、
          花多少钱"。分类法与分级规则仍然不开放编辑（改了会让历史数据与新数据不可比），
          但**单篇总结的提示词可以改** —— 它只影响你主动点的那一下。
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
            还没有 API key —— 环境变量 <code>{cfg.apiKeyEnv}</code> 与下面的
            「API Key」卡都为空。不填就不调用模型：条目照常入库，但不出摘要与分类。
            <br />
            两种给法任选：卡里填（存进 <code>data/secrets.json</code>，
            <strong>不需要重启</strong>，下一轮分析就用上），或部署时注入上面那个环境变量。
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

      {/* ── ② API Key（§8.8，v2.0）──
          常显而不是收进折叠（§15.29）：§8.8 的整个动机就是"用户能在界面上
          填 key"，藏起来等于把它变回"去改环境变量"。它是这一页唯一
          值得占屏的写操作。 */}
      <section className="settings-card" id="ai-key-card">
        <div className="settings-card-head">
          <h3>API Key</h3>
          <span className="muted" data-testid="key-source">
            当前来源：{KEY_SOURCE_LABEL[cfg?.keySource ?? 'none']}
            {cfg?.keyMasked ? ` · ${cfg.keyMasked}` : ''}
          </span>
        </div>

        <p className="hint">
          存在 <code>data/secrets.json</code>（权限收紧到仅当前用户）。
          <strong>不会写进数据库，所以备份包、导出、迁移里都不含它</strong> ——
          换机器时要重新填一次。
          {cfg?.keySource === 'env' && (
            <> 环境变量 <code>{cfg.apiKeyEnv}</code> 里已有一个；这里填的会**覆盖**它。</>
          )}
        </p>

        <div className="field-row">
          <label className="field grow">
            <span className="field-label">新的 API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder={cfg?.hasKey ? '已配置，留空表示不改' : 'sk-…'}
            />
          </label>
        </div>

        <div className="settings-actions">
          <button
            className="btn primary" onClick={() => void saveKey()}
            disabled={keyBusy || newKey.trim() === ''}
          >
            <IconSparkle size={15} /> 保存 Key
          </button>
          <button className="btn" onClick={() => void testKey()} disabled={keyBusy || !cfg?.hasKey}>
            <IconRefresh size={14} /> 测试连接
          </button>
          <button
            className="btn danger" onClick={() => void saveKey('')}
            disabled={keyBusy || cfg?.keySource !== 'file'}
            title={cfg?.keySource === 'file' ? '删除文件里的 key，回落到环境变量' : '当前 key 不在文件里'}
          >
            删除 Key
          </button>
        </div>

        {testMsg && (
          <p className={testMsg.kind === 'ok' ? 'hint' : 'hint warn'} role="status">
            {testMsg.text}
          </p>
        )}
      </section>

      {/* ── 自检与测速（§15.30，v2.7）──
          常显不折叠：它是"为什么不好用"的答案，藏起来等于没做。
          位置在 Key 卡之后（要先有 key 才有得测）、预算卡之前
          （预算是高频写操作，不该被一整块诊断表压到下面）。 */}
      <AiSelfTest />

      {/* ── ② 每日预算（常显，§15.29）──
          它原本混在「模型连接」卡里，跟着地址与模型名一起被折叠。
          但预算与它们的访问频率完全不同："这个月想省点钱"是这一页
          唯一高频的写操作，而 baseURL 一辈子填一次。 */}
      <section className="settings-card" id="ai-budget-card">
        <div className="settings-card-head">
          <h3>每日预算</h3>
          <span className="muted">
            {stats?.dailyLimit ? `当前 $${stats.dailyLimit}` : '当前不限'}
          </span>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-label">每日上限（美元，留空 = 不改）</span>
            <input
              type="text" value={dailyUsd}
              onChange={(e) => setDailyUsd(e.target.value)}
              placeholder={cfg ? String(cfg.budget.dailyUsd) : '1'}
              inputMode="decimal"
            />
          </label>
        </div>

        <p className="hint">
          超过每日预算会自动降级到快模型继续分析；超过每月预算则暂停，第二天/下个月自动恢复。
          填 0 表示不限额。
        </p>

        <div className="settings-actions">
          <button className="btn primary" onClick={() => void saveBudget()} disabled={busy}>
            <IconSparkle size={15} /> 保存预算
          </button>
        </div>
      </section>

      {/* ── ③ 高级设置：接口地址 + 三个模型名（默认收起，§15.29）──
          收起不是"藏起来不准改"，是"标成低频"。summary 行右侧带当前值摘要，
          不点开也知道里面是什么。 */}
      <details className="settings-card settings-fold" id="ai-advanced-card">
        <summary className="settings-fold-head">
          <h3>模型连接</h3>
          <span className="muted settings-fold-summary" data-testid="ai-models-summary">
            {cfg ? `${cfg.models.fast} / ${cfg.models.strong}` : '未读取'}
          </span>
        </summary>

        <p className="hint">
          当前来源：{cfg?.source === 'settings' ? '设置页（覆盖了部署配置）' : '部署配置（环境变量 / config.json）'}。
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

        <div className="settings-actions">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            <IconSparkle size={15} /> 保存
          </button>
        </div>
      </details>

      {/* ── ④ 单篇总结的提示词（§8.9；默认收起，§15.29）──
          只有"总结"这一个动作受影响，分类分级仍然用固定提示词。 */}
      <details className="settings-card settings-fold" id="ai-summary-prompt-card">
        <summary className="settings-fold-head">
          <h3>总结提示词</h3>
          <span className="muted settings-fold-summary" data-testid="ai-prompt-summary">
            {cfg?.summaryPromptIsDefault ? '内置默认' : '已自定义'}
          </span>
        </summary>

        <p className="hint">
          阅读页的「总结」按钮用它。可用占位符：
          <code>{'{{title}}'}</code> <code>{'{{body}}'}</code>{' '}
          <code>{'{{summary}}'}</code> <code>{'{{highlights}}'}</code>。
          至少要有一个占位符，否则正文不会被喂给模型。
          留空保存 = 恢复默认；改了提示词不会覆盖已有的总结（旧的仍在，改回来即可命中）。
        </p>

        <label className="field">
          <span className="field-label">提示词</span>
          <textarea
            rows={10}
            className="prompt-area"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            placeholder={cfg?.summaryPromptIsDefault ? '留空 = 用内置默认' : ''}
          />
        </label>

        <div className="settings-actions">
          <button className="btn primary" onClick={() => void savePrompt()} disabled={promptBusy}>
            <IconSparkle size={15} /> 保存提示词
          </button>
          <button
            className="btn"
            onClick={() => setPromptDraft(cfg?.summaryPromptDefault ?? '')}
            disabled={promptBusy}
            title="把默认提示词填进输入框，再点保存"
          >
            填入默认值
          </button>
          <button
            className="btn"
            onClick={() => { setPromptDraft(''); void (async () => {
              setPromptBusy(true);
              try {
                await api.patchAiConfig({ summaryPrompt: '' });
                setNotice('总结提示词已恢复默认');
                await reload();
              } catch (e) {
                fail(e, '恢复默认失败');
              } finally {
                setPromptBusy(false);
              }
            })(); }}
            disabled={promptBusy || cfg?.summaryPromptIsDefault}
          >
            恢复默认
          </button>
        </div>
      </details>
    </div>
  );
}
