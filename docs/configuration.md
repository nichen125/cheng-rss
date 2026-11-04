# 配置

配置分三层，**优先级从高到低**：

```
环境变量  →  data/config.json  →  内置默认值
                                      ↑
                            设置页写入也落在这里
```

## 一个容易踩的坑：为什么模型名不在环境变量里

只有 `AI_API_KEY` 与 `AI_BASE_URL` 能从环境变量读，模型名与预算**只认**
`config.json` 和设置页。这是刻意的不对称：

- `AI_API_KEY` / `AI_BASE_URL` 是**部署期**决定的（换服务商、接私有网关），
  适合在 `docker-compose.yml` 或 systemd unit 里写死，不该进 git
- 模型名与预算是**运行期**可调的（这个月想省点钱、想试试新模型），
  每次都要改环境变量 + 重启容器，成本远高于收益

早期版本这里出过 bug：四层优先级里缺了一层，症状是"设了 `AI_BASE_URL`
却仍然打到默认服务商"。修复记录见 PLAN §8.7。

## 完整配置项

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_API_KEY` | — | OpenAI 兼容的 API key。**不配置则只有阅读功能**，见下文"没有 key 时" |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | 接口地址。必须包含 `/v1`（或服务商要求的版本段） |
| `PORT` | `3000` | 监听端口。等价于 `--port` |
| `HOST` | `127.0.0.1` | 监听地址。局域网/公网访问填 `0.0.0.0`，等价于 `--host` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### config.json

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "adminEmail": "admin@localhost",
  "logLevel": "info",
  "sessionDays": 30,
  "ai": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "AI_API_KEY",
    "models": {
      "fast": "deepseek-chat",
      "strong": "deepseek-chat",
      "embed": "text-embedding-3-small"
    },
    "budget": {
      "dailyUsd": 1.0,
      "monthlyUsd": 20.0
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `ai.apiKeyEnv` | **存的是环境变量名，不是 key 本身**。改这个值可以把 key 放在别的变量里 |
| `ai.models.fast` | 粗筛用的便宜模型。分级、分类走它 |
| `ai.models.strong` | 摘要、单篇总结、简报走它 |
| `ai.models.embed` | 向量化模型。**留空则聚类退化为本地字符指纹**（不花钱，召回弱） |
| `ai.budget.dailyUsd` | 每日上限。`0` = 不限 |
| `ai.budget.monthlyUsd` | 每月上限。`0` = 不限。超了暂停到月初 |

`config.json` 不存在时会用默认值，**不会自动创建** —— 创建时机由 `serve` 负责，
这样 `doctor` 之类的只读命令不会改动磁盘（PLAN §4.3）。

## AI key 的两种给法

### 方式一：环境变量（Docker / NAS 推荐）

```bash
AI_API_KEY=sk-xxx docker compose up -d
```

适合容器化部署。缺点是换 key 要重启容器。

### 方式二：界面填写（单机日常推荐）

右下角齿轮 → **AI 分析** → **API Key** 卡 → 填 key → 保存 → 测试连接。

存在 `data/secrets.json`（POSIX 600 / Windows 仅当前用户）：

```json
{ "aiApiKey": "sk-...", "updatedAt": "2026-11-04T01:16:00.000Z" }
```

**它不进 `app.db`、不进备份包、不进导出、不进 git。** 这是刻意的：
key 是唯一"丢了要重新申请"的东西，不该跟着数据一起流转。

两者同时存在时**文件优先** —— 因为文件里的那个是用户显式填的，
而环境变量可能是忘了删的旧值。

界面填的 key **不需要重启**：`aiForUser()` 每轮都会重读，队列下一轮就用上了。

## 没有 key 时会发生什么

**其余功能全部正常**，只是不产出摘要与分类。具体行为：

- 启动横幅写**一次**「未配置 API key，N 篇待分析」
- 设置页常驻显示状态与填写入口
- 待分析条目**不会被标成 `failed`** —— 它们只是排队等 key，填上之后自动开始
- **不会逐篇刷日志**：全局性失败按模板限速，同类日志每 60 秒最多 3 条，
  超出的折叠成「另有 N 条同类已折叠」

最后一条是为了修一个真实症状：1000 个源同时抓取失败时，日志能刷满几个屏幕，
真错误被淹没。限速器按"模板"归类（把数字归一化，`745 篇` ≡ `3 篇`），
但**不归一引号内容** —— 否则 `no-key` 和 `http-500` 会被算成同一类。

## 预算控制

两道门，作用不同：

| 门 | 触发 | 行为 |
|---|---|---|
| 每日预算 | 今日花费 > `dailyUsd` | **降级**到快模型继续分析，不中断 |
| 每月预算 | 本月花费 > `monthlyUsd` | **暂停**分析，到月初自动恢复 |

阅读、抓取、简报的**调度**不受影响（简报本身会因无分析而生成不出内容）。

设置页顶部有一条状态横幅，用颜色区分三档：正常 / 降级 / 暂停，
并写明**原因**（"今日已花 $1.02，超过 $1.00 上限"而不是干巴巴的"预算超限"）。

## 换 AI 服务商

任何 OpenAI 兼容的服务都可以。改两个值：

```bash
AI_BASE_URL=https://your-provider.com/v1
```

然后在设置页或 `config.json` 里改模型名。已验证的：

| 服务商 | baseURL | 备注 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | 默认。便宜，中文好 |
| OpenAI | `https://api.openai.com/v1` | key 格式相同 |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | 需要支持 JSON 结构化输出，见下 |

### 对模型的要求

澄依赖**结构化输出**（JSON schema）。模型必须能满足其一：

1. 支持 `response_format: { type: "json_object" }`
2. 即使不要求也能稳定输出纯 JSON（不能有 ``` 围栏、不能有前后解释）

客户端有三级降级链：`json_schema` → `json_object` → 纯文本 + 抽取 JSON。
三级都失败的调用会被记录成 `schema` / `bad-json` / `empty` 三类错误，
可在 `ai_usage` 表里查到。

> **小模型可能反复失败。** 实测某些小模型会稳定地失败在同一处
> （最常见是 `entities` 字段返回数组而非对象）。这种情况下换更大的模型，
> 而不是加大重试次数 —— 重试烧的是同样的 token。

## 排查

```bash
# 看配置是否被正确读到（只读，不改动磁盘）
./cheng-rss doctor

# 输出 JSON（给监控/脚本用）
./cheng-rss doctor --json

# 看今天的 AI 调用与花费
sqlite3 data/app.db "SELECT purpose, COUNT(*), SUM(cost_usd)
  FROM ai_usage WHERE created_at > strftime('%s','now','start of day')*1000
  GROUP BY purpose"
```

`doctor` 实际检查这些项（`fatal` 的失败会让退出码非 0）：

| 检查项 | 失败含义 |
|---|---|
| 数据目录可写 | 权限问题，`fatal` |
| 数据库存在 | 尚未 `migrate`，不算错误 |
| schema 版本可接受 | 库比程序新或旧，`fatal` |
| `journal_mode = WAL` | 并发写会退化 |
| `integrity_check` | 库损坏 |
| 最近备份 < 48h | 提醒该备份了 |
| 正文占比 < 90% | 正文膨胀，提醒跑 `VACUUM` |
| 数据目录不在系统区 | 数据写到了 `/tmp` 之类的位置 |

`doctor` **不检查 AI key**，也**不回显任何 key** —— 需要确认 key 状态请看
设置页的「AI 分析」，或 `sqlite3 data/app.db "SELECT ... FROM ai_usage"` 看最近调用是否成功。
