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
    const base = runtimeAiBase(ctx.cfg);
    const raw = readAiConfigRaw(ctx.dbh.db, uid);
    const view = aiForUser(ctx.dbh.db, uid, base);

    return c.json({
      baseURL: view.config.baseURL,
      apiKeyEnv: view.config.apiKeyEnv,
      models: view.config.models,
      budget: view.config.budget,
      hasKey: view.hasKey,
      source: view.source,
      // 只有用户真覆盖过的字段才在这里列出来 —— 前端据此提示
      // "这几项不同于部署配置"，而不是把整套配置都摆出来
      overrides: Object.keys(raw).filter((k) => k !== 'apiKey'),
    });
  });

  r.patch('/settings/ai', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

    if ('apiKey' in body || 'api_key' in body) {
      throw badRequest(
        '不接受直接提交 API key。请把它写进环境变量 ' +
        '(默认 AI_API_KEY)，再在这里填写环境变量名。',
      );
    }

    // 只接受白名单内的键。放任任意键写进 ai_config 会让拼错的键名
    // 静默失效（用户以为改了模型，其实写成了 model.fast）。
    const ALLOWED = new Set(['baseURL', 'apiKeyEnv', 'models', 'limits', 'budget', 'fallback', 'timeoutMs']);
    const bad = Object.keys(body).filter((k) => !ALLOWED.has(k));
    if (bad.length > 0) {
      throw badRequest(`不认识的配置项: ${bad.join(', ')}。可改的是 ${[...ALLOWED].join(', ')}`);
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

  return r;
}
