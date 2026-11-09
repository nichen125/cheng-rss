# 澄（cheng）

**自托管的私人 RSS 知识库。** 订阅自己进来，AI 先读一遍，值得读的留给你。

[![CI](https://github.com/nichen125/cheng-rss/actions/workflows/ci.yml/badge.svg)](https://github.com/nichen125/cheng-rss/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nichen125/cheng-rss?include_prereleases&sort=semver)](https://github.com/nichen125/cheng-rss/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24%20%3C25-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org/)

---

## 目录

- [这是什么](#这是什么)
- [与其他阅读器的区别](#与其他阅读器的区别)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [配置](#配置)
- [AI 的成本](#ai-的成本)
- [数据与备份](#数据与备份)
- [使用中会遇到的边界](#使用中会遇到的边界)
- [参与开发](#参与开发)
- [社区](#社区)
- [灵感与致谢](#灵感与致谢)
- [许可](#许可)

---

## 这是什么

订阅 200 个源，每天只能看 5 篇 —— 这是 RSS 用户的共同困境。主流阅读器的答案
是「给你更快的收件箱」，而澄的答案是**先替你读完**：

- **AI 先读** —— 入库即排队做摘要、要点、分类、分级。列表按重要性排，不是按时间
- **跨源聚合** —— 同一件事的多篇报道聚成「事件」，每日简报给出共识与分歧
- **单机优先** —— 一个 SQLite 文件、一个数据目录、一个可执行文件，无外部依赖
- **不替你决定** —— 所有判断都可回退；没有 API key 时，阅读功能全部正常工作

三栏布局，左侧栏是**数据**而不是导航：

| 栏位     | 内容                                             |
| -------- | ------------------------------------------------ |
| 左：订阅 | 收件箱 / 未读 / 分组 / 单源 / 简报，每项带未读数 |
| 中：列表 | 条目按重要度排序，行首色条标出分级               |
| 右：正文 | 原文 + AI 摘要与要点 + 右侧目录 + 划词高亮       |

界面草图见 [docs/mockups/](docs/mockups/)，可直接在浏览器打开。

## 与其他阅读器的区别

| 方案                | 差的那一步                                              |
| ------------------- | ------------------------------------------------------- |
| Feedly / Inoreader  | 数据在别人服务器上，AI 功能要订阅，且不能自定义提示词   |
| FreshRSS / Miniflux | 抓取与阅读做得好，但**不读内容**。200 个源还是 200 个源 |
| Huntly              | 阅读体验很好，AI 是「点一下总结这一篇」，没有跨源视角   |
| 自己写脚本          | 能跑，但三个月后没人维护 UI，也就不再打开它             |

判断是：**抓取与阅读是已经解决的问题，缺的是「进来的东西太多」的过滤层。**
所以 AI 放在入库路径上（而非阅读动作上），让「今天该看什么」先被算出来。

## 快速开始

三种部署方式共用同一个数据目录格式，可随时互转。

### 方式一：Docker（推荐）

```bash
git clone https://github.com/nichen125/cheng-rss.git && cd cheng-rss
AI_API_KEY=sk-xxx docker compose up -d
# 打开 http://127.0.0.1:3000
```

只挂载 `./data`。镜像基于 `debian:bookworm-slim`（**不用 Alpine**，因为 Node SEA 不支持 musl）。

不给 `AI_API_KEY` 也能启动，只是没有摘要与分类 —— 之后可以在设置页补填。

### 方式二：单文件二进制

从 [Releases](https://github.com/nichen125/cheng-rss/releases) 下载对应平台的产物：

```bash
# Linux x64
chmod +x cheng-rss-linux-x64
./cheng-rss-linux-x64 migrate --data ./data
./cheng-rss-linux-x64 serve  --data ./data --port 3000

# Windows x64（PowerShell）
.\cheng-rss-win32-x64.exe migrate --data .\data
.\cheng-rss-win32-x64.exe serve  --data .\data --port 3000
```

也可以自行构建：

```bash
./scripts/build.sh --sea
./dist/cheng-rss-linux-x64 serve --data ./data --port 3000
```

前端资源内嵌在二进制里，**不需要旁边的 `dist/` 目录**。复制一个文件即可运行。
每个 Release 附带 `SHA256SUMS`，下载后可用 `sha256sum -c SHA256SUMS` 校验。

### 方式三：源码运行（开发用）

需要 Node 24。**所有依赖与工具链都装在项目目录内**，不污染系统。

```bash
git clone https://github.com/nichen125/cheng-rss.git && cd cheng-rss

# Linux / macOS
./scripts/bootstrap.sh        # 下载项目内 Node 24（仅一次）
./scripts/build.sh            # 构建前端 + 服务端
./scripts/dev.sh              # 启动

# Windows PowerShell
.\scripts\bootstrap.ps1
.\scripts\build.ps1
.\scripts\dev.ps1
```

首次访问会引导创建管理员账号（单用户，无注册入口）。

## 核心概念

| 概念                | 是什么             | 为什么存在                                 |
| ------------------- | ------------------ | ------------------------------------------ |
| **条目**（entry）   | 一篇文章           | 抓取、阅读、高亮的最小单位                 |
| **事件**（cluster） | 同一件事的多篇报道 | 「100 篇新闻其实只有 12 件事」             |
| **分级**（tier）    | 高 / 中 / 低       | 由 AI 的 importance 分数派生，决定列表排序 |
| **简报**（digest）  | 每天的跨源综述     | 没时间读时只看它                           |

**条目 → 事件**靠向量聚类：配了 embedding 走语义向量（阈值 0.80），没配则退化为本地
字符 n-gram 指纹（阈值 0.35）。后者是能力边界而非缺陷 —— 同一件事如果连实体名和数字
都换了就聚不起来。详见 [docs/design.md#聚类](docs/design.md#聚类)。

**分级**只用于排序与筛选。任何一条的 AI 判断都可以在阅读页推翻，反馈会在下一轮分析
时作为 few-shot 参考。

## 配置

配置分三层，**优先级从高到低**：环境变量 → `data/config.json` → 内置默认值。

> **模型名与预算不在环境变量里**，只认 `config.json` 和设置页。只有 `AI_API_KEY` 与
> `AI_BASE_URL` 能从环境变量读 —— 这两个是部署期最常换成私有网关的，而模型名是运行期
> 可调的。

### 环境变量

| 变量          | 默认                          | 说明                                                |
| ------------- | ----------------------------- | --------------------------------------------------- |
| `AI_API_KEY`  | —                             | OpenAI 兼容的 key。不提供则只有阅读功能             |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | 换服务商或私有网关时改这里                          |
| `PORT`        | `3000`                        | 监听端口（也可用 `--port`）                         |
| `HOST`        | `127.0.0.1`                   | 监听地址（也可用 `--host`）。局域网访问填 `0.0.0.0` |
| `LOG_LEVEL`   | `info`                        | `debug` / `info` / `warn` / `error`                 |

### config.json

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

`embed` 留空或指向不存在的模型时，聚类自动退化为本地字符指纹（不花钱，召回弱一些）。

### 设置页

右下角齿轮 → 各分类，可以改上面**所有**项。也可以只填 AI key：它存在
`data/secrets.json`（权限 600），**不进 `app.db`、不进备份包、不进导出**。与
`AI_API_KEY` 同时存在时**文件优先** —— 它是用户显式填的那个。

界面上填的 key 不需要重启，分析队列下一轮就会用上。完整说明见
[docs/configuration.md](docs/configuration.md)。

## AI 的成本

**这部分值得先读，因为它决定你会不会一直开着 AI。**

配置 AI 之后需要先确认连通：设置页 →「AI 分析」→「测试连接」。可正常工作的配置应该
在 1~3 秒内返回成功。

**如果"测试连接"过了、分析却一篇都不成**，那是另一个问题：key 通只说明鉴权没问题，
不说明这个网关支持结构化输出。用同一张卡上的**「开始自检」**——它按顺序跑八步
（key / 地址与模型清单 / 文本对话 / system 角色 / 结构化输出档位 / 向量模型 /
真实分析一篇 / 真实总结一篇），每步给出结论、耗时、token 与花费，某步不通过会直接
写"该怎么办"。整份结果落库，刷新后仍在，也可以复制成 Markdown。

自检测出的网关能力会记下来反哺客户端：比如网关忽略 `response_format`，客户端就
直接从纯文本档开始，不再为每篇文章各撞一次墙。同一个中转的行为会变（我们实测过
三天之内 `system` 从被丢变成被转发），所以结论按"上次自检"算，而不是写死在代码里。

旁边还有**「测试模型速度」**：一次测出连通性、首字（思考首字与正文首字分开报）、
总耗时与输出速度，每个模型跑三次取中位数。它只用于测速，不接进分析与总结。

一次「分析一篇」是两次调用（快模型粗筛 + 强模型写摘要），记为两条 `ai_usage`。
按 DeepSeek 定价，每天 100 篇新增约 **$0.01 ~ $0.03**。

控制成本有四个旋钮：

| 旋钮     | 位置              | 效果                                     |
| -------- | ----------------- | ---------------------------------------- |
| 每日预算 | 环境变量 / 设置页 | 超了降级到快模型，不中断分析             |
| 模型档位 | 设置页            | 用便宜模型做分类，只给高分条目写摘要     |
| 简报开关 | 设置页            | 简报是 N+1 次调用（每簇一次 + 一次生成） |
| 抓取频率 | 源设置            | 抓得越慢新增条目越少，分析量随之下降     |

> **token 效率有已知问题。** 单篇分析的输入远大于产物所需 —— 产出的只是一张卡片，
> 而请求里还带着 `entities`、`sentiment` 两个没有任何界面在读的字段。优化方案已列入
> 计划但**尚未实施**，见 [PLAN.md §9.7](PLAN.md)。在实施之前，成本就是上面这个量级。
> （v2.7 只解决了这条路的一半：这两个字段缺失不再判死一篇，也不再为格式问题反复重发
> 整篇正文；但提示词里仍然在要它们。）

**推理模型的额外成本**：如果用的是推理模型（如 `deepseek-flash`），思考过程也计费 ——
预算要留得比非推理模型宽一些。

## 数据与备份

```
data/
├─ app.db          # 全部结构化数据（SQLite）
├─ secrets.json    # AI key（权限 600，不备份也行）
├─ config.json     # 配置
├─ files/          # 图片等附件
└─ backups/        # 自动快照
```

**只有 `data/` 需要备份**，其余全部可重建。

备份要用 `VACUUM INTO` 而不是 `cp app.db` —— 后者在 WAL 模式下会拷到不一致的快照：

```bash
sqlite3 data/app.db "VACUUM INTO 'backup.db'"
```

正文以 gzip BLOB 存储（实测压缩 2.6×，占全库 84% 的体积）。

## 使用中会遇到的边界

这些是能力边界或刻意取舍，不是缺陷。写在这里是为了让你在踩到时不困惑。

### 部署

| 边界                       | 说明                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| 只发布 Linux / Windows x64 | Node SEA 未测试 macOS，Alpine 不支持 musl。其他平台请用源码方式运行 |
| 不支持 Alpine              | 用 `debian:bookworm-slim` 替代（Node SEA 不支持 musl）              |
| 单用户                     | 无多租户。`users` 表存在但只用于认证                                |

### 功能

| 边界                                     | 说明                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `export` / `import` / `mcp` 子命令未实现 | 分别在 M6 / M6 / M5，执行时明确报「在 Mx 落地」。**备份目前只能直接拷贝 `data/`** |
| Huntly 插件仅认证兼容                    | 存页接口未实现，插件还不能真正存页进去。见[灵感与致谢](#灵感与致谢)               |
| 无 embedding 模型时聚类召回受限          | 退化为字符指纹。同一件事若连实体名和数字都换了就聚不起来                          |

### 质量

| 边界                   | 说明                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| 简报的误聚率需要真人验 | 自动部分只能验结构正确性（能聚、不误聚、引用不伪造），「这一簇是不是同一件事」只有人能判 |
| AI 黄金测试集尚未建立  | 需要 20~30 篇人工标注跑一次真实模型作为回归基线                                          |

## 参与开发

```bash
./scripts/build.sh          # 构建
./scripts/verify-all.mjs    # 跑全部验收
npm run typecheck:all       # 类型检查
```

验收机制与普通单测的区别：**每个断言都在真浏览器或真 SQLite 上跑，且断言的是产物而
不是实现**。例如「简报能生成」不是断言 `runDigest` 有返回值，而是查库里那一行有没有
`day_key`、生成之后 `digestDue` 是否认为「今天已生成」。

详细流程、写断言的规矩、调试技巧见 [docs/development.md](docs/development.md)。

CI 挂在打标签上：推送 `v*` tag 会同时在 Ubuntu 与 Windows 上跑一遍验收，任一红即
中止发布；随后产出两个平台的二进制与 Docker 镜像，附 `SHA256SUMS`。
日常提交不触发 CI —— 先在本地跑绿，发版时让 CI 再确认一次。
细节见 [PLAN.md §16](PLAN.md)。

### 文档

| 文档                                           | 内容                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| [docs/configuration.md](docs/configuration.md) | 全部配置项、AI 提供方、预算控制、排查          |
| [docs/architecture.md](docs/architecture.md)   | 模块划分、数据流、选型与放弃的方案             |
| [docs/design.md](docs/design.md)               | 界面规格、正文提取、去重、聚类、引用安全       |
| [docs/development.md](docs/development.md)     | 本地开发、验收机制、写断言的规矩               |
| [docs/specs/](docs/specs/)                     | 顶层设计方案（界面视觉规格、配色与控件尺度）   |
| [PLAN.md](PLAN.md)                             | 完整的规格与决策记录，含每一步的取舍与踩过的坑 |

`PLAN.md` 是这个项目最特别的文件：按「需求 → 规格 → 实现」三层记录每一步，写清了每个
决定的**替代方案与被否掉的原因**。想知道「为什么正文用 gzip 而不用 zstd」、「为什么 FTS5
要配程序侧 bigram」，答案都在里面。

`docs/specs/` 只放**跨模块的顶层方案**。单个功能的实施细节不单独成文，直接落进 PLAN 的
对应章节 —— 那种文档写完就被代码取代，留下来只会与代码不符却仍被当成规格。

## 社区

- **问题与建议**：[GitHub Issues](https://github.com/nichen125/cheng-rss/issues)
- **安全问题**：请不要开公开 issue，直接发邮件到作者邮箱（见 git 提交记录）
- **贡献**：欢迎 PR。提交前请确保 `typecheck:all` 干净、验收全绿

## 灵感与致谢

阅读体验对标 [Huntly](https://github.com/lcomplete/huntly) —— 一个优秀的自托管信息
管理工具，「阅读器 + 浏览器插件」这套组合是澄的起点。借鉴了两处：**侧栏即数据**
（收件箱 / 分组 / 单源都是带未读计数的筛选，不是导航层级）、**三栏 + 阅读历史**。
感谢 [@lcomplete](https://github.com/lcomplete) 与 Huntly 的所有贡献者。

Huntly 的浏览器插件目前**只能连上澄、登录、读到当前用户**，核心存页接口
`POST /api/page/save` 尚未实现，所以还存不进去。端点清单与计划见
[PLAN.md §14](PLAN.md)。

## 许可

[MIT](LICENSE)

---

如果这个项目对你有用，欢迎点一个 ⭐ —— 这是对个人项目最实际的鼓励。
