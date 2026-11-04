# 架构

## 一句话

**一个 Node 进程 + 一个 SQLite 文件。** 没有 Redis、没有消息队列、没有外部服务。
前端是静态资源（构建后内嵌进二进制），后端是 Hono 的 `Request → Response` 函数。

```
┌────────────────────────────────────────────────────────────────┐
│                        单个 Node 进程                            │
│                                                                │
│  ┌──────────┐   ┌───────────────┐   ┌────────────────────┐    │
│  │  Hono    │──▶│   routes/     │──▶│  业务模块           │    │
│  │  (HTTP)  │   │  7 个路由组    │   │  feeds / extract   │    │
│  └──────────┘   └───────────────┘   │  dedupe / ai       │    │
│       ▲                             │  cluster / digest  │    │
│       │ 静态资源                      │  search / highlights│   │
│  ┌──────────┐                       └────────────────────┘    │
│  │ React 19 │                                │                 │
│  │ (内嵌)    │                                ▼                 │
│  └──────────┘                       ┌────────────────────┐    │
│                                     │  node:sqlite       │    │
│  ┌──────────────────────────┐       │  data/app.db       │    │
│  │ 内联 job runner           │──────▶│  (WAL)            │    │
│  │ (与 HTTP 同进程)          │       └────────────────────┘    │
│  └──────────────────────────┘                                 │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼  HTTPS
                    OpenAI 兼容的 AI 服务
```

## 模块划分

```
src/
├─ index.ts              入口：解析子命令
├─ cli.ts                serve / migrate / doctor / version
├─ server/
│  ├─ app.ts             组装 AppContext（cfg + db + 版本）
│  ├─ config.ts          三层配置解析
│  ├─ routes/            7 个路由组（HTTP 边界）
│  ├─ feeds/             订阅源：解析 RSS/Atom/RDF、OPML、自动发现
│  ├─ extract/           正文提取（Readability + linkedom）
│  ├─ dedupe/            去重：SimHash + 余弦向量
│  ├─ ai/                AI 客户端、提示词、schema、用量记账
│  ├─ cluster/           事件聚类 + 逐簇归约
│  ├─ digest/            每日简报：调度、生成、渲染
│  ├─ search/            FTS5 + 程序侧 bigram
│  ├─ highlights/        划词高亮（三选择器降级）
│  ├─ jobs/              任务队列（SQLite 表 + 内联 runner）
│  └─ db/                连接、迁移、schema
└─ client/               React 19（无路由库，一个 useReducer 管视图）
```

## 关键数据流

### 一条 RSS 进来之后

```
fetch_feed job
    │
    ├─ 条件请求（ETag / Last-Modified）→ 304 就结束
    │
    ├─ 逐条：解析 → URL 规范化 → 去重
    │         │                │
    │         │                └─ SimHash 近似判重（跨源同一篇）
    │         │
    │         └─ 入 entries 表，stage = 'new'
    │
    └─ 为每条入 analyze job

analyze job
    │
    ├─ 无正文 → 先入 extract job，等正文就绪
    │
    ├─ AI 粗筛（fast 模型）→ importance / category / novelty
    ├─ AI 写摘要（strong 模型，仅高分的）→ summary / key_points
    ├─ 向量化 → entry_vectors（配了 embed 模型）或字符指纹
    └─ 回写 entry_analysis，stage = 'done'

digest job（每天定时）
    │
    ├─ 取最近 24h 的向量 → 余弦聚类
    ├─ 每簇一次 AI 归纳 → cluster_summaries（含共识/分歧）
    ├─ 一次 AI 写正文 → 只能写 {{cite:cl_x}}，URL 一律抹除
    └─ 落 digests 表（含 cites 快照）
```

### 为什么 AI 在入库路径上而不是阅读动作上

这是整个项目最重要的一个决定。两种做法都可行：

| 做法 | 优点 | 缺点 |
|---|---|---|
| **入库即分析**（本项目的选择） | 列表能按重要性排序；简报有素材；打开即读 | 会分析没人看的文章 |
| 打开才分析 | 零浪费 | 列表只能按时间排，**"今天该看什么"这个核心问题没解** |

选了前者，因为产品要解决的是"进来的太多"，而"打开才分析"回答不了这个问题。
代价（分析没人看的文章）用预算闸门与分级来控制，而不是靠推迟分析。

> 这个取舍有明确的优化空间（PLAN §9.7 的 P1「先判后写」）：先用便宜模型判，
> 只有用户真打开时才写摘要。等 token 效率优化落地后会重新评估。

## 技术选型与放弃的方案

### Node 24，不是 Bun

| 需求 | Node 24 | Bun |
|---|---|---|
| 内置 SQLite | `node:sqlite` 标准库 | 内置 |
| 单文件二进制 | SEA（官方） | `bun build --compile` |
| 长期支持 | LTS 承诺 | 无 LTS |

决定性的是 `node:sqlite`：它让项目**零原生插件**，`npm ci` 在任何平台都能装完
（`better-sqlite3` 需要编译工具链，在 NAS 的 ARM 容器里经常失败）。

### Drizzle ORM 的 `1.0.0-rc.5`，不是稳定版

因为**稳定版 `0.45.x` 没有 `node-sqlite` 驱动**。这是个被迫的版本选择，
所以 ORM 只用于类型推导与 `dbstat` 之类的查询，**迁移全部手写 SQL**
（`src/server/db/migrations/*.sql`）—— 不把建表逻辑托付给 RC 版本。

### Hono，不是 Next.js / Express

