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
    const r = await client.chat({
      system: '你是连通性探针。只回复 OK。',
      user: 'ping',
      model: client.config.models.fast,
      purpose: 'test',
      userId: uid,
      // 1 个 token 就够：这里验的是"这个 key 能不能通过鉴权"，
      // 不是测模型能力。省钱且不给服务商增加真正的负载。
      maxTokens: 1,
      temperature: 0,
    });
    if (r.ok) return c.json({ ok: true, text: r.text.slice(0, 40), model: client.config.models.fast });
    return c.json({
      ok: false,
      failure: { kind: r.failure.kind, message: r.failure.message, retryable: r.failure.retryable },
      // 401 与 network 的处置完全不同，UI 靠 kind 给不同文案
      hint: r.failure.kind === 'no-key' ? '先在上面填一个 key 再测试'
        : r.failure.kind === 'http-401' || r.failure.kind === 'http-403' ? 'key 无效或没有权限'
          : r.failure.kind === 'network' || r.failure.kind === 'timeout' ? '连不上接口地址，检查 baseURL 与网络'
            : undefined,
    });
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

    const ALLOWED = new Set(['at', 'enabled', 'kind']);
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
