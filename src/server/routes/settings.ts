import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { requireUserId } from '../auth/require-user.ts';
import { badRequest } from '../errors.ts';

// AI 配置读写（PLAN §8.1 / §18 的 GET /settings、PATCH /settings 的子集）。
//
// 两个刻意的限制：
//   1. **不接受 apiKey**。key 只从 `apiKeyEnv` 指定的环境变量读。
//      允许它出现在这里，等于允许明文 key 落进 app.db 与每一份备份包 ——
//      备份包恰恰是最容易被拷出去的东西。
//   2. GET 返回合成后的视图而不是数据库里的原始 JSON。用户要看的是
//      "现在实际连的是哪个地址、用的哪个模型"，而原始 JSON 只知道自己
//      覆盖了哪些字段，其余全是"不知道"。

export function settingsRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  r.get('/settings/ai', async (c) => {
    const uid = requireUserId(c);
    const { aiForUser, readAiConfigRaw, runtimeAiBase } = await import('../ai/service.ts');
    const { summaryPromptState } = await import('../ai/summary.ts');
    const base = runtimeAiBase(ctx.cfg);
    const raw = readAiConfigRaw(ctx.dbh.db, uid);
    const view = aiForUser(ctx.dbh.db, uid, base);

    const prompt = summaryPromptState(raw);

    return c.json({
      baseURL: view.config.baseURL,
      apiKeyEnv: view.config.apiKeyEnv,
      models: view.config.models,
      budget: view.config.budget,
      hasKey: view.hasKey,
      // v2.0（§8.8）：key 从哪来 + 掩码。
      // **绝不返回完整 key** —— 这条有专门断言，因为"回显"是最容易
      // 在重构中不知不觉加回来的一项（调试时顺手打个全量）。
      keySource: view.keySource,
      keyMasked: view.keyMasked,
      source: view.source,
      // 只有用户真覆盖过的字段才在这里列出来 —— 前端据此提示
      // "这几项不同于部署配置"，而不是把整套配置都摆出来
      overrides: Object.keys(raw).filter((k) => k !== 'apiKey'),
      // 单篇总结的提示词（§8.9）
      summaryPrompt: prompt.effective,
      summaryPromptDefault: prompt.defaultPrompt,
      summaryPromptIsDefault: prompt.isDefault,
    });
  });

  /**
   * 写 API key（v2.0，§8.8）。
   *
   * 单独一个端点的三个理由：
   *   · key 落在另一个文件（`data/secrets.json`），与 ai_config 不是同一份存储
   *   · 并进 `/settings/ai` 会让"只改模型"的请求也带 key 字段，
   *     而 key 一旦被前端缓存再回传，就变成了"循环搬运明文"
   *   · 拒绝路径要能给出"该用哪个接口"的明确指引
   */
  r.patch('/settings/ai/key', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!('apiKey' in body)) {
      throw badRequest('需要 apiKey 字段。传空串表示删除、回落到环境变量。');
    }
    const raw = body.apiKey;
    if (raw !== null && typeof raw !== 'string') {
      throw badRequest('apiKey 必须是字符串（空串 = 删除）');
    }
    const k = String(raw ?? '').trim();
    // 明显不是 key 的输入早一点挡住：用户很容易把 baseURL 或模型名
    // 填进这里，而那种错误只有等到第一次调用才以 401 的形态出现。
    if (k !== '' && (k.length < 8 || /\s/.test(k))) {
      throw badRequest('API key 看起来不合法：长度至少 8 位且不含空白');
    }

    const { writeSecrets } = await import('../ai/secrets.ts');
    writeSecrets(ctx.cfg.dataDir, { aiApiKey: k });
    // 缓存按「配置内容 + key 指纹」做 key（service.ts），换 key 后旧客户端
    // 本来就不会被命中；显式清一次是为了不留一个带旧 key 的对象在内存里。
    const { resetAiCache } = await import('../ai/service.ts');
    resetAiCache();

    return c.json({ ok: true, hasKey: k !== '' });
  });

  /**
   * 试一下这个 key 能不能用（v2.0，§8.8）。
   *
   * 用户填完 key 最想知道的就是这件事。让他去抓一篇文章、等 8 秒、
   * 再回来看有没有摘要，是把验证成本转嫁给用户。
   */
  r.post('/settings/ai/test', async (c) => {
    const uid = requireUserId(c);
    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { client } = aiForUser(ctx.dbh.db, uid, runtimeAiBase(ctx.cfg));
    const model = client.config.models.fast;
    // 投递方式要在**调用前**问：调用失败后它可能已经被 learnMerged 改过，
    // 那样报出来的就不是"这次实际用的"，而用户要判断的正是这次。
    const { delivery, reason: deliveryReason } = client.deliveryInfo(model);
    const t0 = Date.now();
    const r = await client.chat({
      system: '你是连通性探针。只回复 OK 两个字符，不要解释。',
      user: 'ping',
      model,
      purpose: 'test',
      userId: uid,
      // 64 token 而不是 1（§8.6b）。
      //
      // 这里验的是"这个 key 能不能通过鉴权"，不是测模型能力，所以想省 token
      // 是对的。但 1 个 token 对**推理模型**必然失败：它们会先输出思考
      // （reasoning_content），1 个 token 连思考的开口都不够，于是 content
      // 是空串、finish_reason='length'，看起来像"模型返回空"。
      //
      // 实测 deepseek-flash：max_tokens=1 → content 为空，思考只输出 "The"；
      // max_tokens=16 → 仍在思考；64 才能稳定拿到 "OK"。
      // 多花的这 63 个 token 是"测试连接能不能用"的必要成本。
      //
      // 2026-11-09 追加：这台网关的推理模型思考长度不稳定，64 有时正好被
      // 思考吃满（实测 8 次里 2 次）。客户端现在会把预算翻倍重试，所以这里
      // 保持 64 作为起点，够用且不浪费。
      maxTokens: 64,
      temperature: 0,
    });
    const latencyMs = Date.now() - t0;
    const deliveryNote = delivery === 'split' ? '分角色投递' : '合并单条投递';
    if (r.ok) {
      return c.json({
        ok: true,
        text: r.text.slice(0, 40),
        model,
        latencyMs,
        delivery,
        deliveryReason,
        inTokens: r.usage.inTokens,
        outTokens: r.usage.outTokens,
        costUsd: r.usage.costUsd,
        hint: `已连通（${deliveryNote}，模型回了「${r.text.trim().slice(0, 20)}」）`,
      });
    }
    return c.json({
      ok: false,
      model,
      latencyMs,
      delivery,
      deliveryReason,
      failure: { kind: r.failure.kind, message: r.failure.message, retryable: r.failure.retryable },
      // 401 与 network 的处置完全不同，UI 靠 kind 给不同文案。
      // 每条都要回答"那我该做什么"，因为这行字是用户唯一能看到的结论。
      hint: r.failure.kind === 'no-key' ? '先在上面填一个 key 再测试'
        : r.failure.kind === 'http-401' || r.failure.kind === 'http-403' ? 'key 无效或没有权限'
          : r.failure.kind === 'reasoning-only'
            ? '这个模型把 token 预算花在了思考上（已自动翻倍重试过一次）。换一个非推理模型，或把「快速模型」换成思考更短的模型'
          : r.failure.kind === 'empty'
            ? (delivery === 'merged'
              ? '网关丢弃 system 消息，指令被合并成一条；模型没照做。换一个模型试试'
              : '接口通了，但模型对这句探针没有输出正文。换个模型或稍后重试')
          : r.failure.kind === 'upstream-quota'
            ? '上游额度用尽，等一会儿或换 key'
          : r.failure.kind === 'budget' ? '本月预算已用完，去下面调高或等下个月'
          : r.failure.kind === 'network' || r.failure.kind === 'timeout' ? '连不上接口地址，检查 baseURL 与网络'
            : undefined,
    });
  });

  /**
   * 跑一次 AI 自检（v2.7，§8.10 / §15.30）。
   *
   * 同步执行：用户点了就在等，8 步 10~60 秒。与 `POST /entries/:id/analyze`
   * 同理由 —— 排队的轮询体验比"等 30 秒"更差。
   *
   * 会真的写库：`ai_selftest_runs`、`ai_usage`，以及第 7/8 步真的分析并总结
   * 一篇条目。这不是污染 —— 自检要回答的正是"我的库现在能不能出结果"。
   */
  r.post('/settings/ai/selftest', async (c) => {
    const uid = requireUserId(c);
    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { runSelfTest } = await import('../ai/selftest.ts');
    const base = runtimeAiBase(ctx.cfg);
    const { client } = aiForUser(ctx.dbh.db, uid, base);
    const report = await runSelfTest({ db: ctx.dbh.db, userId: uid, base, client });
    return c.json(report);
  });

  /**
   * 最近一次自检。首屏渲染用 —— 刷新后结果还在，是"便于查看"的最低要求。
   *
   * 路由顺序：这条必须注册在**任何** `/settings/ai/selftest/:x` 之前。
   * 本项目在 `/digests/status` 与 `/entries/:id` 上各踩过一次同款坑
   * （§9.5 / §7.5）：反过来的 404 措辞与"还没有结果"极像，看起来不像 bug。
   */
  r.get('/settings/ai/selftest/latest', async (c) => {
    const uid = requireUserId(c);
    const { readLatestRun } = await import('../ai/selftest.ts');
    const run = readLatestRun(ctx.dbh.db, uid);
    return c.json(run ?? { id: null, verdict: null, steps: [] });
  });

  /**
   * 积压重跑（v2.7，§8.10）。只复位 **AI 侧**的失败，不动与 AI 无关的那些。
   *
   * 为什么必须有这个入口：修好投递方式不会让 795 条积压自己消失。
   * 判据与入队用同一个函数（`countOrphanAnalyze`），否则按钮说 N 条而实际
   * 入队 0 条 —— 而用户只会看那一个数字。
   */
  r.post('/settings/ai/retry-failed', async (c) => {
    const uid = requireUserId(c);
    const { resetAiFailures } = await import('../ai/backfill.ts');
    const { countOrphanAnalyze, enqueueOrphanAnalyze } = await import('../ai/backfill.ts');
    const r = resetAiFailures(ctx.dbh.db, uid);
    const remaining = countOrphanAnalyze(ctx.dbh.db);
    const queued = enqueueOrphanAnalyze(ctx.dbh.db);
    return c.json({ ...r, queued, remaining });
  });

  /**
   * 模型测速（v2.7，§8.11）。
   *
   * 缺省测配置里的 fast 与 strong（去重）。每个模型跑 3 次报中位数 ——
   * 只跑一次等于报随机数（同一请求实测 2.5~5.8s）。
   *
   * **不落库**：速度是"当时"的属性，历史没有消费方（用户换模型/换网络之后
   * 旧数字只会误导）。面板保留本次结果并可复制，刷新即丢，这是刻意的。
   */
  r.post('/settings/ai/bench', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { models?: unknown };
    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { benchModels, BENCH_RUNS } = await import('../ai/bench.ts');
    const { client } = aiForUser(ctx.dbh.db, uid, runtimeAiBase(ctx.cfg));

    const asked = Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    const models = [...new Set(asked.length > 0
      ? asked
      : [client.config.models.fast, client.config.models.strong])];

    if (models.length === 0) throw badRequest('没有可测的模型：配置里的 fast 与 strong 都是空的');

    const results = await benchModels({ client, models, runs: BENCH_RUNS });
    return c.json({ results });
  });

  r.patch('/settings/ai', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    if ('apiKey' in body || 'api_key' in body) {
      // v2.0：key 现在可以填了，但**不是在这个接口**。指向专门的那个，
      // 这样"key 写进 app.db"这条路径根本不存在，而不是靠这里拒绝。
      throw badRequest(
        '这个接口不接收 API key（它会被写进数据库与备份）。'
        + '请用 PATCH /settings/ai/key —— 那个接口把 key 存在 data/secrets.json。',
      );
    }

    // 只接受白名单内的键。放任任意键写进 ai_config 会让拼错的键名
    // 静默失效（用户以为改了模型，其实写成了 model.fast）。
    const ALLOWED = new Set(['baseURL', 'apiKeyEnv', 'models', 'limits', 'budget', 'fallback', 'timeoutMs']);
    const bad = Object.keys(body).filter((k) => !ALLOWED.has(k) && k !== 'summaryPrompt');
    if (bad.length > 0) {
      throw badRequest(`不认识的配置项: ${bad.join(', ')}。可改的是 ${[...ALLOWED, 'summaryPrompt'].join(', ')}`);
    }
    if ('summaryPrompt' in body) {
      const p = body.summaryPrompt;
      if (p !== null && typeof p !== 'string') {
        throw badRequest('summaryPrompt 必须是字符串；传 null 或空串表示恢复默认');
      }
      const { validateSummaryPrompt } = await import('../ai/summary.ts');
      try {
        validateSummaryPrompt(p === null ? '' : String(p));
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    }

    const { readAiConfigRaw } = await import('../ai/service.ts');
    const cur = readAiConfigRaw(ctx.dbh.db, uid);

    // timeoutMs 必须显式拒绝 <= 0：0 会让 AbortSignal.timeout(0) 在下一个
    // tick 立即中止，AI 功能整体不可用，而设置界面不暴露这个字段，用户
    // 无法从 UI 改回来。空串 / null 仍表示"删除该键、回落默认"。
    if (body.timeoutMs !== undefined && body.timeoutMs !== null && body.timeoutMs !== '') {
      const n = typeof body.timeoutMs === 'number' ? body.timeoutMs : Number(body.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) {
        throw badRequest('timeoutMs 必须是大于 0 的数字（毫秒）');
      }
      body.timeoutMs = n;
    }

    // 深合并一层：{models:{fast:'x'}} 不该把 strong/embed 一起抹掉
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(body)) {
      if (v === null || v === '') { delete next[k]; continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)
        && next[k] && typeof next[k] === 'object' && !Array.isArray(next[k])) {
        next[k] = { ...(next[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        next[k] = v;
      }
    }

    const { resolveAiConfig } = await import('../ai/client.ts');
    // 先校验能解析成合法配置再落库：写进一个结构不对的 JSON
    // 会让之后每次分析都报"配置坏了"，而那时已经不知道是哪次改动造成的。
    resolveAiConfig(next);

    ctx.dbh.db.prepare(`
      INSERT INTO settings (user_id, ai_config) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET ai_config = excluded.ai_config
    `).run(uid, JSON.stringify(next));

    // 让新配置立刻生效（缓存是按配置内容做 key 的，但仍显式清一次 ——
    // 用户改完就点"重跑"时不该拿到旧客户端）
    const { resetAiCache } = await import('../ai/service.ts');
    resetAiCache();

    return c.json({ ok: true });
  });

  /**
   * 简报配置（`digest_config`）。
   *
   * 与 AI 配置不同，这里**只需要两个键**：`at` 与 `enabled`。其余字段
   * （推送方式、聚合范围）属于后续里程碑，写进库反而会在实现时被迫做兼容。
   */
  r.patch('/settings/digest', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    const ALLOWED = new Set(['at', 'enabled', 'kind', 'maxCostUsd']);
    const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
    if (bad.length > 0) {
      throw badRequest(`不认识的配置项: ${bad.join(', ')}。可改的是 ${[...ALLOWED].join(', ')}`);
    }
    if (body.at !== undefined && (typeof body.at !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.at))) {
      throw badRequest('at 必须是 HH:MM（24 小时制，例如 08:00）');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw badRequest('enabled 必须是布尔值');
    }

    // 上限**在这里拒绝而不是静默截断**。截断会给出一个用户没填过的数字，
    // 而他事后看到"我设了 200、实际按 5 停"时无法解释发生了什么。
    // parseDigestConfig 里的截断只兜"配置文件被手改成非法值"那一种。
    if (body.maxCostUsd !== undefined) {
      const { MAX_DIGEST_MAX_COST_USD } = await import('../digest/schedule.ts');
      const n = typeof body.maxCostUsd === 'number'
        ? body.maxCostUsd : Number(body.maxCostUsd);
      if (!Number.isFinite(n) || n <= 0) {
        throw badRequest('maxCostUsd 必须是大于 0 的数字（美元）');
      }
      if (n > MAX_DIGEST_MAX_COST_USD) {
        throw badRequest(`maxCostUsd 不能超过 ${MAX_DIGEST_MAX_COST_USD} 美元`
          + '（再高就等于没有上限了）');
      }
      body.maxCostUsd = n;
    }

    const row = ctx.dbh.db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
      .get(uid) as { digest_config: string } | undefined;
    let cur: Record<string, unknown> = {};
    try {
      const p = row?.digest_config ? JSON.parse(row.digest_config) : null;
      if (p && typeof p === 'object') cur = p as Record<string, unknown>;
    } catch { cur = {}; }

    const next = { ...cur, ...body };
    ctx.dbh.db.prepare(`
      INSERT INTO settings (user_id, digest_config) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET digest_config = excluded.digest_config
    `).run(uid, JSON.stringify(next));

    return c.json({ ok: true });
  });

  return r;
}