SEA 打包要求"整个应用能被 esbuild 打成一个文件"。Hono 是纯
`Request → Response` 函数，没有隐式的文件系统约定、没有运行时代码生成。
Next.js 的 `standalone` 输出仍然依赖多级目录结构，内嵌进二进制很别扭。

### FTS5 + 程序侧 bigram，不是内置 trigram

SQLite 的 `trigram` tokenizer **查不到 2 个汉字的中文词**（实测返回 0 条）：
它按 3 字符滑窗建索引，而"芯片"只有 2 个字。改用 FTS5 默认 tokenizer +
在程序侧把中文切成 bigram 再入库，查询时同样切成 bigram。

### 正文用 gzip BLOB，不是 TEXT 列、不是 zstd

- **不是 TEXT**：正文占全库体积的 **84%**，且高度可压缩（实测 2.6×）
- **不是 zstd**：需要原生库或 WASM；`node:zlib` 的 gzip 是标准库，
  而 SEA 里能用标准库解决的绝不引第三方

存进 `entry_contents.html` 的是自定义标记格式的 BLOB（不是裸 gzip），
这样"是否已压缩"可判别，读写都走 `packText` / `unpackText` 一对函数。

### SEA + `assets` + fflate，不是 `vfsArchive`

Node 24 的 SEA **没有** `vfsArchive`（Node 26 才有）。所以前端产物被打成
一个 zip 用 fflate 在内存里解压 —— 它在 SEA 里能跑，因为是纯 JS。

## 数据库

25 张表，8 个迁移。核心几张：

| 表 | 作用 | 值得注意的列 |
|---|---|---|
| `entries` | 文章条目 | `url_norm`（规范化 URL，唯一键的一部分）、`stage`（处理阶段） |
| `entry_contents` | 正文 | `html` 是 gzip BLOB，不在 `entries` 上 |
| `entry_analysis` | AI 产物 | `source_hash`（正文变了才重算）、`prompt_version` |
| `entry_vectors` | 向量 | `vec` 是 `Float32Array` 的 BLOB，`dim` 单独存 |
| `clusters` / `cluster_summaries` | 事件 | `member_ids` 是 JSON 数组 |
| `digests` | 简报 | `day_key`（本地日 00:00，唯一索引的一部分）、`cites`（引用快照） |
| `ai_usage` | 成本记账 | 每次**请求**一行，不是每次分析一行 |
| `jobs` | 任务队列 | `dedupe_key`（同键任务不会重复入队） |

### 迁移的写法

新增迁移要改三处，少一处会静默失败：

1. 新文件 `src/server/db/migrations/000N_name.sql`
2. `src/server/db/migrate.ts` 的 `MIGRATIONS[]` 数组加一项
3. `src/server/db/migration-sql.ts` 加 `declare const __SQL_000N_NAME__` 与
   对应的 `case`（esbuild 会把 `.sql` 打成字符串常量注入）

第 3 步容易漏，因为开发时读文件系统的路径能跑通，只有打 SEA 之后才炸。

### 为什么迁移 SQL 要内嵌

SEA 二进制是单文件，运行时不保证旁边有 `migrations/` 目录。
所以构建期用 esbuild 的 `loader: { '.sql': 'text' }` 把 SQL 变成字符串常量，
`bundledSqlFor()` 按文件名取。`scripts/build-server.mjs` 里有自动 `define`。

## 任务队列

`jobs` 表 + 同进程的 runner。**没有外部 broker**，因为单用户自托管不需要。

| 特性 | 实现 |
|---|---|
| 去重 | `dedupe_key` 唯一索引，同键重复入队是空操作 |
| 重试 | `attempts` / `max_attempts`，指数退避 |
| 崩溃恢复 | 进程重启时把 `running` 的任务放回 `queued` |
| 类型 | `fetch_feed` / `extract` / `analyze` / `digest` |

**`maxAttempts` 因任务类型而异**：`analyze` 允许重试（可能是网络抖动），
`digest` 是 `maxAttempts: 1`（因为它自己有 `digest_attempts` 的退避表，
两层重试叠加会把配额在 30 秒内烧光）。

## 安全边界

| 面 | 处理 |
|---|---|
| 认证 | 单用户，cookie session（`HttpOnly` + `SameSite=Lax`），首次访问引导创建管理员 |
| 越权 | 所有查询带 `user_id` 条件；别人的资源返回 **404 而不是 403**（不泄露"存在"） |
| XSS | 模型输出走自写的极简 Markdown → React 节点，**不用 `dangerouslySetInnerHTML`** |
| 提示注入 | 抓来的正文当数据处理，不当指令；模型只能输出 `{{cite:cl_x}}` |
| 伪造引用 | 模型写的裸 URL **一律抹除**（"链接已移除"）——校验 URL 合法性挡不住"链接是真的但指向的不是这件事" |
| Key 泄露 | 只在 `secrets.json`（600），响应里只有掩码，不进 db/备份/导出 |

## 单进程的边界

没有队列服务、没有多 worker，意味着：

- **单机上限**是 SQLite 的写入吞吐（WAL 模式下并发写会串行化）
- 抓取与 AI 分析在同一个事件循环里，重活会让 HTTP 响应变慢 —— 所以
  抓取是分批的，每批之间有间隔
- **不能水平扩展**。这是为"个人知识库"这个场景做的取舍：
  换水平扩展能力会同时换来部署复杂度，而那正是自托管用户想避免的

需要多用户或高并发时应fork 而不是加机器 —— 那时数据模型（所有查询带 `user_id`）
已经准备好了。
