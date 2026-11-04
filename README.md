# 澄（cheng）

**自托管的私人 RSS 知识库。** 订阅自己进来，AI 先读一遍，值得读的留给你。

[![CI](https://github.com/nichen125/cheng-rss/actions/workflows/ci.yml/badge.svg)](https://github.com/nichen125/cheng-rss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24%20%3C25-brightgreen)](https://nodejs.org/)

它解决的是"订阅 200 个源，每天只能看 5 篇"这个具体问题，而不是再造一个 RSS 阅读器：

- **AI 先读** —— 入库即排队做摘要、要点、分类、分级。列表按重要性排，不是按时间
- **跨源聚合** —— 同一件事的多篇报道聚成"事件"，每日简报给出共识与分歧
- **单机优先** —— 一个 SQLite 文件、一个数据目录、一个可执行文件。没有外部依赖
- **不替你决定** —— 所有判断（重要度、分类）都可回退；AI 挂了，阅读功能全部正常

```
┌─────────────┬──────────────────────────────┬──────────────┐
│  订阅 / 分组  │       条目列表（按重要度）      │  正文 + 摘要   │
│             │                              │  + 要点 + 高亮  │
│  收件箱 12   │  ▎高  某公司发布 232 层闪存     │  ─────────    │
│  分组 3      │  ▎高  供应链受影响的三条线索     │  摘要：…       │
│  简报 ✓      │  ▏中  一次关于存储的访谈        │  要点：        │
│             │  ▏低  常规周报                  │   · 232 层     │
└─────────────┴──────────────────────────────┴──────────────┘
```

## 目录

- [为什么又做一个 RSS 阅读器](#为什么又做一个-rss-阅读器)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [配置](#配置)
- [AI 的成本](#ai-的成本)
- [数据与备份](#数据与备份)
- [文档](#文档)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可](#许可)

## 为什么又做一个 RSS 阅读器

现成的选择很多，但都差一步：

| 方案 | 差的那一步 |
|---|---|
| Feedly / Inoreader | 数据在别人服务器上，AI 功能要订阅，且不能自定提示词 |
| FreshRSS / Miniflux | 抓取与阅读做得好，**不读内容**。200 个源还是 200 个源 |
| Huntly | 阅读体验很好，但 AI 是"点一下总结这一篇"，没有跨源视角 |
| 自己写脚本 | 能跑，但三个月后没人维护 UI，也不再打开它 |

澄的判断是：**抓取与阅读是已经解决的问题，缺的是"进来的东西太多"的过滤层。**
所以它把 AI 放在入库路径上（而不是阅读动作上），让"今天该看什么"先被算出来。

## 快速开始

三种部署方式，任选其一。三种方式共用同一个数据目录格式，可随时互转。

### 方式一：Docker（推荐）

```bash
docker compose up -d
# 打开 http://127.0.0.1:3000
```

只挂 `./data`。镜像基于 `debian:bookworm-slim`（**不用 Alpine** —— Node SEA 不支持 musl）。

必须给一个 AI key，否则只有阅读功能：

```bash
AI_API_KEY=sk-xxx docker compose up -d
```

### 方式二：单文件二进制

```bash
# 从 Releases 下载对应平台，或自行构建：
./scripts/build.sh --sea
./dist/cheng-rss-linux-x64 serve --data ./data --port 3000
```

前端资源内嵌在二进制里，**不需要旁边的 `dist/` 目录**。复制一个文件即可运行。

### 方式三：源码运行（开发用）

需要 Node 24。**所有依赖与工具链都装在项目目录内**，不污染系统：

```bash
git clone https://github.com/nichen125/cheng-rss.git && cd cheng-rss

# Linux / macOS
./scripts/bootstrap.sh        # 下载项目内 Node 24（约 34MB，仅一次）
./scripts/build.sh            # 构建前端 + 服务端
./scripts/dev.sh              # 启动

# Windows PowerShell
.\scripts\bootstrap.ps1
.\scripts\build.ps1
.\scripts\dev.ps1
```

首次访问会引导创建管理员账号（单用户，无注册入口）。

## 核心概念

四个概念，读一遍就能用：

| 概念 | 是什么 | 为什么存在 |
|---|---|---|
| **条目（entry）** | 一篇文章 | 抓取、阅读、高亮的最小单位 |
| **事件（cluster）** | 同一件事的多篇报道 | "100 篇新闻其实只有 12 件事" |
| **分级（tier）** | 高 / 中 / 低 | 由 AI 的 importance 分数派生，决定列表排序 |
| **简报（digest）** | 每天的跨源综述 | 没时间读时只看它 |

**条目 → 事件**靠向量聚类：配了 embedding 走语义向量（阈值 0.80），没配则用本地字符
n-gram 指纹（阈值 0.35）。后者是能力边界而非 bug —— 同一件事如果连实体名和数字都换了
就聚不起来。详见 [docs/design.md](docs/design.md#聚类)。

**分级**只用于排序与筛选，任何一条的 AI 判断都可以在阅读页推翻（改分类、标已读、星标），
反馈会在下一轮分析时作为 few-shot 参考。

## 配置

配置分三层，**优先级从高到低**：环境变量 → `data/config.json` → 内置默认值。

> 注意一个容易踩的点：**模型名与预算不在环境变量里**，它们只认 `config.json`
> 和设置页。只有 `AI_API_KEY` 与 `AI_BASE_URL` 能从环境变量读 —— 因为这两个是
> 部署期最常换成私有网关的，而模型名是运行期可调的。（早期版本四层优先级没接通，
> 症状是"设了 `AI_BASE_URL` 却仍然打到默认服务商"，见 PLAN §8.7。）

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_API_KEY` | — | OpenAI 兼容的 key。不给我就只有阅读功能 |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | 换服务商或私有网关时改这里 |
| `PORT` | `3000` | 监听端口（也可用 `--port`） |
| `HOST` | `127.0.0.1` | 监听地址（也可用 `--host`）。局域网访问填 `0.0.0.0` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### config.json（模型与预算）

```json
{
  "ai": {
    "models": {
      "fast": "deepseek-chat",
      "strong": "deepseek-chat",
      "embed": "text-embedding-3-small"
    },
    "budget": { "dailyUsd": 1.0, "monthlyUsd": 20.0 }
  }
}
```

`embed` 留空或指向不存在的模型时，聚类自动退化为本地字符指纹（不花钱，但召回弱一些）。

### 界面

右下角齿轮 → 各分类，可以改上面**所有**项（含模型名与预算），也可以只填 AI key：
它存在 `data/secrets.json`（权限 600），**不进 `app.db`、不进备份包、不进导出**。
与 `AI_API_KEY` 同时存在时**文件优先** —— 它是用户显式填的那个。

界面上填的 key 不需要重启，分析队列下一轮就会用上。详细说明见
[docs/configuration.md](docs/configuration.md)。

## AI 的成本

**这部分值得先读，因为它决定你会不会一直开着 AI。**

一次"分析一篇"是两次调用（快模型粗筛 + 强模型写摘要），记为两条 `ai_usage`。
按 DeepSeek 定价，每天 100 篇新增约 **$0.01 ~ $0.03**。

控制成本有四个旋钮：

| 旋钮 | 位置 | 效果 |
|---|---|---|
| 每日预算 | 环境变量 / 设置页 | 超了降级到快模型，不中断分析 |
| 只分析重要源 | 源设置 | 每个源可单独关掉 AI |
| 快模型档位 | 设置页 | 用便宜模型做分类，只给高分条目写摘要 |
| 简报开关 | 设置页 | 简报是 N+1 次调用（每簇一次 + 一次生成） |

> **⚠️ 当前版本的 token 效率有已知问题**：实测单篇分析平均输入 1195 / 输出 976 tokens，
> 而产物只是一张卡片；`entities`、`sentiment` 两个字段没有任何界面在读。优化方案已列入
> 计划但**尚未实施** —— 见 [PLAN.md §9.7](PLAN.md)。在实施之前，成本就是上面这个数。

## 数据与备份

```
data/
├─ app.db          # 全部结构化数据（SQLite）
├─ secrets.json    # AI key（权限 600，不备份也行）
├─ config.json     # 配置
├─ files/          # 图片等附件
└─ backups/        # 自动快照
```

**只有 `data/` 需要备份。** 其余全部可重建。

备份要用 `VACUUM INTO` 而不是 `cp app.db` —— 后者在 WAL 模式下会拷到不一致的快照：

```bash
sqlite3 data/app.db "VACUUM INTO 'backup.db'"
```

正文以 gzip BLOB 存储（实测压缩 2.6×，占全库 84% 的体积）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/configuration.md](docs/configuration.md) | 全部配置项、AI 提供方、预算控制 |
| [docs/architecture.md](docs/architecture.md) | 模块划分、数据流、为什么这样选型 |
| [docs/design.md](docs/design.md) | 界面规格、正文提取、去重、聚类算法 |
| [docs/development.md](docs/development.md) | 本地开发、验收机制、调试技巧 |
| [PLAN.md](PLAN.md) | **完整的规格与决策记录**（5100 行，含每一步的取舍与踩过的坑） |

`PLAN.md` 是这个项目最特别的文件：它按"需求 → 规格 → 实现"三层记录每一步，
写清了每个决定的**替代方案与被否掉的原因**。想知道"为什么正文用 gzip 而不用 zstd"、
"为什么 FTS5 要配程序侧 bigram"，答案都在里面。

## 开发

```bash
./scripts/build.sh          # 构建
./scripts/verify-all.mjs    # 跑全部验收（56 个脚本、2046 条断言，约 13 分钟）
npm run typecheck:all       # 类型检查
```

验收机制与普通单测的区别：**每个断言都在真浏览器或真 SQLite 上跑，且断言的是产物而不是实现**。
例如"简报能生成"不是断言 `runDigest` 有返回值，而是查库里那一行有没有 `day_key`、
生成之后 `digestDue` 是否认为"今天已生成"。详见 [docs/development.md](docs/development.md)。

单独跑某个：

```bash
./.toolchain/node/node.exe scripts/verify-all.mjs m3      # 所有 m3 相关
./.toolchain/node/node.exe scripts/verify/m3-06-digest-chain.mjs
```

## 已知限制

| 限制 | 说明 |
|---|---|
| **Docker 镜像未在真机构建过** | 开发机没装 docker。Dockerfile 每条指令已逐条验证，也真的产出了能内嵌资源的 linux-x64 ELF，但 `docker build` 本身没跑过 |
| **不发布 macOS 二进制** | Node SEA 官方只测 arm64 |
| **SEA 不支持 Alpine** | 用 `debian:bookworm-slim` 替代 |
| **简报的误聚率需要真人验** | 自动部分只能验结构正确性（能聚、不误聚、引用不伪造），"这一簇是不是同一件事"只有人能判 |
| **`export` / `import` / `mcp` 子命令未实现** | 分别在 M6 / M6 / M5。执行会明确报"在 Mx 落地"而不是静默失败 |
| **AI 黄金测试集尚未建立** | 需要 20~30 篇人工标注跑一次真实模型作为回归基线 |
| **单用户** | 无多租户。`users` 表存在但只用于认证 |

v2.2 修掉的一个值得记住的缺陷：**简报功能在 55 个脚本全绿时其实从未成功生成过一次**
—— 四个缺陷叠在一起，而每个单看都对。根因与修复见 [PLAN.md §9.6](PLAN.md)。

## 从 ai-rss 升级

项目原名 `ai-rss`，v2.3 起全部改名为 `cheng-rss`。**改名不做向后兼容** ——
如果你已经在用旧版本，升级时这四处会失效，需要手动处理：

| 变化 | 影响 | 怎么修 |
|---|---|---|
| 环境变量 `AI_RSS_*` → `CHENG_RSS_*` | 部署脚本里的变量全部失效 | 逐项改名。最常设的是 `AI_RSS_DATA` → `CHENG_RSS_DATA` |
| Cookie 名 `ai_rss_sid` → `cheng_rss_sid` | **所有已登录会话掉线** | 重新登录一次。这是改 cookie 名必然的代价 |
| `localStorage` key `ai-rss.reader-prefs.v1` → `cheng-rss.reader-prefs.v1` | 阅读偏好（字号/宽度/主题）回到默认 | 在阅读页重设一次，或手动改浏览器 localStorage 的 key |
| 二进制名 `ai-rss-<platform>` → `cheng-rss-<platform>` | 启动脚本路径失效 | 改启动脚本里的路径 |
| Docker 服务名 / 容器名 / 镜像标签 | `docker compose` 会当成新服务 | 先 `docker compose down`，再改 `docker-compose.yml` 里的服务名，`up -d` |

**数据库文件名没变**（仍是 `data/app.db`），所以数据、订阅、历史、高亮都还在，
不需要迁移。`data/secrets.json` 也没变，AI key 不用重填。

## 许可

[MIT](LICENSE)
