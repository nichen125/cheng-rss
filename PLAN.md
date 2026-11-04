# AI RSS 阅读分析器 —— 需求与实现方案

> 一个自托管的在线 RSS 处理工具：阅读体验对齐 Huntly，并在此之上提供自动化的 AI 整理分析（分类分级、每日简报、跨篇聚合）。
>
> 支持二进制 / 源码 / Docker 三种部署，单个数据目录即可备份迁移。
>
> 版本 **v2.1**｜状态：M0 全部 10 步完成（含 0.10 资源预算）；M1 全部 27 步完成（含 1.26 未分组平铺、1.27 分组与源的排序）；**M2 全部 7 步完成**（含 2.6 key 界面填写与 2.7 单篇总结）；**M3 全部 4 步完成**（178 条断言）；**M4 全部 4 步完成**（146 条断言）；**3.5 简报页完成**（43 条断言）；共 **55 个验收脚本、2030 条断言全绿**；v1.13 追加 1.18 侧栏分组树与 1.19 三栏密度；v1.14 放宽正文宽度与阅读区留白；v1.15 追加 1.20 阅读区边缘与侧边目录；v1.16 追加 1.21 默认只看未读；v1.17 追加 1.22 未读清零后的落点、1.23 分组/单源未读清零、1.24 标题行对齐、1.25 瞬时失败不判死，并修 §7.5 的 pending 脱钩；v1.18 推翻 1.22 的落点方案（改成列表内分割线补已读）、修「切分组仍停在全部」；v1.19 落 M2 的 2.1~2.2（新增 §8.6 客户端实现与失败分类）；v1.20 落 M2 的 2.3~2.5（新增 §8.7 预算闸门的两道门与三层配置）、AI 配置页从占位改成真页面；v1.21 落 M3 的 3.1~3.3（新增 §9.4 聚类与引用安全的设计取舍）；v1.22 落 3.4 定时生成（新增 §9.5 三种否决与 day_key 的由来）；v1.23 落 M4 全部 4 步高亮（新增 §11.1b 锚定的四个实现决定、§19.5b M4 判据表、§11.4 联动三项落地/两项推后到 M5）；v1.24 补 3.5 简报页（§15.4 落地，修掉一条"生成了没人看得见"的断点；§15.7 移动端 tab 5→6 属规格变更）；**v2.0 需求层新增四项**（24 key 可在界面填、25 未分组源平铺侧栏、26 单篇总结+提示词可编辑、27 资源与性能预算），对应步骤 2.6 / 1.26 / 2.7 / 0.10 与 §5.7、§8.8、§8.9、§15.26、§15.27，**四项均已落地**；**v2.1 需求层新增第 28 行**（分组与源可排序：侧栏长按进排列模式拖/点 ↑↓，源可拖进拖出分组，跨组给可撤销提示；配置 › 分组另有一路常显 ↑↓，因为手机上侧栏是 display:none），对应步骤 1.27 与 §15.28，**已落地，57 条断言**；同轮把 §15.26 的「未分组排在最末」改为「排在最前」｜22 章

---

## 文档效力声明

**这份文档是本项目的需求来源与验收标准。**

它的效力**只作用于"做什么"，不作用于"每个细节怎么做"**。本文档是需求表，不可能穷举实现细节；凡是文档没有写到的地方，实现者可以自行决定并落地，只要不与已写明的需求冲突（判定方法见下）。

两条边界先划清：

| 文档管 | 文档不管 |
|---|---|
| 交付什么功能、不做什么 | 变量名、函数拆分、文件内部的模块划分 |
| 表结构、检索方案、备份策略、API 形状 | 日志措辞、错误文案、注释风格 |
| 性能红线、部署矩阵、验收判据 | 用了哪个小工具、代码里的具体算法写法 |
| 界面要什么、不要什么 | 组件的内部实现、CSS 类名组织 |

### 需求层 / 规格层 / 实现层

三层权力不同，改之前先判断自己在哪一层：

| 层 | 范围 | 谁能决定 | 改动后果 |
|---|---|---|---|
| **需求层** | §1.1 功能表、§1.2 约束与排除项 | **只有需求方**（A.1.1） | 升 v2.0，重估工期 |
| **规格层** | §5~§17 写明的机制：表结构、检索、备份、AI 流水线、插件兼容、UI 原则、里程碑判据 | 实现者可调整，但**必须先改文档**再改代码 | v1.x，同步验收脚本 |
| **实现层** | 文档未提及的一切 | **实现者自由决定** | 不需记录，不需确认 |

**判断自己该不该自己决定的三个问题**（按顺序问，任何一个答"是"就得往上一层走）：

1. **会改变用户看到的东西吗？** —— UI 布局、交互流程、返回给用户的文案 → 是则属规格层（可能是需求层）。
2. **改起来贵吗？** —— 涉及历史数据格式、已发布 API 形状、数据库结构 → 是则属规格层，必须先写进文档，否则将来返工没人知道为什么这么设计。
3. **和文档写明的某一条冲突吗？** —— 冲突则一律不许自行决定，先改文档。

三个都答"否"，就直接做。典型例子：内部函数的拆分方式、某个 service 里的缓存策略、日志级别、错误码的命名、CSS 类怎么组织。这些写进文档只是噪音。

**这套分层的目的是"该记的别丢"，不是"什么都要记"。** 过度记录会让实现变慢，且让文档变得没人愿意读 —— 一份 5000 行、一半是"我把函数从 A 拆成了 B"的文档，比一份简短的文档更不可靠。记的分界是：**将来有人会因为不知道这个而做错事**。

### 缺口填补规则

文档沉默处，允许实现者自行落地。但缺口填补要**留痕**：

- **可逆成本低**（只影响本次实现）→ 不记录，直接做。
- **可逆成本高但用户不可见**（如内部表索引怎么加、缓存失效策略）→ 记进**附录 B 实现决策记录**，一句话说明选了什么、为什么。
- **会影响用户 / 影响未来兼容** → 不进附录，直接走规格层或需求层。

附录 B 是给将来的人看的，不是审批流程。**它的作用是让"当时为什么这么选"不丢**，避免半年后有人推翻一个其实有理由的决定。


### 三条验收判定规则

一条需求算「完成」，必须同时满足：

1. **规格达成** —— 本文档对应章节写的机制确实实现了（不是简化版、不是后续再补）。
2. **脚本通过** —— §19 中对应的 `verify` 脚本从红转绿，且没有让其他项变红。
3. **文档同步** —— 若实现过程中发现设计需调整，文档已同步更新。

三条缺一条即视为未完成。

第 3 条要理解对：它要求的是**规格层与文档一致**，不是"每个实现细节都要有文档依据"。具体到：

| 情况 | 要不要同步文档 |
|---|---|
| 改了表结构、检索方式、API 形状、备份策略 | **要** —— 这些是规格，文档落后就不能当验收标准了 |
| 发现文档写的方案不可行、换了做法 | **要** —— 且先改文档再改代码 |
| 内部函数怎么拆、日志怎么写、用了哪个工具 | **不要** —— 属实现层，写进文档只是噪音 |

换句话说：**文档必须能准确描述"系统长什么样"，但不必（也无法）描述"代码怎么写"**。前者是验收依据，后者是过程。

### 「不做」也是需求

§1.2 明确列出的排除项（X/Twitter 抓取、桌面端 Tauri、ARM 预编译产物、Java 生态）**同样是需求的一部分**。它们的作用是封住范围：没有这份排除清单，项目会在实现过程中被"顺便也做一个"逐步撑大。

**但这不等于"文档没写的都不能做"**。排除项是**功能级别**的禁止（不提供 X 抓取），不是实现级别的限制（不由它决定能不能用某个库、能不能多写一个内部函数）。两者别混。

---

## 一、需求与约束

### 1.1 功能需求

| # | 需求 | 规格落点 | 实施步骤 | 验收脚本 |
|---|---|---|---|---|
| 1 | RSS 订阅、OPML 导入导出、全文提取 | §6、§7、§15.7 | 1.1 / 1.2 / 1.3 / 1.4 / 1.5 / 1.6 | `m1-01`~`m1-06` |
| 2 | **RSSHub 订阅搜索**（关键词 / URL → 可订阅地址） | §10 | 1.6 | `m1-06` |
| 3 | **自动 AI 整理**：分类分级 | §8 | 2.1 / 2.2 / 2.3 | `m2-01` `m2-02` `m2-03` |
| 4 | **每日简报**（跨源聚合 + 多源冲突识别） | §9 | 3.1 / 3.2 / 3.3 / 3.4 | `m3-01`~`m3-04` |
| 5 | **高亮**（划词标注，回流 AI） | §11 | M4 | `m4-*` |
| 6 | **阅读历史**（Recently Read） | §7.4 | 1.5 | `m1-05` |
| 7 | 检索与 RAG 问答 | §7 | 0.7 / M5 | `m0-07` `m5-*` |
| 8 | **MCP 服务器** | §12 | M5 | `m5-*` |
| 9 | **自动存档 / 备份 / 迁移** | §13 | M6 | `m6-*` |
| 10 | **兼容 Huntly 浏览器插件** | §14 | 0.5 / 0.8 / M7 | `m0-05` `m0-08` `m7-*` |
| 11 | **现代简洁 UI** | §15 | 0.9 / M8 | `m0-09` `m8-*` |
| 12 | **GitHub Actions 打包 + Docker 镜像** | §16 | 0.8 | `m0-08` |
| 13 | **订阅一键批量管理**（全选 → 移动分组/移出/暂停/恢复/删除/刷新） | §15.10、§18 | 1.8 | `m1-08-bulk.mjs` |
| 14 | **阅读页交互**（原文/源站双出口、正文链接不打断阅读、列表可新标签打开、已读可回退、阅读偏好） | §15.11、§18 | 1.9 | `m1-09-reader.mjs` |
| 15 | **分组内查看订阅源**（选中分组 → 列出组内源 → 可按单个源过滤条目） | §15.13、§18 | 1.11 | `m1-11-folder-feeds.mjs` |
| 16 | **收件箱阅读控制**（全部/未读分段切换 + 手动刷新按钮，已读后能拉回新状态） | §15.14、§18 | 1.12 | `m1-12-inbox-view.mjs` |
| 17 | **配置中心**（订阅管理/分组/账户收进配置弹窗；订阅页分组用下拉栏选择；参考 Huntly 的 SettingModal） | §15.15、§18 | 1.13 | `m1-13-settings.mjs` |
| 18 | **侧栏分组树**（分组就地展开显示组内订阅源；组内源很多时不再占用列表栏） | §15.13、§15.16 | 1.18 | `m1-18-sidebar-tree.mjs` |
| 19 | **三栏密度收敛**（侧栏与列表栏收窄、行距收紧，把宽度与高度让给正文） | §15.16 | 1.19 | `m1-19-density.mjs` |
| 20 | **阅读区边缘与侧边目录**（正文列成为可见的"纸"、宽屏在正文右侧空白里显示文章小标题目录并可点击跳转；无小标题时不显示） | §15.18 | 1.20 | `m1-20-reader-toc.mjs` |
| 21 | **默认只看未读**（进入应用即只显示未读，点「全部」才展开已读的；侧栏「未读」与分段控件同亮，不存在两处状态矛盾） | §15.19 | 1.21 | `m1-21-default-unread.mjs` |
| 22 | **未读清零后的落点**（分段控件**始终留在「未读」**，不因该范围 0 未读而偷偷改成「全部」；0 未读时在列表里画一条分割线，把该范围更早的已读条目补在下面；**每次点选分组/源都重新判断**，绝不沿用上一个范围手动选的「全部」；空态里的「看全部」只切读/全部、保留分组与源；读完一篇未读数立即减 1，不用刷新） | §15.20、§15.24 | 1.22 | `m1-22-empty-scope.mjs` |
| 23 | **按分组 / 按单个订阅清零未读**（分组行与单源都能一次把该范围的未读标为已读；只写 `is_read`，**不伪造阅读历史**；不提供"清全库"入口） | §15.21 | 1.23 | `m1-23-mark-scope-read.mjs` |
| 24 | **AI key 可在 Web 界面填写**（存 `data/secrets.json`、权限 600，**不进库、不进备份、不进导出/迁移**；未配置时**同一条缺 key 只记一次**，条目不再逐条刷屏，改为状态页与启动横幅提示） | §8.1、§8.8 | 2.6 | `m2-06-api-key.mjs` |
| 25 | **未分组源平铺在侧栏「分组」区块**（与分组行同级，点一下就看这个源的条目；不再需要进配置弹窗才找得到） | §15.13、§15.26 | 1.26 | `m1-26-ungrouped.mjs` |
| 26 | **单篇总结按钮 + 总结提示词可编辑**（阅读页一键总结；提示词在配置中心可改、可恢复默认；按**提示词指纹**缓存，提示词没变就不重复计费） | §8.9、§15.27 | 2.7 | `m2-07-summary.mjs` |
| 27 | **资源与性能可验收**（空闲 RSS / CPU / 日志噪音 / 库体积 / 首屏体积写成红线；§5.7 列优化任务清单并逐条挂到步骤上） | §5.7 | 0.10 | `m0-10-resources.mjs` |
| 28 | **分组与源的顺序可调**（侧栏长按 500ms 进排列模式，拖或点 ↑↓ 调序；源可拖进/拖出分组；跨组移动给可撤销的提示；配置 › 分组另有一路常显 ↑↓，因为手机上侧栏是 `display:none`） | §15.28 | 1.27 | `m1-27-arrange.mjs` |

### 1.2 技术约束

| 约束 | 说明 | 验证方式 |
|---|---|---|
| 部署目标 | 本地（Windows）、Linux 服务器、x86 NAS | 0.8 三路互换启动 |
| 部署方式 | 二进制、源码、Docker 三路并存 | 0.8 同一 `data/` 可互换 |
| 架构 | **仅需 x64，不要求 ARM** | 发布矩阵只出两个产物（§3.2） |
| 用户模型 | 单人使用，但预留多人（所有表带 `user_id`） | 0.5 `require-user.ts` 单点开关 |
| 语言 | **不用 Java** | 全栈 TypeScript，无 JVM 依赖 |
| 模型 | 走 API（OpenAI 兼容），之后会替换 | 2.1 换模型只改 baseURL + model |
| 环境隔离 | 工具链、缓存、依赖、数据全在项目目录内 | 0.1 / 0.8 `$HOME` 零写入 |
| **不做** | X/Twitter 抓取、桌面端（Tauri）、ARM 预编译、Java | 范围排除项，见下 |

### 1.3 本表的修改权限

**§1.1 与 §1.2 只有需求方（项目所有者）能加行。** 实现者可以提出建议，但不能自行写入表格 —— 一旦实现者能给自己派需求，这份文档作为验收标准的效力立刻消失。

具体流程见 **A.1.1**，摘要：

```
实现中发现"应该还要有个 X"
  → 写一份【需求提议】（做什么 / 归哪节 / 哪步实现 / 哪个脚本验收 / 影响几天）
  → 需求方回「加」或「不加」
  → 只有回了「加」，才动 §1.1 表格，同时升版本号到 v2.0
```

三种常见的越界，都不允许：

- 「参考 Huntly 有这个，所以我们也得有」—— Huntly 是参考，不是需求。
- 「这个功能很小，顺手就做了」—— **新增功能**无论大小都要确认（注意区分：新增功能 ≠ 实现细节，后者见 A.2.1 可自行决定）。
- 「先做，做完再补进文档」—— 需求层不允许；规格层也不允许（那正是文档失效的开始）。

**这条规则只约束需求层，不约束实现层。** 文档没写的内部实现细节、技术选型微调、代码组织方式，实现者自主决定即可，不必找需求方拍板 —— 否则这份文档会从"验收标准"变成"审批流程"，反而拖慢进度。


---

## 二、总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器 (React 19 / shadcn / Tailwind)                        │
└────────────────────────┬─────────────────────────────────────┘
                         │ REST + SSE
┌────────────────────────▼─────────────────────────────────────┐
│  单个 Node 进程（Hono + 内联 job runner）                     │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 静态资源    │ │ REST API │ │ SSE 流式 │ │ Job Runner    │  │
│  └────────────┘ └──────────┘ └──────────┘ └───────┬───────┘  │
└───────────────────────────────────────────────────┼──────────┘
                                                    │ 轮询认领
                          ┌─────────────────────────▼─────────┐
                          │  SQLite (data/app.db, WAL)         │
                          │  · 业务表 + jobs 表                │
                          │  · 向量以 BLOB 存 (Float32Array)   │
                          └────────────────────────────────────┘
                                                    │
                          ┌─────────────────────────▼─────────┐
                          │  OpenAI 兼容 API（可随时替换）      │
                          └────────────────────────────────────┘
```

**设计原则**：一个可执行文件 + 一个 SQLite 文件。

- 不引入外部数据库、消息队列、搜索引擎、独立向量库 —— 每少一个组件，NAS 上就少一个装不上的理由。
- 所有状态集中在 `data/`，拷贝该目录即完成备份与迁移。
- 单进程运行；需要隔离负载时可拆出 worker 进程（同一二进制）。

---

## 三、技术选型

| 层 | 选择 | 说明 |
|---|---|---|
| 运行时 | **Node.js 24 LTS** | 内置 `node:sqlite`；SEA 单二进制；有 LTS 承诺 |
| 语言 | TypeScript（`erasableSyntaxOnly`） | 只能用可擦除语法，不能用 `enum` / `namespace` |
| 后端 | **Hono** + `@hono/node-server` | 纯 `Request → Response`，易打包 |
| 前端 | **React 19 + Vite + Tailwind + shadcn/ui** | 构建为静态产物，内嵌二进制 |
| 前端数据 | TanStack Query | 配合 REST，无需 RSC |
| 数据库 | **`node:sqlite`** + WAL | 运行时内置，无需原生插件 |
| ORM / 迁移 | **Drizzle `1.0.0-rc.x` + `drizzle-orm/node-sqlite`** | 迁移为纯 SQL，可内嵌（**`0.45.x` 无此驱动**，见 §3.4） |
| 校验 | zod | API 入参与 AI 结构化输出共用 |
| 抓取解析 | 全局 `fetch` + `@mozilla/readability` + `linkedom` | 无浏览器依赖 |
| 打包 | **esbuild → SEA** | 单文件二进制；资源用 `fflate` 内存解压（§3.3） |
| AI | OpenAI 兼容协议单一适配层 | 换模型只改 `baseURL` + `model` |
| MCP | `@modelcontextprotocol/sdk` | — |
| 认证 | 自建 session（cookie + SQLite） | 预留多人的单点开关 |
| 测试 | `node --test`（内置） | 二进制 E2E 门禁 |

**不引入**：Next.js、better-sqlite3、PostgreSQL、Redis、Elasticsearch / Meilisearch、Qdrant、Prisma、Playwright、Bun。

### 3.1 关键选型依据

**为什么不用 Next.js**：它依赖 RSC 运行时与 webpack chunk 布局，本质不是「一个入口文件的程序」，无法打成自包含单文件。改用 Hono + Vite SPA 后，整个应用可由一个 `src/index.ts` 入口产出。

**为什么不用 `better-sqlite3`**：它是原生插件（`.node`）。SEA 无法直接 `require` 原生模块，必须「写入临时文件 + `process.dlopen()`」迂回。`node:sqlite` 是运行时内置绑定，不存在这个问题。

**为什么选 OpenAI 兼容协议而非多 provider SDK**：DeepSeek、通义、Moonshot、智谱、OpenAI、Ollama、LM Studio、one-api 网关都支持 `/v1/chat/completions`。换模型 = 改两个字符串，符合「之后会替换」的诉求。

### 3.2 SEA 的平台限制（影响发布矩阵）

Node SEA 的官方测试覆盖范围有限，两条硬限制：

| 限制 | 影响 |
|---|---|
| 不支持 Alpine（musl） | 不发布 `linux-x64-musl`；Docker 用 `debian:bookworm-slim` |
| macOS 只测 arm64，x64 明确跳过 | 不发布 `darwin-*` |

**发布矩阵（正是 SEA 稳定支持的两个平台）**：

| 目标 | 产物 | 适用 |
|---|---|---|
| Linux x64 (glibc) | `cheng-rss-linux-x64` | 云服务器、x86 NAS、Docker |
| Windows x64 | `cheng-rss-windows-x64.exe` | 桌面本机 |

> 限制只存在于「是否提供预编译二进制」这一层，不影响「能否运行」。其他平台（M 系 Mac、ARM 设备、Alpine）用源码模式（`./scripts/dev.sh`）完全正常。

### 3.3 `node:sqlite` 的稳定性缓冲

`node:sqlite` 目前是 release candidate（稳定性 1.2），API 仍可能小幅调整。对策：

1. **抽出 `Db` 适配接口**（约 40 行），所有数据库访问经它中转。将来换 `better-sqlite3` 只改一个文件。
2. 把 Node 版本锁在 `24.x` 的 patch 范围内（`engines` + `.nvmrc`）。

### 3.4 两个必须锁版本的坑（实测）

**Drizzle 必须用 `1.0.0-rc.x`。** `drizzle-orm@0.45.4`（当前 `latest` 标签）**没有 `node-sqlite` 驱动** —— 它的 sqlite 驱动只有 `better-sqlite3` / `bun-sqlite` / `libsql` / `expo` / `op-sqlite`。`drizzle-orm/node-sqlite` 只存在于 `1.0.0-rc.5` 之后的版本。写进 `package.json` 时用精确版本，不要 `^0.45`：

```jsonc
"drizzle-orm": "1.0.0-rc.5",
"drizzle-kit": "1.0.0-rc.5"
```

`drizzle(db)` 传实例时必须用 `drizzle({ client: db })` 形式，否则会新建一个 `:memory:` 连接 —— `drizzle(db)` 的位置参数只接受路径字符串，传实例会被静默忽略。

**Node 24 的 SEA 没有虚拟文件系统。** `vfsArchive` / `useVfs` 是 Node 26 才有的能力，在 24.x 上写进 `sea-config.json` 会被**静默忽略**（blob 只有几百字节，`getAssetKeys()` 返回空数组）。静态资源只有一条可行路径：

```js
// 构建期：sea-config.json 用 assets 字段
{ "assets": { "client.zip": "dist/client.zip" } }

// 运行期：getAsset() 取出 zip → fflate 在内存里解压一次 → 提供静态服务
import { getAsset } from "node:sea";
import { unzipSync } from "fflate";
const files = unzipSync(new Uint8Array(getAsset("client.zip")));   // 实测 1ms
```

代价是前端产物体积**全部驻留内存**（实测 73KB zip / 224KB 解压后，可忽略）。不要试图 `fs.readFile('/index.html')` —— 24.x 上不存在 SEA 的 VFS 路径，只会 `ENOENT`。

**`postject` 在 Windows 上会 OOM（实测，v1.8 排查）。** `postject` 的注入器是
Emscripten 编成 wasm 的一个 4.8MB 模块，`INITIAL_MEMORY = 256MB` 且没有
`ALLOW_MEMORY_GROWTH`。Windows 上它有两种失败：

- `Fatal process out of memory: Zone` —— V8 的 TurboFan 在给这个巨型函数做
  类型推导时把 Zone 撑爆。这是**编译期**耗尽，与物理内存余量无关（本机空闲
  2.4GB 照样炸，`--max-old-space-size` 从 256 调到 3000 全无效）。
- `Aborted()` —— 同一模块在 tier-up 里二次编译的断言失败。

修法是给 node 加 `--liftoff-only`，只用基线编译器、不做优化编译：

```js
// scripts/build-sea.mjs
execFileSync(nodeBin, ['--liftoff-only', postjectCli, outPath, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', FUSE]);
```

注入一次从 1 秒变 4 秒，代价可接受。**另外不要用 `postject.cmd`** —— 那个
`.cmd` 按 `PATH` 找 `node`，实际会用系统 node 而不是 `.toolchain/node`，
违反 §1.2 的全局零依赖。直接 `node node_modules/postject/dist/cli.js`。

---

## 四、部署设计

三种方式共用**同一份代码与同一个数据目录**，区别只在「怎么拿到可执行体」。

```
                    ┌─────────────────────────┐
                    │  同一份 TypeScript 源码   │
                    └───────────┬─────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│ A. 二进制部署  │      │ B. 源码部署    │      │ C. Docker     │
│ 下载即运行     │      │ 项目内 Node    │      │ docker pull   │
│ 无依赖         │      │ bootstrap.sh  │      │ docker run    │
└───────┬───────┘      └───────┬───────┘      └───────┬───────┘
        └───────────────────────┴───────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  ./data/app.db        │
                    │  ./data/files/        │
                    │  ./data/config.json   │
                    │  ./data/backups/      │
                    └───────────────────────┘
```

### 4.1 二进制部署（NAS / 服务器首选）

```bash
./cheng-rss-linux-x64 serve --data ./data --port 3000
```

**五个必须做到的工程点**（缺一条「二进制部署」就是名义上的）：

1. **前端静态资源内嵌**。Vite 产物打成 zip → `sea-config.json` 的 `"assets"` → 运行时 `getAsset()` + `fflate` 内存解压（§3.4）。**不能**假设发布时旁边有 `public/` 目录，也**不能**用 `vfsArchive`（Node 24 不支持）。
2. **迁移 SQL 内嵌**。esbuild `--loader:.sql=text` 把迁移文件打成字符串，运行时按 `schema_migrations` 表逐条执行。
3. **提示词模板内嵌**（`packages/prompts/*.md`，同样用 text loader）。
4. **数据目录显式外置**：`--data`，默认 `./data`。二进制本身无状态。
5. **子命令自检**：`cheng-rss version` / `doctor` / `migrate` / `serve` / `worker` / `mcp` / `export` / `import`。

### 4.2 源码部署（开发 / 定制）

目标是**装完不污染系统**：Node 运行时、npm 缓存、依赖、构建产物、数据库全在项目目录内，删除目录即彻底卸载。

```bash
# Linux / macOS
git clone … && cd cheng-rss
./scripts/bootstrap.sh          # 下载项目内 Node 24 + 初始化本地缓存（只需一次）
./scripts/dev.sh                # = ./.toolchain/node/bin/node …（热重载）
./scripts/build.sh              # 生产构建
./scripts/build.sh --sea        # 产出本机平台二进制

# Windows（PowerShell，无需 git-bash / WSL）
git clone …; cd cheng-rss
.\scripts\bootstrap.ps1
.\scripts\dev.ps1
.\scripts\build.ps1 -Sea
```

**为什么每个脚本要有 `.sh` 与 `.ps1` 两份**：引导阶段系统里**还没有 Node**，所以第一步不可能写成 `.mjs`（没有解释器）。Windows 默认也没有 bash。两份薄脚本各自只做「下载 + 解压 + 转交」，逻辑本身放在共享的 `scripts/lib/toolchain.ps1` / `toolchain.sh` 里，避免双份维护。

引导完成后按这个顺序找解释器，**永远优先项目内的**：

```
1. ./.toolchain/node/bin/node   （或 .toolchain\node\node.exe）
2. 系统 PATH 里的 node（仅用于首次 bootstrap 之后的兜底提示，版本不符则报错退出）
3. 都没有 → 打印下载指引，退出码 1
```

只依赖一个可执行体：项目内的 `.toolchain/node`。无需系统 Node、无需 C++ 工具链（不使用任何原生插件）。

### 4.3 一切资源留在项目内（不污染系统环境）

**约束**：除了「下载一次 Node 压缩包」这一步，任何环节都不写 `$HOME`、不写系统目录、不动全局 `npm`。

```
cheng-rss/
├─ .toolchain/                  # 项目内 Node 运行时（~104MB，git ignored）
│  └─ node/                     #   node/npm/npx 全在这里，含完整 npm
├─ .cache/npm/                  # npm 缓存（~200MB，git ignored）
├─ .npm-global/                 # 万一需要 npm -g 时落这里（git ignored）
├─ node_modules/                # 依赖（git ignored）
├─ .tmp/                        # 构建临时目录（git ignored）
├─ dist/                        # 构建产物（git ignored）
├─ data/                        # 运行数据（git ignored，唯一需要备份的东西）
└─ scripts/                     # bootstrap / dev / build（.sh + .ps1 各一份）
```

**落实手段**：

| 资源 | 如何留在项目内 | 验证 |
|---|---|---|
| Node 运行时 | `scripts/bootstrap.{sh,ps1}` 下载官方压缩包解压到 `.toolchain/node/`；所有脚本用它启动 | `./.toolchain/node/bin/node -v` |
| npm 缓存 | 项目 `.npmrc` 写 `cache=./.cache/npm` | `npm config get cache` 返回项目内路径 |
| 全局安装 | **禁止用 `npm i -g`**；若必须，`npm_config_prefix=./.npm-global` 环境变量覆盖 | `ls .npm-global/bin` |
| 依赖 | `node_modules/` 天然在项目内（`prefix` 不作用于本地安装） | — |
| 构建工具 | `esbuild` / `postject` / `vite` 全部装为 **devDependencies**，用 `npx --no-install` 调 | `npm ci` 后即可构建 |
| 临时文件 | 脚本内 `TMPDIR=./.tmp`、`TMP=./.tmp`、`TEMP=./.tmp` | 构建期间 `$HOME/.cache` 无新增 |
| 数据 | `--data ./data`，默认值就是项目内 | `doctor` 打印绝对路径 |
| Docker | 构建阶段缓存用 `--mount=type=cache`（§16.3），本地 buildx 用 `type=local,dest=.cache/docker` | — |

**两个 npm 的限制（已实测）**：

1. **`prefix` 不能写进项目 `.npmrc`** —— npm 会直接报错 `config prefix cannot be changed from project config`。只能用环境变量 `npm_config_prefix` 覆盖。
2. **`cache` 可以写进项目 `.npmrc`**，实测生效。

`.npmrc`：

```ini
# 全部落在项目内；注意 prefix 不能写这里，见上
cache=./.cache/npm
fund=false
audit=false
save-exact=true
engine-strict=true
```

`bootstrap` 的核心逻辑（`.sh` 与 `.ps1` 只负责下载解压，其余共用 `scripts/lib/`）：

```ts
// 1. 按 nodejs.org/dist/index.json 校验版本存在，避免硬编码失效
const VER = process.env.CHENG_RSS_NODE_VERSION ?? "v24.13.0";
const plat = `${process.platform === "win32" ? "win" : "linux"}-x64`;
const url = `https://nodejs.org/dist/${VER}/node-${VER}-${plat}.${process.platform === "win32" ? "zip" : "tar.xz"}`;

// 2. 下载到 .tmp/ → 解压到 .toolchain/node/（解压后即删压缩包，省 36MB）
// 3. 校验：运行 .toolchain/node/bin/node -v，必须等于 VER，否则删除重下
// 4. 之后所有脚本都用这个 node 启动，不再读 PATH
```

**版本固定但可覆盖**：默认锁定 `v24.13.0`（与 CI 一致），需要试新 patch 时设 `CHENG_RSS_NODE_VERSION`。`engines` 只写 `>=24 <25`，次要版本升级不必改代码。

**为什么不干脆用二进制部署**：源码部署的价值是「能改代码」。但它不该附带「必须先装好系统 Node」。把运行时也纳入项目目录后，两者可以并存 —— 同一份 `data/`，`./scripts/dev.sh` 与 `./cheng-rss-linux-x64 serve` 随时互换。

**代价**：项目目录多约 300MB（Node 104MB + npm 缓存 200MB）。这些都在 `.gitignore` 里，删项目即清空，不残留。

### 4.4 Docker 部署

```yaml
services:
  cheng-rss:
    image: ghcr.io/you/cheng-rss:latest
    ports: ["3000:3000"]
    environment:
      TZ: Asia/Shanghai
      AI_BASE_URL: https://api.deepseek.com/v1
      AI_API_KEY: ${AI_API_KEY}
    volumes: ["./data:/app/data"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/app/cheng-rss", "doctor", "--quiet"]
      interval: 60s
```

镜像用编译后的二进制做 runtime 层，不含 Node：
`node:24-bookworm-slim`（构建）→ esbuild + SEA → `debian:bookworm-slim`（运行时，仅 ca-certificates + tzdata）。约 **80MB**。

**本地构建时缓存也留在项目内**：

```bash
# 不用 buildx 的 gha 缓存（那是 CI 专用）；本地用目录缓存
docker buildx build \
  --cache-from type=local,src=.cache/docker \
  --cache-to   type=local,dest=.cache/docker,mode=max \
  --platform linux/amd64 -t cheng-rss:local .
```

`.cache/docker` 在 `.gitignore` 内。这样反复构建不重跑 `npm ci`，且缓存不落在 `~/.docker` 的共享区之外（基础镜像层仍由 Docker daemon 管理，这部分无法项目内化，属 Docker 本身机制）。

### 4.5 三路部署的一致性保证

| 保证 | 做法 |
|---|---|
| 代码同源 | 三条路径都由 `src/index.ts` 单一入口 |
| 行为同源 | 配置全部走「环境变量 + `data/config.json` + UI」，没有只在某条路径存在的开关 |
| 数据同源 | 只有 `data/app.db` + `data/files/`，无外部依赖 |
| 迁移同源 | 迁移 SQL 内嵌；源码与 Docker 用同一份文件 |
| 测试 | CI 对**产物二进制**跑全套集成测试，不只对源码跑 |
| **卸载同源** | 删除项目目录即卸载干净；三路都不向系统写任何东西（检查点见下表） |

**「不留残留」的三个验证点**（CI 也跑）：

```bash
# 1. 构建全程 $HOME 无新增文件
before=$(find "$HOME" -newer /tmp/marker 2>/dev/null | wc -l)   # 先 touch /tmp/marker
./scripts/build.sh
after=$(find "$HOME" -newer /tmp/marker 2>/dev/null | wc -l)
[ "$before" = "$after" ] || echo "有文件写到 HOME 之外"

# 2. 所有路径都在项目根内
./cheng-rss doctor --json | jq -r '.paths[]' | grep -v "^$PWD" && echo "存在项目外路径"

# 3. 删除项目目录后无残留
rm -rf /tmp/cheng-rss-copy && cp -r . /tmp/cheng-rss-copy && rm -rf /tmp/cheng-rss-copy && echo OK
```

---

## 五、资源占用与性能

自托管场景的硬约束是「能在最小规格的 NAS 上长期跑」。以下全部是实测值（Node 24.13 / Windows x64 / SQLite 内置），不是估算。

### 5.1 内存

| 状态 | RSS |
|---|---|
| 进程刚启动 | 44 MB |
| + Hono 监听 | 50 MB |
| + SQLite 打开（含 16MB 页缓存） | 51 MB |
| + Readability 预热 | 67 MB |
| + 连续提取 60 篇后稳态 | 81 MB |

**稳态目标：120~200 MB RSS**（含前端资源、向量缓存、连接池）。`linkedom` 的 DOM 对象在每次提取后即丢弃，不累积（实测 20 次连续提取 heap 增长为 0）。

**内存闸门**：
- `--max-old-space-size=384` 写进启动脚本与 Dockerfile，节点跑飞时快速失败而非拖垮 NAS。
- 提取并发上限 4（实测 4 路并发 40 篇耗时 49ms，再高无收益且吃内存）。
- 向量不常驻：只在单次查询里从 BLOB 读出候选集，用完即弃。

### 5.2 CPU

| 操作 | 实测 |
|---|---|
| Readability 提取（60 段正文） | 1.5 ms/篇 |
| 4 路并发提取 | 等效 1.2 ms/篇 |
| 余弦相似度 5000 × 1536 维 | 14 ms |
| 余弦相似度 20000 × 1536 维 | 55 ms |
| FTS5 关键词查询 | 0.01~0.1 ms |
| 时间线 / 阅读历史首页 | 0.03~0.08 ms |

CPU 几乎全部花在**等待 AI 响应**上，本地计算占比可忽略。单核树莓派级别也能跑；真正的瓶颈是网络与模型延迟。

**NAS 上要关掉的**：`cluster` 与 `digest` 的长上下文调用若与提取抢 CPU，用 `jobs` 表的 `priority` 把交互路径（L0~L4）置于 `cluster`/`digest` 之前 —— 已由 `ORDER BY priority DESC, id` 保证。

### 5.3 磁盘（最重要的一节）

10 万条（50 源 × 约 2000 条/源，跑满约一年）实测：

| 表 / 索引 | 体积 | 占比 |
|---|---|---|
| `entry_contents` | **2090 MB** | **84%** |
| `embeddings`（2.5 万条 × 1536 维） | 205 MB | 8% |
| `entry_analysis` | 103 MB | 4% |
| `entries` + 全部索引 | 68 MB | 3% |
| `entries_fts` | 78 MB | 3% |
| **合计** | **2.5 GB** | |

体积几乎全部由正文决定，所以在 §13.3 用三条措施（gzip 2.6×、`raw_html` 30 天、`noise` 不存正文）压到 **0.8~1.0 GB / 10 万条**。**做这三条之前不要上线** —— 否则一年的库会到 2.5GB，NAS 备份开始痛苦。

每日增量与年增量（500 篇/日，措施生效后）：

```
正文 7 MB/日 + 分析卡片 0.5 MB/日 + 向量(若全量) 3 MB/日  ≈ 10 MB/日 ≈ 3.6 GB/年
```

向量只对 `worth` 及以上做（`noise`/`normal` 不 embed），可省约 60%。

### 5.4 启动与首屏

| 指标 | 目标 | 措施 |
|---|---|---|
| 进程冷启动到可服务 | < 400 ms | 迁移内嵌、不扫全库、索引已在 |
| 前端首屏 JS | < 250 KB（gzip 70 KB） | Vite 分包，路由级 lazy |
| 前端 zip（内嵌进二进制） | 73 KB | 实测 React 19 空壳 + 40 条列表 |
| 服务端 bundle（minify） | 945 KB | esbuild，`--external:node:*` |
| 二进制总体积 | 90 MB（node）+ 1 MB | 无原生依赖 |

### 5.5 索引清单与代价

每条索引都在写入时付费，只保留被真实查询用到的：

| 索引 | 用途 | 体积 |
|---|---|---|
| `idx_entries_timeline` | 收件箱时间线 | 2 MB |
| `idx_entries_unread` | 未读角标 `COUNT(*)` | 1 MB |
| `idx_entries_lastread` | 阅读历史 | 2 MB |
| `idx_entries_urlnorm` | 去重 | 3 MB |
| `idx_entries_hash` | 内容指纹去重 | 2 MB |
| `idx_entries_stage` | 流水线扫待处理 | <1 MB |
| `idx_analysis_tier` | 分级筛选 | 3 MB |
| `entries_fts` | 全文检索 | 78 MB |

**未读数必须走部分索引**：实测 `SELECT COUNT(*) WHERE is_read=0` 无索引时 **195 ms**（10 万条），加 `WHERE is_read = 0` 的部分索引后 **0.9 ms**。侧栏角标若每页都算，无索引会让整个 UI 明显发涩。

### 5.6 三条性能红线（CI 断言）

数值超标即 CI 失败，避免后续改动悄悄劣化：

| 断言 | 阈值 |
|---|---|
| 10 万条库上时间线查询 | < 5 ms |
| 10 万条库上关键词检索 | < 5 ms |
| 10 万条库上未读数 COUNT | < 3 ms |

### 5.7 资源与性能预算（v2.0 新增，0.10 落地）

§5.6 管的是**单条查询**。但"NAS 上能长期跑"还有另一类风险：**空闲也在耗资源**。
前者超标是一次操作变慢，后者超标是设备整夜发烫、日志把磁盘写满。本节补这一半。

**空闲红线**（进程在跑、没人操作、没有积压任务时应长期稳定在这个水平）：

| 指标 | 阈值 | 为什么是这个数 | 验收 |
|---|---|---|---|
| 空闲 RSS | ≤ 130 MB | §5.1 实测稳态 81 MB，留 60% 余量给前端资源与页缓存。本次实测空库空闲 57~66 MB | `m0-10` |
| 空闲 CPU（60s 均值） | ≤ 1.5% | 轮询 200ms 一次 tick；超了说明定时器在空转做全表扫。实测 0.01~0.5% | `m0-10` |
| 空闲日志速率 | ≤ 20 行/分钟 | 日志是 `console.error` → 容器日志收集；刷屏会写满 NAS 的 /var。实测 0 行 | `m0-10` |
| **单模板重复速率** | ≤ 3 行/60s | 去掉时间戳与 JSON 尾巴后归并计数。这条抓的是"同一句刷屏" —— 15 行同一句能过 20 行的总量阀，却过不了它，而缺 key 的旧行为正是这个形状 | `m0-10` |
| **空闲内存增长** | 峰值 ≤ 130 MB、峰谷差 ≤ 25 MB、末值 ≤ 峰值 | 90s 内 15s 一采。**不能写成"单窗口增量 ≤ X"**：实测稳态是 V8 锯齿，30s 涨 2.2~2.7 MB，几分钟后一次回落 6.7 MB（57→59.7→61.8→64.5→66.9→60.2）。任何单窗口阈值都在测采样时刻的运气 | `m0-10` |
| 缺 key 时的日志 | **同一条只记一次** | 没有 key 时 745 篇待分析会把"analyze 失败"刷 745 次；一次也不该丢，但也不该重复。实测 100 条只出 1 行 | `m2-06` |
| 前端首屏 JS（gzip） | ≤ 120 KB | §5.4 定的 70 KB 首屏预算；当前整包 gz 100.6 KB，拆包前先守这条总线上限 | `m0-10` |
| 前端 CSS（gzip） | ≤ 15 KB | 当前 10.0 KB | `m0-10` |
| 二进制体积 | ≤ 100 MB | SEA 产物。win-x64 实测 87 MB | `m0-10` |
| `data/` 稳态（1 万条） | ≤ 300 MB | 按 §5.3 每条约 25 KB 反推 | `m6` 导入后量 |

**为什么"缺 key"要单独列**：它不是性能问题而是**可用性问题**。实测（2026-10-30）
用真库快照起二进制、塞 20 条 analyze 任务、不设 `AI_API_KEY`，30 秒内 stderr
出现 **20 行** `INFO analyze 失败`。真实库里有 745 篇待分析 —— 那会是 745 行，
而且每一轮 backfill 重排时再来一遍。日志里 745 行同一句"没配置 API key"，
把真正的错误全埋掉了。修法不是关日志，而是**把"全局配置缺失"与"这一篇分析失败"
分成两类**：前者是部署状态，每个进程生命周期只报一次 + 状态页常驻；后者才是日志。

**优化任务清单**（每条都是可验收的，不是"注意性能"这种口号）：

| # | 任务 | 现状 | 目标 | 挂在哪一步 |
|---|---|---|---|---|
| P1 | 缺 key / 超预算 / 限流冷却 三类**全局失败**只记一次，条目不再逐条落 failed | 逐条刷屏 | 一次横幅 + `/stats` 常驻 | 2.6 |
| P2 | 孤儿 analyze 回填（`stage IN ('fetched','extracted')` 且无 `entry_analysis` 行且无在飞任务） | 实测 745 条永远不会被分析 | 与 extract 的 backfill 同构，5 分钟一轮 | 2.6 |
| P3 | `entries_fts` 的写入从"每次分析都重建"降到"内容指纹变了才重建" | 每次 analyze 一次 delete+insert | 指纹相同则跳过 | 2.7 |
| P4 | 日志按**模板**做速率限制（同类消息每 60s 最多 3 条，超出折叠并记数，跨窗口后的第一行补报"另有 N 条"） | 无 | 任一模板 ≤ 3 行/60s、不误伤各不相同的日志 | 0.10 ✅ |
| P5 | 前端按路由拆包（简报页 / 阅读页懒加载） | 单包 325 KB / gz 100 KB | 首屏 gz ≤ 70 KB | M8 |
| P6 | 首页列表虚拟滚动（>200 条时） | 全量渲染 | 首屏 DOM 节点 ≤ 300 | M8 |
| P7 | 向量检索按 tier 过滤后再算余弦（`noise` 不参与） | 全量算 | 候选集减 60% | M5 |
| P8 | `bak/evidence-*` 快照自动清理（保留最近 10 次） | 无限增长（实测单次 1.8 MB） | 上限 20 MB | M6 |

**P1~P4 已落地**（分别挂在 2.6 / 2.6 / 2.7 / 0.10），P5~P8 按里程碑顺序做。
P5~P6 放 M8 是因为它们要动构建配置与列表渲染，而那条路径上现在有 12 个
验收脚本盯着，越晚动越安全。

---

## 六、数据模型

### 6.1 基础约定

```ts
// src/server/db/client.ts
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";

const db = new DatabaseSync(`${dataDir}/app.db`);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA cache_size = -16000;");      // 16MB 页缓存
db.exec("PRAGMA mmap_size = 268435456;");    // 256MB 内存映射（实测全表扫描 353ms → 184ms）

export const orm = drizzle({ client: db, schema });   // 必须传 { client }，不能 drizzle(db)
```

**类型映射**：SQLite 无原生 `timestamptz` / `boolean`，统一用 `integer`（epoch ms / 0\|1），在 Drizzle 层用 `mode: "timestamp_ms"` / `mode: "boolean"` 映射。JSON 字段用 `text({ mode: "json" })`。向量用 `blob`（`Float32Array`）。

### 6.2 表结构

```sql
-- ── 用户与设置 ────────────────────────────────────────────────
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- ulid
  email       TEXT UNIQUE,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'owner',
  created_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ai_config     TEXT NOT NULL DEFAULT '{}',   -- provider/baseURL/models/budget
  fetch_config  TEXT NOT NULL DEFAULT '{}',
  digest_config TEXT NOT NULL DEFAULT '{}',
  rsshub_config TEXT NOT NULL DEFAULT '{}',   -- baseUrl/accessKey
  ui_config     TEXT NOT NULL DEFAULT '{}'
);

-- ── 分类法（受控：AI 只能选不能造）────────────────────────────
CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES categories(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  hint       TEXT,      -- 给 LLM 的判定说明，显著影响一致率
  keywords   TEXT,      -- JSON string[]
  sort       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, slug)
);

-- ── 订阅源 ────────────────────────────────────────────────────
CREATE TABLE folders (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE feeds (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id        TEXT REFERENCES folders(id) ON DELETE SET NULL,
  url              TEXT NOT NULL,
  site_url         TEXT,
  title            TEXT,
  icon_url         TEXT,
  fetch_interval   INTEGER NOT NULL DEFAULT 1800,
  last_fetched_at  INTEGER,
  next_fetch_at    INTEGER,
  etag             TEXT,                 -- 条件请求
  last_modified    TEXT,
  error_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',   -- active|paused|broken
  analysis_profile TEXT NOT NULL DEFAULT 'standard', -- full|standard|headline
  source_kind      TEXT NOT NULL DEFAULT 'rss',      -- rss|rsshub|opml
  UNIQUE (user_id, url)
);

-- ── 条目（核心表）─────────────────────────────────────────────
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id       TEXT REFERENCES feeds(id) ON DELETE CASCADE,  -- 可空：网页捕获无 feed
  guid          TEXT NOT NULL,
  url           TEXT NOT NULL,
  url_norm      TEXT NOT NULL,
  title         TEXT NOT NULL,
  author        TEXT,
  published_at  INTEGER NOT NULL,
  fetched_at    INTEGER NOT NULL,

  excerpt       TEXT,
  content_hash  TEXT,
  word_count    INTEGER,

  -- 处理状态机
  stage         TEXT NOT NULL DEFAULT 'pending',
  stage_error   TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,

  -- 状态位
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_starred    INTEGER NOT NULL DEFAULT 0,
  is_hidden     INTEGER NOT NULL DEFAULT 0,
  duplicate_of  TEXT REFERENCES entries(id) ON DELETE SET NULL,

  -- Huntly 插件兼容
  source_type        TEXT NOT NULL DEFAULT 'rss',   -- rss|web|capture
  archive_status     INTEGER NOT NULL DEFAULT 0,
  read_later         INTEGER NOT NULL DEFAULT 0,
  library_save_status INTEGER NOT NULL DEFAULT 0,
  page_json          TEXT,        -- 对应 pageJsonProperties
  favicon_url        TEXT,
  site_name          TEXT,
  thumbnail_url      TEXT,

  -- 阅读历史
  first_read_at  INTEGER,
  last_read_at   INTEGER,
  read_count     INTEGER NOT NULL DEFAULT 0,
  read_progress  REAL,

  -- 冗余计数
  highlight_count INTEGER NOT NULL DEFAULT 0,

  UNIQUE (feed_id, guid)
);
CREATE INDEX idx_entries_timeline ON entries (user_id, published_at DESC);
CREATE INDEX idx_entries_stage    ON entries (user_id, stage) WHERE stage <> 'done';
CREATE INDEX idx_entries_unread   ON entries (user_id, published_at DESC) WHERE is_read = 0;
CREATE INDEX idx_entries_urlnorm  ON entries (user_id, url_norm);
CREATE INDEX idx_entries_lastread ON entries (user_id, last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX idx_entries_hash     ON entries (content_hash);

-- 全文检索：中文按 bigram 预切分后进 FTS5（不要用 trigram，见 §7.3）
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, summary,
  content='',                -- 内容由程序维护，避免与 entries 双写
  tokenize='unicode61'
);

CREATE TABLE entry_contents (
  entry_id     TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  html         BLOB,      -- 清洗后 HTML，gzip 后存（实测压缩比 2.6×）
  markdown     BLOB,      -- 供 LLM 与导出，gzip 后存
  raw_html     BLOB,      -- 原始 HTML，仅保留 30 天（§13.3）
  extracted_by TEXT       -- feed|readability|defuddle|manual
);

-- ── AI 单篇分析 ──────────────────────────────────────────────
CREATE TABLE entry_analysis (
  entry_id       TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL,
  key_points     TEXT NOT NULL,       -- JSON string[]
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  topics         TEXT NOT NULL,       -- JSON string[]
  entities       TEXT NOT NULL,       -- JSON {people,orgs,products,tech}
  importance     INTEGER NOT NULL,    -- 0~100
  tier           TEXT NOT NULL,       -- must_read|worth|normal|noise
  novelty        INTEGER,
  sentiment      TEXT,
  reading_time   INTEGER,
  lang           TEXT,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  in_tokens      INTEGER, out_tokens INTEGER, cost_usd REAL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_analysis_tier ON entry_analysis (tier, created_at DESC);

-- ── 向量（BLOB，无扩展依赖）──────────────────────────────────
CREATE TABLE embeddings (
  entry_id   TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,          -- Float32Array，dim*4 字节
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_emb_model ON embeddings (model);

-- ── 去重向量（v1.10 新增，0002 迁移）────────────────────────────
-- 与 embeddings 分开的理由：embeddings 存 M2 的真实语义向量（1536 维，
-- 用于检索与聚类），entry_vectors 存本地判重指纹（256 维，用于"是不是同一篇"）。
-- 一张表只能有一条主键为 entry_id 的记录 —— 挤在一起，M2 写入真实向量时
-- 就会把去重指纹覆盖掉，而去重层对语义向量用 0.95 阈值本来就是错的
-- （语义相近 ≠ 重复）。
CREATE TABLE entry_vectors (
  entry_id   TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,          -- Float32Array，dim*4 字节
  model      TEXT NOT NULL,          -- local-hash-v1
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entry_vectors_model ON entry_vectors (model);

-- ── 跨篇聚合：事件簇 ─────────────────────────────────────────
CREATE TABLE clusters (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,        -- event|topic
  title        TEXT NOT NULL,
  summary      TEXT,
  key_points   TEXT,                 -- JSON
  consensus    TEXT,                 -- JSON: 多源一致的事实
  conflicts    TEXT,                 -- JSON: [{claim, sources[]}]
  centroid     BLOB,
  entry_count  INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  heat         INTEGER,              -- 条目数 × 均值重要度 × 时间衰减
  window_start INTEGER, window_end INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_clusters_window ON clusters (user_id, window_end DESC);

CREATE TABLE cluster_entries (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  similarity REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, entry_id)
);

-- ── 高亮 ─────────────────────────────────────────────────────
CREATE TABLE highlights (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  quote_exact  TEXT NOT NULL,
  quote_prefix TEXT, quote_suffix TEXT,
  pos_start    INTEGER, pos_end INTEGER,
  range_json   TEXT,
  color        TEXT,
  note         TEXT,
  ai_insight   TEXT,
  is_orphaned  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_hl_entry   ON highlights (user_id, entry_id);
CREATE INDEX idx_hl_created ON highlights (user_id, created_at DESC);

-- ── 简报 ─────────────────────────────────────────────────────
CREATE TABLE digests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,        -- daily|weekly|topic|manual
  title        TEXT NOT NULL,
  intro        TEXT,
  body_md      TEXT NOT NULL,
  period_start INTEGER, period_end INTEGER,
  entry_count  INTEGER, cluster_count INTEGER,
  model        TEXT, cost_usd REAL,
  delivered_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_digest_period ON digests (user_id, kind, period_start);

-- ── 任务队列 ─────────────────────────────────────────────────
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,        -- fetch_feed|extract|analyze|embed|cluster|digest
  dedupe_key   TEXT,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|dead
  priority     INTEGER NOT NULL DEFAULT 0,
  run_after    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by    TEXT, locked_at INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_jobs_pick ON jobs (status, run_after, priority DESC, id);
CREATE UNIQUE INDEX uq_jobs_dedupe ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- ── 成本审计 ─────────────────────────────────────────────────
CREATE TABLE ai_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,   -- analyze|embed|cluster|digest|chat|insight
  model      TEXT NOT NULL,
  in_tokens  INTEGER, out_tokens INTEGER,
  cost_usd   REAL, latency_ms INTEGER,
  ok         INTEGER, error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_day ON ai_usage (user_id, created_at DESC);

-- ── RSSHub 路由缓存 ──────────────────────────────────────────
CREATE TABLE rsshub_cache (
  key        TEXT PRIMARY KEY,     -- 'namespaces' | 'radar'
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- ── 备份记录（GFS 保留策略依赖）──────────────────────────────
CREATE TABLE backup_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,        -- daily|weekly|monthly|manual|export
  path       TEXT NOT NULL,
  size_bytes INTEGER,
  schema_ver INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL
);

-- ── RAG 会话 ─────────────────────────────────────────────────
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL,
  citations TEXT,
  created_at INTEGER NOT NULL
);
```

---

## 七、处理流水线与检索

### 7.1 阶段与状态机

| 阶段 | 工作 | 触发 | 耗时 |
|---|---|---|---|
| **L0 fetch** | 按 `next_fetch_at` 拉 feed（ETag / If-Modified-Since） | 每分钟 sweep | 0.3~2s |
| **L1 extract** | 清洗 feed HTML；正文过短则抓原文 + Readability | L0 产出 | 0.5~3s |
| **L2 dedupe** | URL 规范化 → 指纹近似 → 向量余弦(>0.95) | L1 产出 | <50ms |
| **L3 analyze** | 一次 LLM 调用：摘要/要点/分类/标签/实体/分级 | L2 产出 | 2~8s |
| **L4 embed** | 向量化（标题+摘要+首段）写 BLOB | L3 产出 | 0.2~1s |
| **L5 cluster** | 滑动窗口聚类 → 簇级 LLM 归纳 | 每 6h | 10~40s |
| **L6 digest** | 生成简报 | 每天 08:00 | 15~40s |
| **L7 chat** | RAG 问答 | 用户请求 | 2~6s |

```
pending ─extract→ extracted ─analyze→ analyzed ─embed→ embedded ─▶ done
        ↘ 失败: failed(reason)，retry_count++，≤3 次后置 dead
```

**幂等要求**：
- 推进用乐观锁 `UPDATE ... WHERE id=? AND stage='<expected>'`，`changes === 0` 即放弃（防重复计费）。
- job 用 `dedupe_key` 唯一索引兜底。
- 结果写入受 **no-regression** 保护：不覆盖更优的既有结果。
- 崩溃恢复：启动时把 `running` 且锁超 10 分钟的任务重置为 `pending`。

### 7.2 Job Runner

```ts
// node:sqlite 为同步 API，用 BEGIN IMMEDIATE 保证认领原子性
function claimBatch(n: number) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`
      SELECT * FROM jobs
       WHERE status='pending' AND run_after <= ?
       ORDER BY priority DESC, id LIMIT ?`).all(Date.now(), n) as Job[];
    const upd = db.prepare(`UPDATE jobs SET status='running', locked_by=?, locked_at=? WHERE id=?`);
    for (const r of rows) upd.run(WORKER_ID, Date.now(), r.id);
    db.exec("COMMIT");
    return rows;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

单进程内 `setInterval(50ms)` 轮询，按 kind 分并发：fetch 5 / extract 4 / analyze 2 / embed 4 / cluster·digest 1。`WORKER_INLINE=false` 时以 `cheng-rss worker` 独立进程启动。

### 7.3 检索

```
query
 ├─ A. 关键词：FTS5(title+summary)，中文按 bigram 预切分   ← 精确、0.1ms
 ├─ B. 语义：embed(q) → 候选集内余弦排序                  ← 需 embedding
 └─ C. 过滤：时间范围 / feed / category / tier             ← 硬约束
        ↓  RRF 融合 → top 20 → 可选 rerank → top 8
```

**中文检索必须自己做分词。** 实测三种方案（10 万条 × 400 字语料）：

| 方案 | 2 字中文词 | 3 字词 | 无命中查询 | 索引体积 | 结论 |
|---|---|---|---|---|---|
| `LIKE '%q%'` 全表扫描 | 0.03ms（早停）| 同 | **180~360ms** | 0 | 不可用为主力 |
| FTS5 `trigram` | **0 条（查不到）** | 0.1ms | 0ms | +205MB | **不可用** |
| FTS5 `unicode61` 裸用 | 0 条（不切中文） | 0 | — | — | 不可用 |
| FTS5 + **程序侧 bigram** | 0.01ms | 0.01ms | 0.01ms | +78MB | **采用** |

`trigram` 要求查询 ≥3 字符，「芯片」「裁员」「苹果」这类 2 字词直接返回空 —— 中文场景下这是致命的。`unicode61` 把整句中文当一个 token，同样查不到。所以必须在写入和查询两侧都做 bigram 切分：

```ts
// 中文按相邻两字切，英文/数字按词
function bigrams(s: string): string[] {
  const out: string[] = [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (/^[\u4e00-\u9fff]/.test(t)) {
      if (t.length === 1) out.push(t);
      for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
    } else out.push(t.toLowerCase());
  }
  return out;
}

// 写入侧：空格连接
await fts.insert(rowid, bigrams(title).join(" "), bigrams(summary).join(" "));

// 查询侧：每个词切成 bigram，用短语查询（引号）保证相邻，多词 AND
function toMatch(q: string): string {
  const parts: string[] = [];
  for (const w of q.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g) ?? []) {
    parts.push(`"${bigrams(w).join(" ")}"`);   // "半导 导体" = 相邻短语
  }
  return parts.join(" AND ");
}
```

**查询侧必须也用 bigram**，否则「半导体」在索引里是 `半导 导体` 两个 token，直接搜原文查不到。加了引号变成短语查询后，「半导X体」这类不连续文本不会被误命中（实测反例通过）。

**为什么向量不需要扩展**：候选集 = 近 90 天已 embed 条目 ≈ 4.5 万条 × 1536 维 × 4B ≈ 276MB，单次全量余弦 80~200ms；先用关键词/分类/时间窗收窄到几千条则 <20ms（实测 5000 条 14ms）。留 `VectorStore` 接口，将来可换 `sqlite-vec` 或 pgvector 而不动业务代码。

**去重阈值**：余弦 >0.95 判重；0.88~0.95 判「同事件不同报道」，进同一簇但不合并。阈值需用自己的数据校准。

### 7.4 阅读历史

按 `last_read_at` 倒序回溯「读过什么、何时读的」。**不能只用 `is_read` 布尔值**，否则无法排序。

```ts
// POST /entries/:id/read —— 幂等语义的关键
UPDATE entries SET
  first_read_at = COALESCE(first_read_at, :now),
  last_read_at  = :now,
  read_count    = read_count + 1,
  is_read       = 1,
  read_progress = COALESCE(:progress, read_progress)
WHERE id = :id
```

> 不要用 `is_read = 1` 做幂等跳过 —— 那样重复打开不会刷新 `last_read_at`，「最近读过」排序会失效。

**UI**：按日期分组（今天/昨天/本周/更早），卡片显示阅读进度条与 `read_count > 1` 角标。

**分桶规则（v1.11 落地时确定的细节）**

- **必须是本地日历日**，不是 `(now - at) / 86400000` 也不是 UTC 日。前者会把"凌晨 1 点读的"和"23 小时前读的"算成同一天；后者在东八区会把凌晨读的东西算成"昨天"。
- **"本周" = 最近 7 天滚动窗口**，不是自然周。周一时按自然周算，周日读的会掉进"更早"，而它才过了一天。
- **空桶不渲染**：4 个空分组会让用户以为加载失败。
- 分桶函数只分组、不排序 —— 排序键（`last_read_at`）调用方才知道，写进分组函数会让"传乱序也能对"变成隐式约定。
- `GET /entries/history` 返回 `{ groups, count, total, nextCursor }`，`total` 用**不含游标**的条件算，否则翻页时标题行数字一路缩小。

> 接口形状与列表接口刻意不同（分组数组 vs 平铺 + 游标）：历史页要渲染日期标题，而列表页永远不看 `groups`。合成一个返回类型会让两边都拖着一个用不上的字段。

### 7.5 正文提取（L1，v1.10 新增）

feed 里给一半的内容是常态：摘要型 feed（`description` 只有一段导语）、图床型 feed（正文只有图片）、
以及"付费墙前 3 段"。直接在列表里读这种内容，用户会以为这个源质量差 —— 实际是没去抓原文。

**触发条件（只在需要时抓，不是每篇都抓）**

```
feed 正文去标签后的字符数 < MIN_FEED_CHARS(500)  →  入队 extract
否则                                              →  直接 stage='extracted'
```

不设无条件抓取的理由：50 个源 × 每天 500 条 = 每天 500 次额外请求，而其中 80% 的 feed 本来就带全文
（实测这类源占多数），抓了只是把网页原样抄一遍。**能省掉的 400 次请求是这一节的收益。**

**提取链**

```
fetch 原文（text/html，上限 4MB，超时 20s）
  → linkedom 解析 → @mozilla/readability 提取
  → 结果文本 < max(500, feed 正文 × 1.2) → 判定"没提出更多内容"，保留 feed 正文
  → 否则清洗（§7.1 L1 的同一套白名单）后落库
```

1.2 倍余量的理由：Readability 会把导航、作者栏、相关阅读剥掉，因此它的**字符数可以略少于**页面容器；
但若比 feed 正文还短，说明它抓错了节点（常见于"正文就在 `<article>` 里但页面有多个 `<article>`"），
这种情况保留 feed 原文比塞一段错内容好。

**失败不丢条目**（1.14 的硬判据）：抓取 404、超时、非 HTML、Readability 抛异常，全部**不改变**该条目已有的
feed 正文，只写 `stage_error` 记录原因并把 `stage` 推进到 `extracted`。不做退避重试的理由：
正文提取是"锦上添花"，为一个 404 的原文章节重试 3 次会白占 4 个并发槽位，而用户已经有可读的 feed 正文。

**落库字段**

| 字段 | 取值 |
|---|---|
| `entry_contents.html` | 清洗后的 HTML（gzip） |
| `entry_contents.extracted_by` | `feed`（feed 自带） / `readability`（抓到原文并提取成功） |
| `entries.stage` | `pending`（等提取） → `extracted` |
| `entries.stage_error` | 回退原因；成功时为 NULL |
| `entries.word_count` | 按最终正文重算（中文按 2 字符/词） |

**实测（Node 24.13 / Windows x64，5 个真实站点页面）**

| 站点 | 页面体积 | 耗时 | 提取字数 / 语义容器字数 |
|---|---|---|---|
| jvns.ca | 31 KB | 50 ms | 0.93 |
| simonwillison.net | 77 KB | 128 ms | 1.00 |
| tonsky.me | 37 KB | 46 ms | 0.99 |
| martinfowler.com | 26 KB | 34 ms | 0.92 |
| blog.nelhage.com | 22 KB | 30 ms | 0.94 |
| css-tricks.com | 695 KB | 880 ms | 0.92 |

§5.2 里"1.5 ms/篇"是 60 段正文的合成输入；**真实网页是 30~900 ms**，差距来自 HTML 解析而非 Readability 本身。
因此 `extract` 的并发上限保持 4（§5.1 内存闸门），不因为"反正才 1.5ms"往上调。

**v1.17 补记：pending 与 jobs 会脱钩，必须有兜底**

`entries.stage = 'pending'` 的含义是"等提取"，但"等提取"的唯一实现是
`jobs` 表里有一条 `extract` 任务。**这是两张表，它们会不一致**，而且真的
不一致过：

| 事实 | 数值（实测本机库 2026-10-28） |
|---|---|
| `stage = 'pending'` 的条目 | 514 |
| 其中在 `jobs` 里有对应任务的 | **0** |
| 这批条目的 `fetched_at` 范围 | 全部早于提取功能上线那次提交 |

成因很具体：1.14 之前的 `upsertItems` 把 `stage` **硬编码**成 `'pending'`
（那时还没有提取任务这种东西）。功能上线后，入队只发生在"新抓到的条目"
那条路径上 —— 升级不会回头认领旧数据。于是那批条目永远停在 pending：
列表里看得见、点开只有 feed 给的几十个字、队列里根本没有它的活。
需求方反馈的「少数派很久之前的没有正文」就是这个形状：**同一篇文章的
新条目有全文、旧条目没有**，差别不在站点，在入库时间。

修法分两半，缺一不可：

1. **上游只给"需要提取"的条目置 pending**（1.14 已改对，`store.ts` 里
   按 `feedChars < MIN_FEED_CHARS` 分叉）。这一半保证不再新增。
2. **下游有个兜底，把"pending 但没有在飞任务"的条目重新排队**。
   这一半负责让存量收敛 —— 判据刻意不写成"某次升级之前的条目"，
   因为将来任何一条新写入路径漏入队时，同一个判据仍然成立。

兜底实现见 `src/server/extract/backfill.ts`。`serve` 启动 30 秒后跑一轮、
之后每 5 分钟一轮：

| 参数 | 取值 | 理由 |
|---|---|---|
| 判据 | `stage='pending'` 且无 `pending`/`running` 的同 dedupe_key 任务 | 不是"列表为空"，是"队列里没有它的活" —— 后者才是 pending 的定义 |
| 排除 `dead` | 有 | 试过三次都失败的条目每小时重排一次会变成永不停止的抓取循环 |
| 每轮条数 | 200 | 一场升级留下的积压分几轮吃完，不一次打满队列（extract 只有 4 个槽位） |
| 频率 | **5 分钟** | 实测积压 514 条：每小时一轮要 3 小时才收敛，那个窗口里用户看到的仍是"旧文章没正文"；5 分钟一轮 15 分钟吃完。排队本身还被并发上限 4 压着，不会一次打几百个请求 |
| 稳态成本 | 0 命中、0.16ms | 跑得勤不构成性能问题；真正的成本是命中时的抓取，而命中就意味着确实有活没干 |
| 幂等 | `dedupe_key = extract:<id>` | 定时器反复跑不需要记"上次补到哪了" |

**实测收敛（本机 514 条积压，重启后）**：

| 时刻 | `extract/done` | `entries.stage=pending` |
|---|---|---|
| 重启前 | 46 | 514 |
| +30s（首轮排入 200） | — | 514 |
| +150s | 247 | 314 |
| +200s（第二轮排入） | — | 114 |
| +480s | 561 | **0** |

`dead` 的 extract 任务为 **0** —— 那批条目里没有一条是"试过三次仍失败"，
全是"从来没被排过队"。少数派那个源 17 条全部 `extracted_by = readability`，
正文从 155~463 字变成 1311~43540 字。最短那条（1311）是图注为主的短文，
不是提取失败 —— 所以判据不能写成"正文一定很长"。

**为什么不更激进**（`BACKFILL_BATCH` 从 200 调到 500、间隔缩到 60s 的话
514 条两分钟就能吃完）：首次启动的瞬时并发会短期占满 extract 的 4 个
槽位，把新抓到的条目挤到后面。15 分钟收敛对"补历史遗留"已经够快。

---

## 八、AI 分析（分类分级）

### 8.1 模型配置

```jsonc
// settings.ai_config
{
  "provider": "openai-compatible",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "AI_API_KEY",     // 环境变量名。v2.0 起还有第二个来源：data/secrets.json（§8.8）
  "models": {
    "fast":   "deepseek-chat",   // 粗筛、标签、打分
    "strong": "deepseek-chat",   // 摘要、簇归纳、简报
    "embed":  "text-embedding-3-small"
  },
  "limits": { "rpm": 60, "tpm": 200000, "concurrency": 2 },
  "budget": { "dailyUsd": 1.0, "monthlyUsd": 20.0 },
  "fallback": { "onBudgetExceeded": "fast_only" }
}
```

### 8.2 结构化输出

```ts
const EntryAnalysisSchema = z.object({
  summary:    z.string(),                                  // 3~5 句
  key_points: z.array(z.string()).min(2).max(6),
  category:   z.string(),                                  // 必须来自给定 slug 列表
  topics:     z.array(z.string()).max(5),
  entities:   z.object({
    people: z.array(z.string()), orgs: z.array(z.string()),
    products: z.array(z.string()), tech: z.array(z.string()),
  }),
  importance: z.number().int().min(0).max(100),
  novelty:    z.number().int().min(0).max(100),
  sentiment:  z.enum(["positive","neutral","negative","mixed"]),
});
```

**稳健实现（最易被低估的一环）**：

```
1. 优先 response_format = { type:"json_schema", strict:true }   // OpenAI 系
2. 不支持 → { type:"json_object" } + 提示词内嵌 schema            // DeepSeek / Ollama
3. 文本 → 去 ```json 围栏 → JSON.parse → zod.safeParse
4. 校验失败 → 把 zod 报错回灌模型重试一次（自愈）
5. 二次失败 → stage=failed，进「问题条目」列表，不阻塞流水线
```

小模型 / 本地模型 100% 会出现 JSON 不合规。没有这套，流水线会持续堆失败条目。

### 8.3 提示词约束

```
你是一名信息分析编辑。把一篇资讯压缩成结构化情报卡片。

硬性要求：
1. summary 用陈述句直接给结论与数据；禁止"本文/该文章/作者认为"等空话开头。
2. key_points 每条须含具体事实（数字、名称、时间、结论），不写泛泛判断。
3. 原文未提及的一律不得推断补充。信息不足时相应字段留空数组而非编造。
4. category 必须从「可选分类」中选一个 slug；无法归类选 other。
5. topics 优先复用「已有标签」；确无合适才新建，最多 5 个。
6. importance 评分基准：
   90+ 行业格局变化 / 重大技术发布 / 直接影响读者工作
   70~89 有明确新信息与分析价值
   40~69 常规更新、有参考价值的经验
   0~39 营销稿、转述、无增量
7. 只输出 JSON，不要解释文字或 Markdown 围栏。
```

### 8.4 分类分级落地

- **受控分类法**：AI 只能从给定 `slug` 列表选，不能自造。每类有 `hint` 字段（判定说明），**填好 hint 能显著提升一致率**。
- `importance` 0~100 → `tier` 四级：`must_read / worth / normal / noise`。UI 用红/橙/灰条区分，`noise` 默认折叠。
- 准确率靠「黄金测试集 + 混淆矩阵」验证，不凭感觉。

### 8.5 成本控制

| 手段 | 做法 | 预估收益 |
|---|---|---|
| 分类分级粗筛 | 关键词粗判 + 小模型打分，低分只存不入精读 | 高噪音源省 50%+ |
| 分级模型路由 | 粗筛 `fast`；摘要/簇/简报 `strong` | 降 60~80% |
| 输入截断 | 只喂标题 + 摘要 + 前 4000 字 | 降约 50% |
| 批量合并 | 同源同日 5~10 条合并为一次请求 | 省 30~40% |
| 幂等缓存 | 正文 hash 未变不重分析 | 视源重叠度 |
| 预算闸门 | 累计超 `dailyUsd` → 降 `fast_only`，再超则暂停分析 | 防账单爆炸 |

### 8.6 客户端实现与失败分类（v1.19 新增）

**不引 `openai` SDK。** 本项目的 AI 依赖只有两个端点（`/chat/completions`、
`/embeddings`），请求体是普通 JSON。SDK 会带进几十个传递依赖、它自己的重试与
超时策略，以及一个要在 SEA 打包里额外处理的环境探测分支。一个 `fetch` 加一个
zod schema 就能覆盖全部需要，而且失败点只剩我们自己写的那几处。

**请求形状**

```
POST {baseURL}/chat/completions
{ model, messages, temperature, max_tokens,
  response_format?: { type:'json_schema', json_schema:{ name, schema, strict:true } }
                  | { type:'json_object' } }
```

**结构化输出的降级链（§8.2 的落地版本）**

| 级 | 条件 | 动作 |
|---|---|---|
| 1 | 默认 | `response_format = json_schema` |
| 2 | 级 1 返回 4xx 且报文里提到 `response_format` / `schema` / `response format` | 记住该 baseURL 不支持，降 `json_object` |
| 3 | 级 2 也 4xx | 降纯文本 + 提示词内嵌 schema |
| 4 | 拿到文本 | 去 ```json 围栏 → `JSON.parse` |
| 5 | zod `safeParse` 失败 | 把 issues 回灌，重试**一次** |
| 6 | 二次失败 | 返回 `{ ok:false, kind:'schema' }`，由调用方决定是否进死信 |

「记住不支持」是每个 `AiClient` 实例内的一个 `Set`，**不是持久化配置**：
服务商升级后重启即重试，用户不需要去改一个他看不懂的开关。

级 2 的判据必须看报文而不是只看状态码。实测部分网关对任何多余字段一律回
`400 Bad Request`（不带原因）；若按"4xx 就降级"处理，一个真的写错的模型名
也会被当成"不支持 json_schema"吞掉，然后拿去跑三次纯文本 —— 用户看到的是
"模型输出格式总是不对"，而真正的原因在第一个 400 里。

**重试的三层，各自的边界**

| 层 | 触发 | 策略 |
|---|---|---|
| 传输层 | 连接失败 / 超时 / 429 / 5xx | client 内部退避重试 2 次（1s、3s），带 `Retry-After` 时优先用它 |
| 结构层 | 文本不是合法 JSON，或 zod 校验失败 | 回灌 issues 重试 1 次 |
| 其余 4xx | 401/403/404/422 | **不重试**。key 错、模型名错、参数错，重试只是把同一个错再买一次 |

**为什么 schema 重试也必须记两条 `ai_usage`**

回灌重试是**又一次真实计费的调用**。只记成功那一次，成本账会系统性地少算
一整轮，而恰恰是"模型不听话"的那批条目最需要被看见。`ai_usage` 记的是
**调用**，不是**条目**。

**失败分类**（`AiFailure.kind`，写进 `stage_error` 与 `ai_usage.error`）

```
no-key        环境变量里没有 key（不算错误，是没配置）
http-401      key 无效
http-404      模型名/端点不存在
http-429      限流（已重试过）
http-5xx      服务端错误（已重试过）
timeout       超时
bad-json      拿到的文本不是 JSON
schema        JSON 合法但缺字段/类型不对
empty         模型返回空内容
budget        预算闸门拦截（2.5）
```

**计费**：`pricing` 是「模型 → $/百万 token」的表，`pricing.default` 兜底。
默认值是**示例价目**（写在配置文件注释里），用户应按自己的服务商核对。
未知模型按 `default` 计而不是记 0 —— 记 0 会让预算闸门对着一个永远花不完的
额度形同虚设，那是最坏的一种"看起来有保护"。

**限流（`limits.rpm`）与预算闸门同在 2.5**：两者的失败表现相同（不发请求），
放在两个步骤里实现会得到两套互不知道对方存在的闸门。

### 8.7 预算闸门的两道门与三层配置（v1.20 新增，2.5 落地时确定）

**两道门，两个动作**

| 门 | 触发 | 动作 | 为什么不是别的 |
|---|---|---|---|
| 日门 | 今日花费 ≥ `budget.dailyUsd` | 降 `fast_only`：改用 `models.fast` 照常分析 | 完全停掉会让用户当天再也拿不到摘要；降到快模型仍能产出，成本约 1/5 |
| 月门 | 本月花费 ≥ `budget.monthlyUsd` | 停：不发任何请求 | 超过月预算后再降级也还在花钱，"降级"挡不住 |

`fallback.onBudgetExceeded = "stop"` 时，日门也直接停 —— 有人就是不想降级。

**日/月都是本地日历边界，不是滚动窗口。** 用滚动 24 小时的话，"昨天 23:50 花的钱"要到今天
23:50 才滑出额度，用户早上看到的"今日已花"里含昨天傍晚的量，与直觉不符。这一点
与 §7.4 的阅读历史分桶规则同源：**按本地日历**。

**`0` 表示不限额，不是"立刻停止"。** 这是最容易被写成反面的一个值 ——
`used >= 0` 恒为真。实现里两个门都先判 `limit > 0`。

**闸门必须问在第一个 HTTP 请求之前。** 位置错了就是"先花钱再检查额度"。
验收脚本对此有专门断言：stop 档下 mock 上游的请求计数必须为 0。

**embedding 在日门不降级。** `models.fast` 是 chat 模型，向量模型没有"更便宜的同族"，
把 chat 模型名塞给 `/embeddings` 会直接 404。月门 stop 时 embedding 一起停。

**AI 配置是三层合并，不是一层**

```
1. DEFAULT_AI_CONFIG          内置兜底（空配置也能跑）
2. config.json / 环境变量      部署期（Docker、NAS 注入 AI_BASE_URL）
3. settings.ai_config         运行时（用户在设置页改的）
```

第 2 层是必须的，不是冗余：运维用环境变量注入网关地址，不可能再让用户在 UI 里填一遍。
**三层合并的坑在"空值"**：`resolveAiConfig` 对空串也走兜底，而它兜的底是第 1 层（内置默认
服务商），不是第 2 层。于是设置页里一个清空的输入框会把部署期配好的 `baseURL` 悄悄打回
默认服务商 —— 症状是"请求不知去向"，极难与缓存问题区分。所以 `composeAiConfig` 只让
**真的写了值**的字段覆盖上一层，空串/null 一律视为"没写"。设置页对应地做"留空 = 不修改"。

**`apiKey` 永远不进 settings。** 只接受 `apiKeyEnv`（环境变量名）。让它出现在设置里，
等于允许明文 key 落进 `app.db` 与每一份备份包 —— 而备份包恰恰是最容易被拷出去的东西。
`PATCH /settings/ai` 收到 `apiKey` 时返回 400 并说明该怎么做。

**为什么闸门是一个注入的回调（`CallGuard`）而不是 client 内部查库**

- `AiClient` 因此不需要知道数据库（它现在只有 config 与 key）
- 验收脚本可以注入固定返回 `block` 的 guard，断言"一个请求都没发"，而不必先把库里的花费造假
- 将来加"单次 `max_tokens` 上限"之类策略只改 guard 的实现

**`ai_usage` 的记账粒度是"调用"不是"条目"。** 一次分析因 schema 不合规重试一次就是两行。
预算闸门读的是 SUM，所以少记一条就是系统性低估 —— 而恰恰是"模型不听话"的那批条目最需要被看见。

> 上面这条"`apiKey` 永远不进 settings"在 v2.0 被需求方修订：**key 现在允许在 Web 界面填写**，
> 但落点仍然不是数据库，见 §8.8。原判断的核心（不能进备份包）没有变，变的只是"在哪儿存"。

### 8.8 API key 的落点：`data/secrets.json`（v2.0 新增，2.6 落地）

**需求方原话**：「没有 api key，在日志里会一直报错，这个报错太多了；API 不能在 web 界面中输入吗」。
两件事一起做：**key 能在界面里填**，以及**没填的时候不刷屏**。

**为什么不是写进 `settings.ai_config`**（最省事的做法）

| 落点 | 备份包 | 导出/迁移 | 换机器 | 排查时有没有人误发 |
|---|---|---|---|---|
| `settings.ai_config` | ✅ 带明文 | ✅ 带明文 | 自动带走 | 一次 `ai_config` 截图就泄露 |
| 环境变量 | ❌ | ❌ | 要手抄 | 不会 |
| **`data/secrets.json`（0600）** | ❌ | ❌ | 要手抄 | 不会（文件不在导出白名单） |

选中第三个：它同时满足"界面能填"与"不进备份"。

**格式**

```jsonc
// data/secrets.json     权限 0600（Windows 上设 ACL：仅当前用户可读）
{
  "aiApiKey": "sk-...",
  "updatedAt": 1793337600000
}
```

- 文件**不存在 = 没配 key**，不自动创建空文件（空文件会让"有配置但为空"与"没配置"不可区分）
- 读取优先级：`secrets.json` → 环境变量（`apiKeyEnv` 指定的那个）。**文件优先**，
  因为它是用户在界面上显式填的；环境变量是部署期默认值。
- 缺 key 时 `GET /settings/ai` 返回 `hasKey:false` 与 `keySource:'none'`，
  UI 显示"未配置"输入框；已配置时只返回**掩码**（`sk-…c3f9`）与 `keySource`

**API**

```
GET   /settings/ai            → { hasKey, keyMasked, keySource: 'file'|'env'|'none', ... }
PATCH /settings/ai            { apiKey: "sk-..." }   写入 secrets.json（不回显）
                              { apiKey: "" }         删除（回落到环境变量）
POST  /settings/ai/test       { }  → 一次最小的 chat 调用，返回 ok/失败分类
```

**掩码规则**：只显示前 3 位与后 4 位，长度 ≤ 8 时全掩码。**任何响应都不回显完整 key** ——
这条要写进验收脚本：`GET /settings/ai` 的响应体里不允许出现完整 key 字符串。

**`POST /settings/ai/test` 为什么值得单独一个端点**：用户填完 key 最想知道的是
"这个 key 到底能用吗"。让他去抓一篇文章等 8 秒、再回来看有没有摘要，是把验证成本
转嫁给用户。这个端点发一次 `max_tokens: 1` 的请求，失败时把 `AiFailureKind`
原样返回（`http-401` 与 `network` 的处置完全不同）。

**"没配 key"不能每篇报一次**

`AiFailureKind.no-key` 是**全局配置状态**，不是某篇文章的属性。现状（实测 2026-10-30）：
745 篇待分析，每篇的 analyze handler 都 `ctx.log('analyze 失败', {...})` 一行，
20 条任务 30 秒内刷 20 行。真实库会是 745 行 + 每轮 backfill 重来。

改成三条：

1. **同类全局失败在一个进程生命周期里只记一次**（`no-key` / `budget` / 限流冷却）。
   实现是一个 `Set<purpose>`，key 为 `'no-key'` 时第二次起静默。
2. **条目不再逐条写日志**，但仍然不改 `stage`（§8.6 已定：全局失败不落 failed），
   于是"这 745 篇没分析"这件事由 `/stats` 的 `ai.level` + `ai.reason` 常驻表达。
3. **启动时打一条横幅**，明确写出"未配置 API key，N 篇待分析，去『配置 → AI』填"。
   横幅有 N，一次就能看出影响面 —— 这正是 745 行日志想表达而没能表达的信息。

**为什么不是"没 key 就不排队"**：key 可能五分钟后就被填上，届时那 745 篇应该自己开始分析。
不排队的话需要另做一个"填完 key 触发全量重排"的动作，而那个动作一旦漏了，
症状是"我配了 key 但什么都没发生"。

### 8.9 单篇总结与可编辑提示词（v2.0 新增，2.7 落地）

**需求方原话**：「对于单个文章，提供总结按钮，并可以编辑总结提示词」。

这与 2.2 的「AI 摘要」不是同一件事：

| | 2.2 的 AI 摘要 | 2.7 的单篇总结 |
|---|---|---|
| 何时跑 | 入库自动排队 | 用户点按钮 |
| 提示词 | 固定（`analyze-v2`），改了会让历史数据不可比 | **用户可编辑**，每个指纹独立缓存 |
| 输出 | 结构化 JSON（分类/tier/topics/importance） | 自由 Markdown |
| 成本 | 每篇一次，无法避免 | 只在用户要的时候 |

**为什么可以开放提示词编辑**：§15.15 那条"提示词不开放编辑"的理由是
「改了会让历史数据与新数据不可比」—— 那个理由对**分类分级**成立（tier 变了，
历史筛选就混乱了），对**总结**不成立：总结是"我此刻想看什么"，本来就该随人变。

**缓存按提示词指纹，不是按条目**

```
summaries (entry_id, prompt_fp, body, model, created_at, in_tokens, out_tokens)
PRIMARY KEY (entry_id, prompt_fp)
```

`prompt_fp = sha256(system_prompt + '\u0000' + user_template_version)`。
于是：

- 提示词没改，再点一次 = **0 次请求**（直接返回库里的）
- 改了提示词 = 另存一条，旧的不删（用户可能改回来）
- 「恢复默认」= 提示词回到内置值，指纹回到默认指纹，**默认那份如果存在就立刻命中**

**为什么按指纹而不是"覆盖上一次"**：覆盖的话，用户改错提示词、点一下、
再改回来 —— 原来那份好好的总结已经被覆盖没了，得重新花钱。按指纹存是
多几 KB 换"随时可回退"。

**API**

```
POST  /entries/:id/summary   { force?: boolean }  → { ok, summary, cached, failure? }
GET   /entries/:id/summary                        → 当前提示词下的缓存（没有则 null）
PATCH /settings/ai           { summaryPrompt: "..." }     null/"" = 恢复默认
GET   /settings/ai           → { summaryPrompt, summaryPromptDefault, summaryPromptIsDefault }
```

**同步返回而不是入队**：与 `POST /entries/:id/analyze` 同理由 —— 用户点一下等 5 秒
比"排队了但不知道什么时候好"更符合预期。

**提示词的形状是"模板"不是"自由文本"**

允许编辑的是**指令部分**，正文由服务端拼接。模板里允许占位符
`{{title}}` / `{{body}}` / `{{summary}}`（AI 摘要）/ `{{highlights}}`（本篇高亮）：

- 一个完全自由的提示词框，用户很可能忘了写"正文在这里"，于是模型只能靠标题编
- 占位符缺失时服务端**追加**在末尾并记一条 warn，而不是静默吞掉

`{{body}}` 的截断长度 `SUMMARY_BODY_CLIP = 12000`（比 analyze 的 4000 大：
总结要覆盖全文，而 analyze 只需要判断这一篇讲什么）。

**输出是 Markdown，渲染复用简报页那套**

`src/client/digest/markdown.tsx` 的 `parseMarkdown` 已经在用（3.5 落地），
它产出 React 节点、不用 `dangerouslySetInnerHTML`。总结页直接复用它 ——
**不再写第二个 Markdown 渲染器**，否则"模型输出不能变成 HTML"这条约束要守两遍。

---

## 九、每日简报

### 9.1 生成流程

1. **聚类**（每 6h）：窗口内条目（约 100~200 条）暴力层次聚类，毫秒级完成，无需向量库。
2. **簇级归纳**：LLM 综合 N 篇，输出结构化结果。
3. **简报生成**（每天 08:00）：取 heat 排序前 12 簇，生成 Markdown。

### 9.2 簇级归纳输出的关键字段

```json
{
  "title":      "12 字以内事件标题",
  "summary":    "综合 N 篇的综述，150 字内：发生了什么、各方观点差异、最新进展",
  "key_points": ["..."],
  "consensus":  ["多篇一致的事实"],
  "conflicts":  [{"claim": "某方说法", "sources": ["来源A","来源B"]}]
}
```

`consensus` / `conflicts` 是简报价值的来源。同类项目（Feed2040、feedforge、daily-briefing 等）普遍停在「摘要 + 打分排序」，没有跨篇聚合与多源冲突识别 —— 那样只是把 20 条摘要堆在一起，不构成「每天值得看」。

### 9.3 简报结构

```
## 今日要点        3 条，各一句，最重要的事
## 分主题展开      每主题 2~4 句 + {{cite:cluster_id}} 占位符
## 值得一读        低热度但高价值长文 1~3 篇
## 今日高亮        你当天标记的要点（§11.4）
```

**引用安全**：`{{cite:id}}` 占位符由程序替换为真实链接，防止模型编造 URL（比事后校验便宜）。

**约束**：每个论断必须来自输入；单来源主题强制标注「单一来源，待验证」。

### 9.4 聚类的阈值、linkage 与引用安全（v1.21 新增，3.1~3.3 落地时确定）

**聚类与去重是两个问题，阈值必然不同**

| | 判什么 | 阈值 | 依据 |
|---|---|---|---|
| 去重 §7.1 L2 | 这是不是**同一篇文章** | 0.95 | 近乎逐字相同 |
| 聚类 §9.1 | 这是不是**同一件事的不同报道** | hash 0.35 / 语义 0.80 | 信息点重叠、写法各不同 |

混用会两头都错：用去重阈值做聚类，只有转载稿能聚上；用聚类阈值做去重，同一板块
的文章会被判成重复。实测（本地字符 n-gram 向量）同事件两两 0.40~0.78、异事件
0.00~0.30，0.35 落在这个空档里。

**hash 与语义向量必须用两套阈值。** 语义向量里"都在讲芯片"的两篇也能到 0.5，
用 0.35 会把整个科技板块聚成一坨。0.80 是按同事件 0.80~0.90、异事件 ≤0.60 取的，
写成了**默认值**而不是常量 —— 换 embedding 模型后要用自己的数据校准。

**不用单链接（single linkage）。** 单链接按"最近的一对"合并：A 与 B 近、B 与 C 近，
就把 A、B、C 并成一簇，而 A 与 C 可能毫无关系。这是"误聚"最常见的来源，且在
200 条的规模上完全看不出来（一堆 2~3 条的簇里混进一个 20 条的大簇）。用
average linkage（成员两两相似度的均值）后，簇越大门槛越难过，串不起来。
验收脚本对此有一条专门的链式三联构造：A-B 20°、B-C 20°、A-C 40°，
单链接切 1 簇、average 切 2 簇。

**不用 k-means。** 簇数未知，而"今天有几件事"正是要算出来的东西。

**向量来源整体切换，不逐条挑。** 语义向量（维度 768）与本地 hash 指纹（256）
的余弦恒为 0，混在同一批里会让一部分条目永远自成一簇，表现为"聚类结果里有很多
单条" —— 那是个极难归因的现象。所以先统计覆盖率，≥50% 就整体用语义向量，
否则整体退回 hash，并把这个决定（`source` + `semanticCoverage`）返回给调用方。

**heat 是乘不是加。** 源数、条数、重要性、新鲜度四项相乘，任一项趋零时热度就低。
相加会让"单一来源 + 模型给了高重要性"挤掉"五个源都在报" —— 而后者才是用户
早上真想知道的事。源数与条数开根号压住"一个源刷 30 条"的灌水。

**单来源簇的 conflicts 强制清空。** 一篇报道不可能与自己冲突。让模型"找出分歧"
它一定会礼貌性地编一条出来 —— 这不是提示词能解决的（提示词里已写"只有一篇时
必须留空"，模型仍会偶尔违反），所以要在**代码里**兜。

**conflicts 的来源必须真实存在，且至少两方。** 模型会写"据多家媒体报道"、
"新浪科技频道"（真实来源叫"新浪科技"）。归纳后校验一次，不存在的来源剔掉并记进
`droppedSources`；只剩一个有效来源的"分歧"整条剔除 —— 一方说法无法交叉验证，
它更可能是一句普通的陈述被模型误当成了分歧。

**简报的引用安全比"事后校验 URL"更强。** 校验只能判"像不像 URL"，判不出
"这个链接指向的是不是它说的那件事"。占位符方案的失败模式是"没有链接"，
可见；伪造链接的失败模式是"有链接但错"，用户点了才知道。所以：

- 模型只能写 `{{cite:簇id}}`，id 必须取自输入（输入里显式写 `id=cl_xxx`，
  否则模型会自己编 `cl_1` 这种短 id）
- 编造的 id → 正文里留可见的 `[?]`，并记进 `invalid`（静默删会让"5 条引用"
  和"2 条引用"看起来一样）
- **模型写的裸 URL 与 markdown 链接一律抹掉**（`[链接已移除]`），记进
  `strippedUrls`。提示词里写了"绝对不能自己写 URL"，但那不足以阻止它 ——
  训练语料里"据 xxx 报道（https://...）"太多
- 模型完全没写引用时不回填（那等于猜），而是把 heat 前几名挂到文末

**简报重跑是覆盖且 id 不变。** 简报可能已被推送到邮件/Webhook，换 id 会让
那些地方引用的链接失效。用 `ON CONFLICT(user_id, kind, period_start) DO UPDATE`。

**聚类整窗重算，不做增量。** 聚类是窗口函数（输入是"最近 24 小时的全部条目"），
任何一条新条目进来都可能改变分组。增量更新的结果会与全量重算不一致，而那种
不一致既无法验证也无法向用户解释。代价是每次跑都重算 200 条的 n² 相似度矩阵 ——
实测 100 条 < 30ms，可以接受。

### 9.5 三种否决与 day_key 的由来（v1.22 新增，3.4 落地时确定）

**"该不该出简报"有三个独立的否决条件，每个都必须留下持久痕迹**

| 情形 | 痕迹 | 下次何时再试 |
|---|---|---|
| 没到点 | 无（纯时间判断） | 下一分钟自动命中 |
| 到了点但没内容 | `digest_skips` 一行 | **当天不再试** |
| 有内容但生成失败 | `digest_attempts` 一行 | 10 分钟后 → 60 分钟后 → 当天放弃 |
| 已生成 | `digests` 一行 | 明天 |

只用"`digests` 里有没有今天的行"来判断，会把前两种混为一谈，代价分别是：

- 把"没内容"当成"没做过" → 每分钟重试一次，一天 1440 次，每次都聚类 + 调模型。
  这不是一个理论风险：08:00 之后用户不会再盯着看，而队列会一直空转。
- 把"失败"当成"做过了" → 一次网络抖动就让当天永久没有简报，而它本来只是重试一次的事。
- 把"失败"当成"没内容" → 同理会全天重试。

所以三张表各行其是，**语义不能合并**：skip 是"确定今天不做了"，attempt-fail 是"等会儿再试"。

**`period_start` 必须与 `day_key` 分开。** 它原本同时承担两个含义：

1. 这份简报**覆盖**哪段时间的条目（窗口起点 = 昨天 00:00）
2. 这份简报**属于**哪一天（幂等键）

合并的后果：用户把生成时间从 08:00 改到 09:00，窗口起点也跟着移一小时，唯一索引
`(user_id, kind, period_start)` 不再命中，于是同一天出现**第二份**简报 —— 而两份内容
不同、且没有"哪份是新的"的标记。这不是推测，是 3.4 写测试时第一版就撞上的。

migration 0004 因此拆出 `day_key`（本地日 00:00，真正的幂等键），并保留旧的
`period_start` 唯一索引（它仍有价值：挡住手工导入两份时间窗完全重叠的简报）。

**`day_key` 必须按本地日算，不能按 UTC 截断。** `period_start / 86400000 * 86400000`
是 UTC 午夜；东八区下一份 08:00 的简报会被算到 UTC 前一天 16:00，与真正前一天的
简报撞唯一索引 → 迁移直接失败。SQL 里的正确写法是过
`'localtime','start of day','utc'` 三步再转回 epoch（实测得到本地 00:00:00.000）。

**调度器只入队，不生成。** 生成一份简报要调十几次模型（每簇一次 + 简报一次），
几十秒起步，塞进 `setInterval` 会把主循环卡住 —— 而那个主循环还要响应 HTTP。
代价是"08:00 出简报"实际上是"08:00~08:01 入队，队列空闲后开始生成"，
这个粒度对日刊完全够。

**`handlers['digest']` 的失败要抛，与 `embed` 相反。** 向量是可选增强（没有它照样能读），
简报是用户 08:00 打开就想要的。静默吃掉失败等于"今天没有简报"且没有任何痕迹。
但抛出去不等于无限重试：`digest_attempts` 的退避把它限制在每天 3 次。两层保护各管
一件事 —— 队列管"进程崩了还能再试"，退避管"不因为一次网络抖动把 3 次配额在 30 秒里烧光"。

**`listUsersForDigest` 用 `json_valid` 挡坏配置，而不是让 `json_extract` 抛。**
一条坏的 `digest_config` 不该让整个调度扫描停摆 —— 那是一个用户写坏了配置，结果是
**所有用户**（包括他自己）从此再没有简报，而日志里只有一句 "malformed JSON"
指向不了是谁。写坏配置的用户退回默认（开启），继续收到简报。

**`/digests/status` 必须注册在 `/digests/:id` 之前。** 反过来的 404 措辞是
「简报不存在」，与"今天还没有简报"极为相似 —— 它看起来不像 bug，像一个正常状态。
§7.5 在 `/entries` 的 `history` / `mark-all-read` 上踩过同一个坑。

### 9.6 简报主链的四个缺陷（v2.2 修复）

**需求方原话**：「简报功能异常」。

3.1~3.5 的验收全绿时，简报功能**在生产里从来没成功过一次**。
`data/app.db` 的实测证据：`digest_attempts` 17 行全部是"没配置 API key"，
`digests` 0 行，而真正跑主链的那些次**一行 attempt 都没落** —— 因为它们
都抛在记 attempt 之前。日志里那句话是 info 级的「简报未生成」，看起来像
正常跳过。

| # | 缺陷 | 症状 | 根因 |
|---|---|---|---|
| ① | `loadMembers` 查 `e.content_text` / `e.feed_content_text` | 有内容时 `runDigest` 抛 `no such column` | 这两列**从 0001 起就不存在**；正文一直在 `entry_contents.html`（gzip BLOB，§13.3） |
| ② | `saveDigest` 的 INSERT 漏 `day_key` | 落库后 `day_key` 恒 NULL | 列清单里没写它（0004 加了列，写入侧没跟上） |
| ③ | ② 的连带 | 调度器**每分钟**重跑完整流程；UI 永远 `pending`；同一天落多份 | `digestDue`/`digestStatus` 都按 `day_key` 判"今天做过没"；唯一索引 `uq_digest_day` 对 NULL 不生效（SQLite 把 NULL 视为互不相等） |
| ④ | `runDigest` 的「**不抛异常**」契约没兑现 | 异常直接冒到 job handler，被吞成 info 级一行 | 实现只在四条显式判定路径上返回；`recordAttempt` 在异常位置之后，所以一次都不落 → 退避机制完全不存在 |

**为什么既有验收抓不到**：3.1~3.5 的断言分两类 —— 纯函数（聚类 / 引用替换 /
调度判定）和**在调模型之前就返回**的路径。`m3-04` 确实调了 `runDigest`，
但它只走「没 key」与「窗口为空」两条，主链上一次都没被真正跑过。

这不是"断言写少了"，是**验收的覆盖面缺口**：每一步各自正确，接起来的
那条路没人走过。新增 `m3-06-digest-chain.mjs`（25 条）专门跑主链，
断言全部落在"库里的产物"与"判定函数在生成之后的返回值"上 ——
而不是"代码里有没有某个字段"，后者对 ② 这种"字段在、但没写进 INSERT"
的缺陷照样能过。

**为什么 ① 的修复要把解压放到 JS 里**：`substr` 作用在 gzip 字节上会切出
半截流，`unpackText` 随后在 gunzip 里抛 `unexpected end of file`。
所以 SQL 只取 BLOB，解压 + `htmlToText` + 截断全在 JS 侧，
且 `PER_ENTRY_CLIP` 从 `summarize.ts` 导出共用一份 —— 两处阈值不一致时
症状只是"模型看到的正文莫名短了一截"，很难归因。

**迁移 0008 的必要性**：代码修好只保证**新**行有 `day_key`。已落库的
NULL 行仍会让那份简报停在"今天没生成"，下一次调度再生成一份新的。
0008 按 `period_start` 所在的本地日回填（与 0004 对旧行的处理同一套算法，
不能用 `period_start / 86400000 * 86400000` —— 那是 UTC 午夜，东八区下会
与真正前一天的简报撞唯一索引）。只在 `day_key IS NULL` 时更新，可重复执行。

### 9.7 数据清洗与省 token 方案（v2.2 列入计划，**未实现**）

**需求方原话**：「AI简报的token消耗太多，将数据清洗和节省token的方案列入之后的修改计划」。

本节是**计划**，不是已完成项。所有数字来自 `data/app.db` 的实测（379 次
调用），不是估算。

#### 9.7.1 现状：钱花在哪

| 指标 | 实测值 | 说明 |
|---|---|---|
| 单篇分析平均输入 | **1195 tokens** | 标题 + 4000 字正文截断（`BODY_CLIP`）+ 分类法提示词 |
| 单篇分析平均输出 | **976 tokens** | 结构化 JSON（摘要 / 6 条要点 / 分类 / 5 个 topics / entities 四类 / 三个分数） |
| 输入:输出 比 | **约 1.2 : 1** | **这是最大的浪费点** —— 产出只有一张卡片，却让模型写了近千 token |
| 失败调用的 token 浪费 | **701,448 tokens** | 379 次调用 **全部失败**，`ok=1` 一行都没有 |
| ├ schema 不合规 | 200 次 / 346,290 tokens | 字段类型或条数不符（`entities` 被返回成数组、`novelty` 是字符串） |
| ├ bad-json | 78 次 / 212,159 tokens | 回复里找不到可解析的 JSON |
| ├ empty | 48 次 / 142,999 tokens | 模型返回空内容 |
| └ http-503 | 50 次 / 0 tokens | 上游不可用（不烧 token，但烧时间与重试配额） |
| 正文长度 | 平均 2812 字节，**21.6% 超过 4000** | 被 `BODY_CLIP` 截断的那部分白读了 |

两个结论：

1. **输出侧比输入侧更值得砍。** 输入 1195 看着不多，但输出 976 意味着
   "生成一张卡片"的成本约等于"读一遍正文"。而卡片里 `key_points` 6 条、
   `topics` 5 个、`entities` 四个数组、三个 0~100 分数 —— 列表页与筛选
   真正用到的只有 `summary` / `category` / `tier`。
2. **重试是最贵的浪费。** 701,448 tokens 全部花在失败上，而失败原因里
   `schema` + `bad-json` + `empty` 共 326 次属"模型没按格式答"，
   可通过"更小的输出契约 + 更强约束"直接消除。

#### 9.7.2 措施清单（按性价比排序）

**P1 拆两步：先判后写（预期省 40~55%）**

现在一次调用同时要"读正文并判断"与"产出完整卡片"。拆成：

| 步 | 输入 | 输出 | 用途 |
|---|---|---|---|
| ① 判 | 标题 + 前 1200 字 | `{importance, category, novelty}`（约 30 tokens） | 列表排序与筛选**只需要这三个** |
| ② 写 | 标题 + 前 1200 字 + ①的结论 | `{summary, key_points≤3}`（约 200 tokens） | 只在用户**打开条目**时才跑 |

理由：RSS 的用户行为是"扫 100 条、读 5 条"。现在 100 条全做完整卡片，
95 张永远没人打开。按需生成是这一项的主要收益。
代价：列表里 `summary` 变空（只剩 `excerpt`），需要 UI 明确"展开后才有摘要"。

**P2 压缩输出契约（预期省 25~35% 的输出 token）**

| 字段 | 现在 | 改为 | 理由 |
|---|---|---|---|
| `key_points` | 2~6 条，每条一句话 | **≤3 条，每条 ≤20 字** | 列表只显示 1 行摘要；6 条要点在窄列表里根本读不完 |
| `topics` | ≤5 个 | **≤3 个** | 超过 3 个时用户不会用它们筛选 |
| `entities` | 四个数组 | **默认不产出**，或 `?extended=1` 才要 | **没有任何 UI 读它**，只被存着 |
| `novelty` / `sentiment` | 必填 | **可选** | 分级只用 `importance`（§8.3 已写明 tier 由 importance 派生）；sentiment 无消费方 |

`entities` 与 `sentiment` 是**纯死重**：进库、进备份、进每日简报的提示词，
但没有一个界面元素读它们。删掉它们同时降低 schema 失败率 ——
实测 `entities: Expected object, received array` 是最高频的失败原因，
200 次 schema 失败里占了大头。

**P3 正文清洗前置（预期省 15~25% 的输入 token）**

现在喂给模型的是 `htmlToText` 之后的全文前 4000 字，包含：

- 网站导航残渣（"首页 > 科技 > 正文"、"上一篇 / 下一篇"）
- 版权与作者声明（"本文来自微信公众号…"、"转载请注明出处"）
- 图片 alt / 图注（`htmlToText` 会把 alt 拼进去）
- 重复的导语（`excerpt` 与正文第一段常常一字不差）

清洗规则（全部是确定性规则，不需要模型）：

| 规则 | 省多少 | 风险 |
|---|---|---|
| 去尾部版权段（匹配"转载请注明 / 本文来自 / 责任编辑 / 版权归"等 12 个模式，只删最后 300 字内的匹配） | 约 5~8% | 低（只动尾部） |
| 去"上一篇/下一篇/相关阅读"整段 | 约 3% | 低 |
| 正文 > 1200 字时**取前 800 + 后 400** 而不是前 1200 | 不省 token，但信息密度提高 | 中（结论常在尾部） |
| `excerpt` 与正文首段重复时只喂一份 | 约 4% | 低 |
| 中文标点 / 连续空白归一 | 约 2% | 无 |

**P4 结构化输出的失败不再整篇重试（预期省 20~30% 的失败 token）**

实测 326 次"格式不对"的重试，全部**重发了完整输入**。改为：

- schema 校验失败时把 `zod` 的 `issues` 回灌，**只要求补差异字段**，
  而不是重发整篇正文（输入可只剩"上次输出 + 错误说明"，约 300 tokens
  而不是 1195）
- `empty` 与 `bad-json` 不重试，直接降级到纯文本模式一次（现在会重试 1 次）
- 同一 `baseURL + model` 连续 3 次 schema 失败 → 熔断 10 分钟，
  期间不再选中该模型（现在会一直撞同一面墙）

**P5 简报成本独立治理（简报是 N+1 次调用）**

一份简报 = 每簇一次归纳 + 一次生成，簇上限 12 → 最多 13 次调用/天。

| 措施 | 省多少 |
|---|---|
| 单来源簇**不调模型**：直接用那篇的摘要当簇综述（`describeSingleSource` 已有"单一来源，待验证"的标注逻辑，不需要模型再写一遍） | 单来源簇通常占 30~50% |
| `MAX_ENTRIES_PER_CLUSTER` 从 8 → 4（同事件第 5~8 篇信息增量极低） | 约 30% 的归纳输入 |
| 低 heat 簇不参与归纳（低于阈值直接进"今日事件索引"而不写综述） | 按分布 20~40% |
| 简报正文改 `fast` 模型写一遍（现在是 strong 直接写） | 单价差 3~5 倍 |

**P6 观测：把 token 花在哪变成可见的**

现在 `ai_usage` 记了 `in_tokens` / `out_tokens`，但 UI 只显示"今日调用 N 次"。
改成按 `purpose` 分组显示 `analyze / cluster / digest / summary` 各自
的 token 与金额，并把"失败重试占了多少"单列一行。没有这个，
上五项改完也不知道到底省了多少。

#### 9.7.3 验收方式

每条措施都要有**可测的判据**，而不是"改完感觉便宜了"：

| 措施 | 验收 |
|---|---|
| P1 拆两步 | 新库跑 100 条 → `analyze` 的 `SUM(in+out)` 比基线降 ≥ 40%；打开 5 条后 `summary` 才出现，且条数与打开数一致 |
| P2 压缩契约 | 单次 `analyze` 的 `out_tokens` 中位数 ≤ 300（基线 976）；`entities` / `sentiment` 不再出现在 schema 里且旧行仍可读 |
| P3 清洗 | 同批 100 条正文，清洗后 `LENGTH` 中位数降 ≥ 12%，且**人工抽查 20 条**确认没删掉正文事实（这一条必须人来判，自动断言只能验"删了"不能验"删对了"） |
| P4 失败路径 | 造一个恒返回错误 schema 的 mock → 重试期间总 token ≤ 输入的 1.2 倍（现在约 2 倍）；连续 3 次后熔断生效 |
| P5 简报 | 2 簇 1 单来源的样本 → 调用次数从 3 降到 2；单份简报 token 降 ≥ 35% |
| P6 观测 | `/stats` 有按 purpose 的 token 分组；UI 显示且与 `SUM` 对得上 |

**这一节不改变任何需求行**（§1.1 不动），属规格层的性能优化，
按 A.3 记为 v1.x 修订，不升 v2.0。

---


## 十、RSSHub 订阅搜索

### 10.1 目标

用户输入关键词或网站 URL，直接得到**可订阅的 RSS 地址**，不需要翻文档拼路由。RSS 工具最大的门槛是「找不到 RSS」。

### 10.2 依赖的 RSSHub 接口

| 接口 | 用途 |
|---|---|
| `GET /api/namespace` | 全部命名空间的路由清单（名称、URL、分类、语言、描述） |
| `GET /api/namespace/{ns}` | 单命名空间详情 |
| `GET /api/radar/rules` | 域名 → 路由映射，把任意 URL 反查成路由 |
| `GET /api/routes/:name?` | 老接口，返回路径数组，作兜底 |

> 公共实例 `rsshub.app` 有访问限制（需 `key`）。**必须允许配置自建实例**（`settings.rsshub.baseUrl` + `accessKey`）。

### 10.3 三种搜索路径

```
用户输入
  ├─ A. 看起来像 URL        → Radar 反查：域名匹配规则 → 候选路由
  ├─ B. 关键词（中/英）      → 在 namespace 元数据里搜（name/description/categories）
  └─ C. 已知 namespace       → 列出该 ns 下所有路由，配参数表单
        ↓
  统一返回：{ 路由模板, 示例URL, 参数列表, 分类, 说明 }
        ↓
  前端渲染参数表单 → 拼出完整 URL → 试订阅
```

### 10.4 核心设计：参数表单而非手拼字符串

`/bilibili/user/video/:uid` 应渲染成「Bilibili 用户视频」+ 一个「用户 ID」输入框。**把路由模板变成表单**是「简洁清晰」的关键。

### 10.5 实现要点

- **缓存**：`namespaces` 与 `radar` 各存一份到 `rsshub_cache`，TTL 7 天，UI 提供「刷新路由库」。冷启动拉一次（数百 KB），之后搜索全本地。
- **搜索**：本地模糊匹配 name / description / categories / 路由路径，中文用 `LIKE` + bigram。
- **试订阅**：拼出 URL 后先抓一次，确认能解析出条目再落库，避免订阅到死源。
- **整合流程**：搜索 → 选中候选 → 填参数 → **预览最近 5 条标题** → 确认订阅。

### 10.6 落地细节（v1.12 实现时确定）

**三层缓存，各有分工**：

| 层 | 作用 | 失效时机 |
|---|---|---|
| 进程内 Map（按 userId） | 一次搜索扫上千条路由，每次去 SQLite 反序列化 1MB JSON 是纯浪费 | 刷新路由库 / 改实例地址 / 进程退出 |
| SQLite `rsshub_cache` | 重启后不必重新拉上游（几百 KB + 2~5s，公共实例还有速率限制） | 7 天后标记 `stale`（**仍可用**） |
| 内置种子（5 条常用路由） | 首次启动且断网时搜索框不能是空白 | 拿到真实缓存后即被覆盖 |

**为什么"过期仍可用"而不是"过期就清空"**：上游挂掉时还能搜到 7 天前的路由，比一个干净的空搜索结果有用得多。UI 用 `stale` 提示"去刷新一下"，把决定权交给用户。

**`fetchedAt` 取两行里较早的那个**：namespace 与 radar 可能只有一个成功。取较晚会把"radar 已经 8 天没更新"掩盖成新鲜数据。取较早意味着只要有一半过期就整体提示刷新 —— 对用户更诚实。

**关键词匹配必须包含 namespace 名与它的中文说明**：用户搜「哔哩哔哩」，而路由自己的 `name` 是「用户视频」这类短语，中文名只出现在 namespace 上。少了这两个分支，最常见的搜索词搜出 0 条。

**`looksLikeUrl` 不能用 `new URL()` 一把梭**：`new URL('https://bilibili')` 是合法的（hostname=bilibili），于是裸词被当成网址，关键词搜索永远走不到。判据要求"含点且点后有内容"。

**两个上游各自独立成败**：namespace 成功、radar 失败时前者照样落库。整体回滚会让"关键词能搜但 URL 反查不行"变成"两个都不能用"，而前者占搜索量绝大多数。

**§10.5 的 "bigram" 没有落地**：实测子串匹配对上千条规模足够（<1ms），而路由名大量中英混排（「Bilibili 用户视频」），分词器反而不如直接子串稳定。留着 bigram 只会在"半个词命中"时制造噪声。

---

## 十一、高亮系统

### 11.1 难点在锚定

正文 HTML 每次重新提取（换提取器、改清洗规则、图片代理改写）都可能让字符偏移失效。只存 `start/end`，一次提取器升级就会让所有高亮错位。

采用 **W3C Web Annotation 三选择器**：

```json
{
  "quote":    { "exact": "被高亮的原文", "prefix": "前 32 字", "suffix": "后 32 字" },
  "position": { "start": 1024, "end": 1052 },
  "range":    { "startContainer": "/html/body/div[2]/p[3]", "startOffset": 12,
                "endContainer": "/html/body/div[2]/p[3]", "endOffset": 40 }
}
```

**恢复策略（按优先级降级）**：

1. `position` 直接定位 → 校验 `quote.exact` 是否匹配
2. 不匹配 → 用 `quote.exact` + `prefix/suffix` 做文本搜索（处理偏移漂移）
3. 仍失败 → 用 `range` 的 XPath（处理段落重排）
4. 全部失败 → 标 `is_orphaned`，在侧栏单独列出「原文已变化，无法定位」，**不静默丢失**

> 没有降级链，用户发现高亮悄悄错位后就不再用了。

### 11.1b 实现时的四个决定（M4 落地后补记）

**一、服务端只做 `position` / `quote` 两级，`range` 降级为前端最后一次尝试。**

`range` 是 XPath（`/html/body/div[2]/p[3]`），它是**浏览器侧的表示**：
服务端既没法验证，也没法在正文重新提取后重算 —— 它只能原样存着等前端去试。
所以服务端判不了就不假装判：两级都失配即 `is_orphaned`，`range_json` 留给
前端试用。要完整实现 `range` 一级，需要把前端的解析结果回写服务端，而那个
回写在**下一次正文变更时立刻失效** —— 收益小于复杂度。

**二、`position` 一级必须校验 `quote`，不能"位置存在就算命中"。**

只信 position 的话，正文在最前面多了一段（典型：提取器升级后加上了导语），
整篇所有高亮会**整体偏移但都"找到"了**。用户看到的是"高亮跑到别处去了"，
比"找不到"更难发现问题 —— 后者至少会让人去看原文。

**三、失配标 `is_orphaned` 并保留行，绝不删。**

删掉的话用户再也找不回来；而"原文已变化，无法定位"单独列出来是可解释的，
用户至少知道自己标过。同理，原文恢复后 orphaned 要能**自动清零** —— 它不是
一次性判死。orphaned 时 `pos_start/pos_end` 写 NULL，不保留会指向错地方的旧值。

**四、客户端必须复刻一份「HTML → 纯文本」映射，且规则与服务端 `htmlToText` 逐条等价。**

库里存的是**整篇纯文本**里的字符偏移，浏览器给的是 DOM Range，中间差着一整套
标签结构、空白折叠与块级元素换行。客户端的 `buildTextMap` 因此必须与服务端
`feeds/parse.ts` 的 `htmlToText` 用同一套规则：

| 规则 | 服务端 `htmlToText` | 客户端 `buildTextMap` |
|---|---|---|
| 块级元素之间 | 一个空格 | 一个空格（**不是换行**） |
| 连续空白 | 压成一个空格 | 压成一个空格 |
| 首尾 | trim | trim |

两条规则漂移时的表现是**高亮画在别的字上**，而画面看起来完全正常（有 `<mark>`、
有颜色），只有真的比对文本才能发现。所以 `m4-03` 有一条专门的往返断言：
刷新页面、只留服务端存的 `posStart/posEnd` 重画，仍须落在同一段文字上。

> 顺带一个实测结论：把块级分隔符从空格改成换行**不是 bug**（两者都是 1 个字符，
> 偏移完全一致，25 条断言仍全过）。真正的 bug 是**不补分隔符** —— 它让客户端
> 纯文本比服务端短，偏移整体漂移。

### 11.2 API

```
GET    /entries/:id/highlights
POST   /highlights            {entryId, start?, end?, quote?, color?, note?}
PATCH  /highlights/:id        {note?, color?}
DELETE /highlights/:id
GET    /highlights?cursor=&entryId=&color=     全局列表（游标分页）
POST   /highlights/:id/insight                 AI 解读这段（同步返回，非流式）
```

**两个接口层面的决定**：

- `POST /highlights` **由服务端算锚点**，不信前端传的 `start/end`。前端可能
  拿着旧正文（页面开了很久 / 后台重提取过），那份偏移与库里不一致。偏移与
  `quote` 对不上时按 `quote` 重算，两边都对不上则 400 让用户重选 —— 不静默存
  一条必然错位的高亮。
- `PATCH` 判断"传没传 `note`"用 `'note' in body`，不用 `COALESCE(?, note)`。
  `COALESCE` 会让空串等同"没传"，于是批注**永远清不掉**。
- `POST /highlights/:id/insight` 同步返回，不走任务队列：用户点了就是现在要看，
  排队再轮询的体验更差。失败时仍返 200 + `ok:false`（没配 key 不是"请求错了"，
  前端该显示「去配 key」而不是红色报错）。

### 11.3 UI 交互

- **选中即出工具条**：划词后在选区上方浮出 3~4 个图标（高亮 / 批注 / AI 解读），不弹侧栏、不跳页。
- **三种色即可**：默认黄、可选绿/蓝。不做调色盘 —— 选择过载会让人不用。
- **侧栏聚合**：列出本文所有高亮，点击滚动定位。
- **键盘**：选中后 `h` 高亮、`n` 加批注。

**工具条的坐标参照系必须与它被定位的父级是同一个盒子**（v2.0 修正）。
`useHighlights` 算的是 `rect.top - bodyRect.top`，即**相对 `.article-body`**；
而工具条原先直接挂在 `.reader` 下、按 `.reader` 定位 —— 于是「纸顶到正文顶」
那段距离（标题 + meta + AI 摘要卡 + 总结卡）被重复算了一次，工具条浮到纸顶。

这毛病从 M4 起就在，只是那时那段距离只有约 72px，落在 `m4-03` 的 `±120px`
容差里；v2.0 在正文上方插了总结卡，距离涨到 179px，容差被顶破才暴露。
修法是给正文与工具条加一层 `.article-wrap { position: relative }`（不加
padding/margin，左上角与正文完全重合），**不是**放宽 `m4-03` 的容差 ——
容差一放宽，"工具条贴到纸顶"就再也不会有人发现。

不改成"给 `.article-body` 自己加 `position: relative`"的理由：那个元素是
flex 项且带 `content-box` 宽度约束（`width: 80ch` + `max-width: calc(100% - 58px)`），
动它的盒模型会牵到正文宽度，而正文宽度有 `m0-09` / `m1-19` / `m1-20` 三个
脚本在量。

### 11.4 与 AI 的联动

高亮是用户**主动**表达「这段重要」的信号，比隐式阅读行为更强：

| 用途 | 做法 | 状态 |
|---|---|---|
| 修正 importance | 把近期高亮作为 few-shot 示例注入 L3 prompt | ✅ 4.4 |
| 单条解读 | `POST /highlights/:id/insight`，结合上下文解释 | ✅ 4.4 |
| 简报素材 | 日报独立小节「你今天标记的要点」 | ✅ 4.4 |
| 高亮聚类 | 高亮向量入库，「你反复标记的主题」反哺分类权重 | ⏳ M5（依赖向量层） |
| RAG 提权 | 问答检索时含高亮的段落提权 | ⏳ M5（依赖检索层） |

**why 那两项要等到 M5**：它们都要先有 embedding 入库与检索排序，现在做等于
把半成品的向量管线接一遍再返工。

**4.4 落地的三条约束**（都不是随手定的）：

- **few-shot 不足 3 条不注入**。1~2 条样本说明不了兴趣，只会把文章往"用户关心"
  的方向硬掰。代价是新用户最初几十篇分析没有个性化。
- **措辞是"可参考"，不是"必须给高分"**。写成硬规则的话，用户标过两段芯片新闻
  之后**所有文章**的 importance 都会上浮，tier 分级直接废掉。prompt 里必须写明
  「主题无关的一律按原基准」。
- **简报小节原文照列，不交给模型**。这一节的判据是"我今天标了什么"，而模型会
  概括、会漏、会改措辞 —— 那都对不上用户记忆里的那一段。最多列 5 条兜住长度。

---

## 十二、MCP 服务器

### 12.1 为什么做

个人 RSS 库天然适合 MCP：它是每天的信息输入，接进 Claude / Cursor 后能做「帮我总结本周关于芯片的报道」「我最近标记的高亮有什么共同点」。

### 12.2 实现

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "cheng-rss", version: "1.0.0" });

server.tool("search_entries", { query: z.string(), since: z.string().optional(), limit: z.number().default(10) },
  async ({ query, since, limit }) => ({ content: [{ type: "text", text: await searchEntries(query, since, limit) }] }));
```

**双传输**：

| 传输 | 用途 | 配置 |
|---|---|---|
| **stdio** | Claude Desktop / Cursor 本地接入 | `command: "./cheng-rss", args: ["mcp"]` |
| **HTTP (Streamable)** | 远程接入、多客户端 | 挂在主服务 `/mcp`，Bearer token |

### 12.3 工具设计原则

1. **返回 Markdown 而非裸 JSON** —— LLM 读 Markdown 更省 token、更少解析错误。
2. **每个工具都带时间过滤** —— 库会越来越大，无限查询会撑爆上下文。
3. **只读优先** —— 第一批只做查询；写入类放第二批并显式确认。
4. **复用既有检索** —— 内部直接调 §7.3 的混合检索。

**六个工具（够用不臃肿）**：

| 工具 | 说明 |
|---|---|
| `search_entries` | 混合检索条目，返回摘要卡 |
| `get_entry` | 单篇全文 + AI 分析 |
| `list_highlights` | 高亮列表（可按标签/时间/文章） |
| `get_digest` | 某天的简报 |
| `list_clusters` | 事件簇（跨源聚合） |
| `list_feeds` | 订阅源与健康度 |

> 不要一上来做 20 个工具。工具太多会让 LLM 选错，6 个覆盖 95% 场景。

---

## 十三、存档、备份与迁移

### 13.1 状态单一、格式开放

```
./data/
├─ app.db          # 全部结构化数据
├─ files/          # 图片等二进制附件（本地代理落盘，不依赖外链）
├─ config.json     # 配置
└─ backups/        # 自动快照
```

四条设计约束：
1. 不用外部数据库。
2. 图片本地代理并落盘 —— 否则源站删图后存档残缺。
3. 导出为开放格式（Markdown / JSONL / OPML），非私有格式。
4. 迁移文件带版本号，降级有明确边界。

### 13.2 三种自动备份

先看实测成本，这决定了备份策略不能照抄常规做法：

| 度量 | 实测值 |
|---|---|
| 10 万条（含正文 + 分析 + 2.5 万向量）库体积 | **2.5 GB** |
| `VACUUM INTO` 全量快照耗时 | **30 s / 2.5 GB** |
| GFS 保留 23 份的磁盘占用 | **≈57 GB** |

每天在 NAS 上花 30 秒写一份 2.5GB 的全量副本、一个月堆到几十 GB —— 这不可接受。所以：

| 机制 | 触发 | 产物 | 体积 | 用途 |
|---|---|---|---|---|
| **WAL 增量快照** | 每 6h | `data/backups/app-<ts>.db`（`backup()` API 的增量页） | 只含变化页 | 快速回滚，分钟级 RPO |
| **全量快照** | 每日 03:00 | `VACUUM INTO` 的 `.db` | 全量 | 灾难恢复 |
| **增量归档** | 每周 | 新增条目导出 JSONL（不含正文） | 数十 MB | 长期存档 |
| **异地同步** | 可配（S3 / WebDAV / 本地路径） | 上述副本 | 同 | 防灾 |

**关键实现**：

```ts
// 全量：在线一致性快照，不中断服务
db.exec(`VACUUM INTO '${backupPath}'`);
// 错误示范：cp app.db backup.db —— WAL 有未 checkpoint 内容时会得到损坏副本
```

`node:sqlite` 还提供 `backup()` 原生 API，可做增量备份（只写变化的页），用于 6h 级别的高频快照；`VACUUM INTO` 只用于每日全量。两者都产生可独立打开的完整库，`PRAGMA integrity_check` 均通过（已实测）。

**保留策略**：**按体积而非份数**。GFS 的「7 日 + 4 周 + 12 月」在 2.5GB 库上等于 57GB，对小容量 NAS 是灾难。改为：

```
每日全量：保留最近 3 份
每周全量：保留最近 4 份
每月全量：保留最近 6 份
超出 data/config.json 的 backups.maxGB（默认 10GB）时，从最旧的非周/月快照开始删
```

`doctor` 报当前备份总占用，超过预算时告警。

### 13.3 正文分级保留（体积的真正来源）

实测 2.5GB 里 **`entry_contents` 占 2090MB（84%）**，其余全部加起来才 390MB：

| 表 | 10 万条体积 | 占比 |
|---|---|---|
| `entry_contents` | 2090 MB | 84% |
| `embeddings` | 205 MB | 8% |
| `entry_analysis` | 103 MB | 4% |
| `entries` + 全部索引 | 68 MB | 3% |

因此体积治理只在正文这一处。三条措施：

1. **gzip 存储**：正文 HTML/Markdown 实测压缩比 **2.6×**（中英混合真实文本；不要用重复文本估，那会得到 130× 的假数据）。用 `zlib.gzipSync(buf, { level: 6 })`，读时解压。整个 `entry_contents` 从 2090MB 降到 ~800MB。
2. **`raw_html` 只留 30 天**：它只用于「重新提取」这一件事。实测清空 `raw_html` 后 VACUUM 可省 **26%** 总体积（657MB）。保留期过后由每日维护任务置 NULL。
3. **`noise` 级条目不存正文**：分类为 `noise` 的条目只保留标题、摘要、AI 卡片，抓完即弃正文。按 30% 噪音率估，再省约 1/4。

三条合计把稳态体积从 2.5GB 压到 **约 0.8~1.0GB / 10 万条**，每日增量从 18MB 降到约 7MB。

### 13.4 迁移

```bash
# 旧机器导出
./cheng-rss export --out ./export-20261023.tar.zst
#  含 app.db（已 VACUUM）+ files/ + manifest.json（版本、schema 版本、条目数）

# 新机器导入（任意部署方式）
./cheng-rss import ./export-20261023.tar.zst
#  校验 schema 版本 → 必要时迁移 → 恢复 files → 重建索引
```

导入时若包内 schema 版本更新（降级），**明确拒绝并提示**，不半途损坏。

### 13.5 内容导出

```bash
./cheng-rss export --format markdown   # 每人一个 .md + 图片目录 + index.json
./cheng-rss export --format jsonl
./cheng-rss export --format opml       # 仅订阅源
```

### 13.6 doctor 检查项

```
[✓] 数据目录可写
[✓] SQLite 版本 / journal_mode=WAL
[✓] schema 版本与二进制匹配
[✓] PRAGMA integrity_check
[✓] 最近备份时间（>48h 告警）
[✓] 备份总占用（超 backups.maxGB 告警）
[✓] 磁盘剩余空间（<10% 告警）
[✓] 库体积与正文占比（entry_contents 超 90% 提示清理）
[✗] 图片附件缺失 3 个 → 列出条目
```

---

## 十四、Huntly 浏览器插件兼容

**这是 P0 硬需求，不是加分项。** 明确它意味着什么：

> 用户在 Chrome 里装**官方原版 Huntly 插件**（不改代码、不装自定义构建），在插件设置里把服务器地址改成 `http://<本机或NAS>:3000`，之后「保存当前页面」「查看已保存角标」「收藏」「归档」「稍后读」全部正常工作。

因此 M0 就要落 cookie session 与两条核心端点（§19.2 的 0.5 / 0.8），不能等到 M7。这一章的所有约束都源自「不许 fork 插件」这一个前提。

### 14.1 可行性基础（已核实源码）

1. **服务器地址可由用户填写** —— `serverUrl` 从 `chrome.storage.sync` 读取，拼成 `${serverUrl}/api/`。**不需要 fork 插件**。
2. **`host_permissions` 为宽泛通配** —— 能访问 localhost 与局域网。
3. **无 API Key 机制** —— 纯 cookie 会话，不需实现 OAuth。

### 14.2 插件调用的端点清单

```
认证   GET    /api/auth/loginUserInfo
页面   POST   /api/page/save                      ← 核心
       GET    /api/page/pageOperateResult?id=&url= ← 核心
       GET    /api/page/{id}
       DELETE /api/page/{id}
       PATCH  /api/page/{id}/detail
       PATCH  /api/page/{id}/collection
操作   POST   /api/page/star/{id}       /api/page/unStar/{id}
       POST   /api/page/readLater/{id}  /api/page/unReadLater/{id}
       POST   /api/page/archive/{id}
       POST   /api/page/saveToLibrary/{id} /api/page/removeFromLibrary/{id}
集合   GET    /api/collections/tree
AI     GET    /api/article-shortcuts/enabled
设置   GET    /api/setting/general/globalSetting
       GET    /api/setting/general/blacklist
```

**挂载方式**：兼容层挂在 Hono 的 `/api/*` 子应用下，与自有 REST API 并存。自有 API 用 `/api/v1/*` 前缀，避免路径冲突。`compat/huntly/` 目录内不 import 任何业务模块，只调用 service 层 —— 将来 Huntly 大版本变更时整目录替换即可。

### 14.3 登录流程（插件是这么用 cookie 的）

插件的「连接服务器」不是一个 OAuth 流程，而是：

```
1. 用户填 serverUrl + 账号密码
2. 插件 POST 登录 → 期望 Set-Cookie 落在 serverUrl 这个 origin 上
3. 之后所有请求 credentials:'include'，靠浏览器自动带 cookie
4. 启动时调 GET /api/auth/loginUserInfo 判断是否仍登录
```

由此得到三条实现约束：

| 约束 | 原因 |
|---|---|
| session cookie 必须 `SameSite=Lax` 且 `Path=/` | 插件的 fetch 来自 `chrome-extension://` origin，跨站场景；`Strict` 会导致不回传 |
| 同时支持 `Set-Cookie` 与 Bearer | 插件走 cookie，MCP 与脚本走 Bearer；认证中间件两者都认 |
| `/api/auth/loginUserInfo` 未登录时返回 **200 + null 语义**，不要 401 | 插件对 401 的处理是直接报错，不会引导登录 |

### 14.4 字段映射：`CapturePage` → `entries`

插件 `page/save` 传约 20 个字段，必须逐个落到表上（`entries` 的兼容列已为此预留，见 §6.2）：

| 插件字段 | 落点 | 说明 |
|---|---|---|
| `url` / `title` / `author` | `entries.url` / `title` / `author` | 直接映射 |
| `content` | `entry_contents.raw_html` | 作为 `source_type='web'` |
| `pageJsonProperties` | `entries.page_json` | 原样存字符串，不解析 |
| `contentType`（数字） | `entries.source_type` | 需实测枚举：网页 / 微博 / 知乎等 |
| `librarySaveStatus`（数字） | `entries.library_save_status` | 0/1 两态，实测确认 |
| `faviconUrl` / `siteName` / `thumbnailUrl` | 对应列 | 直接映射 |
| `collectionId` | `entries.folder_id` | 映射到 folders；不存在的集合按需创建 |
| `starred` / `readLater` / `archived` | 对应状态位 | 布尔 |

**必须实测确认的**：`contentType` 与 `librarySaveStatus` 的枚举值。这两个是数字而非字符串，猜错会导致 UI 分类显示错误但不报错 —— 属于典型的静默失败。

### 14.5 四个技术障碍

| 障碍 | 应对 |
|---|---|
| **必须 cookie 会话** | 所有请求为 `credentials: 'include'`。认证层必须支持 cookie session，不能只做 Bearer token |
| **响应体格式逐端点不同** | `page/save` → `{data: pageId}`；`pageOperateResult` → 裸对象；`page/{id}` → `{page:{...}}`；`collections/tree` → 直接 JSON。**必须逐端点核对**，不能统一套一种格式 |
| **`CapturePage` 字段多** | 约 20 字段，含 `pageJsonProperties`、`contentType`（数字枚举）、`librarySaveStatus`（数字枚举）。枚举值需实测 |
| **失败静默** | 插件多处只 `console.error`。需要契约测试，不能靠人工点 |

第一条与第二条是最容易做错的地方：套一个统一 `{code, data, message}` wrapper 是最自然的工程直觉，而插件恰恰不接受 —— 它对每个端点按各自形状解构，多一层包装就取不到值，且不报错。

### 14.6 分两期实现

- **兼容层 A（约 1 周，M0 先落 2 个端点）**：6 个核心端点 —— `auth/loginUserInfo`、`page/save`、`page/pageOperateResult`、`collections/tree`、`page/star/{id}`、`setting/general/globalSetting`。覆盖主流程：连上服务器 → 保存 → 看到已保存角标 → 收藏。其余端点返回结构正确的空值。
- **兼容层 B（约 1.5 周）**：归档、稍后读、集合移动、黑名单等。

**验收以真实插件为准**：用官方 Chrome 商店版插件指向本服务，完成「连接 → 保存网页 → 列表出现 → 角标变化 → 收藏 → 归档」，全程不改插件代码。任何一步失败即视为未完成，不因契约测试通过而放行。

### 14.7 用 HAR 作为测试夹具

```
1. 官方 Huntly 镜像跑起来
2. 装真实插件指向它，16 个端点全点一遍，抓 HAR
3. 响应体固化为测试夹具
4. 我们的实现逐字段比对（允许新增字段，不允许缺失/类型不符）
```

这是唯一能防「插件升级后静默失效」的办法。**风险**：这是逆向出的兼容层，无官方契约，Huntly 改字段就会断，每次大版本需重抓 HAR。

---

## 十五、UI 设计

原则是**减少决策数量**，以下每条都是可检验的约束。

### 15.0 布局：三栏而非两栏（v1.1 修订）

```
┌────────┬────────────────┬──────────────────────┐
│ 侧栏   │ 列表（400px）  │ 阅读区               │
│ 218px  │                │ 正文 72ch 居中       │
│        │ 标题2行        │                      │
│ 收件箱 │ 摘要1行        │ 标题                 │
│ 未读   │ 元信息+徽标    │ 元信息               │
│ 已收藏 │                │ AI 摘要卡            │
│ 历史   │                │ 正文                 │
└────────┴────────────────┴──────────────────────┘
```

**修订理由**：v1.0 写的是两栏（列表 ↔ 阅读页互斥切换）。落地实测发现 RSS 阅读最高频的动作是"读完一篇挑下一篇"，跳页式切换把它变成两次点击（返回 + 再点），且每次返回都丢失滚动位置。三栏让列表常驻，点开是**置入阅读区**而非**跳转**。

代价：列表栏被压到 400px，摘要只能显示 1 行。这个取舍是对的 —— 列表的任务是"扫过去"，摘要本来就是钩子不是内容。

窄屏（<900px）退化：阅读区改为全屏浮层，列表占满。此时不存在三栏。

### 15.1 信息架构：一级导航不超过 6 项

```
收件箱 │ 简报 │ 主题 │ 高亮 │ 订阅 │ 设置
```

Huntly 的导航有 10+ 项（Home / Recently Read / My List / Starred / Read Later / Archive / GitHub / All Feeds / X / Highlights / Folders / Search）—— 那是「功能全集」导航，不是简洁。低频项（归档 / 稍后读 / 已读历史）降级为**收件箱内的筛选器**：

`全部 · 未读 · 必读 · 有高亮 · 已收藏 · 历史`

**M0 落地状态**：侧栏实际是 `收件箱 / 未读 / 已收藏 / 历史` 四项（真实可用的），另有 `简报 / 订阅` 标灰并注明"待接入"。**不隐藏未实现的功能** —— 用户需要知道"以后会有什么"，但点进去必须有反应，绝不能是死按钮。

### 15.2 列表项：一屏 8~10 条

```
┌─────────────────────────────────────────────┐
│ ● 源名称 · 3 小时前 · [必读]          ★     │  ● = favicon
│   标题（最多 2 行，超出省略）               │
│   一句话 AI 摘要（1 行，省略号）            │
└─────────────────────────────────────────────┘
```

**不显示**：完整摘要、标签云、缩略图（除非图文源）、多个操作按钮（hover 才出现）。列表页的唯一任务是让你快速扫过去。

**实测密度**：单条高度 **104px**（含 padding 与分隔线），1440×960 视口下一屏可见 **8 条**。达成这个数字靠三条硬约束，任何一条放松都会掉到一屏 4~5 条：

1. 标题 `-webkit-line-clamp: 2`（不封顶时长标题会撑到 4 行）
2. 摘要 `-webkit-line-clamp: 1`（两行摘要直接让高度翻倍）
3. **tier 徽标放进元信息行**，不单独占一行

第 3 条是落地时才发现的：最初徽标与字数单独占第三行，高度 148px，一屏只有 4 条。

### 15.3 阅读页：内容优先

- **正文宽度默认 80 字符，可调 64 / 80 / 96**（v1.14 从「固定 72ch」改为「默认 80ch」）。
  超过 90ch 长行的回扫成本明显上升，所以不给更宽；下限 64ch 留给"就是怕长行"的人。
- **AI 摘要卡默认展开但可折叠** —— 既想快速判断也想读原文。
- **高亮工具条随选区浮动** —— 不常驻、不遮挡。

**为什么 v1.14 从 72ch 放宽到 80ch**（需求方：「主内容栏的空间空白太多，可以减少一点，
合理布置排版」）：

实测 1440×900 下正文列 640px，**两侧各空 118px**；1920 下各空 358px —— 留白比列表栏
（368px）还宽。这与 §15.16 的努力互相抵消：刚把两栏收窄让出 54px，转头全变成正文两侧的空白。

| | v1.13（72ch） | v1.14（80ch） |
|---|---|---|
| 正文列宽 @1440 | 640px | **712px** |
| 两侧留白 @1440 | 118px | **82px** |
| 两侧留白 @1920 | 358px | **322px** |
| 标题上方留白 | 34px | **24px** |
| meta 下 / AI 卡下 | 26 / 30px | **18 / 22px** |
| 段间距 | 1.15em | **1.05em** |
| 文末出口上留白 | 34+20px | **26+16px** |

两侧留白仍有 82px 而不是贴边：那段是"呼吸区"，完全没有会让正文顶到面板边缘，
在宽屏上反而更累。**允许调整范围写进断言**：m0-09 与 m1-19 都要求 40 ≤ 留白 ≤ 90px ——
只设上限会容忍"填满"，只设下限会容忍"改回去"。

**80ch 的两个实现陷阱**（M0 实测，改宽度时仍然适用）：

1. `ch` 是**相对当前元素字号**的单位。若 `max-width` 加在 15px 的容器上、而正文是 16.5px，实际只有约 66 个正文字符宽 —— 少 8%。
2. 默认 `box-sizing: border-box` 下，`padding` 会吃掉 `max-width` 里的那部分。必须给阅读容器设 `content-box`，让字符数约束的是文字列宽。

**`max-width` 只是上限**：窄屏时正文宽度由阅读栏可用宽度决定，此时 80ch 不起作用 ——
1180px 笔记本上看到的是 596px 而不是 712px，这是设计如此，不是 bug。

验收脚本用「同字号渲染一个 N ch 探针再比宽度」来断言，而不是读 `getComputedStyle().maxWidth` ——
后者在 `ch` 单位下返回解析后的 px，看着是 582px 但报"等于 72ch"会假绿。
N 本身从 CSS 变量 `--reader-width` 读，**不写死在测试里**：写死就得跟着实现改测试，
等于没测（§19.1）。

### 15.4 简报页

```
今日要点（3 条，粗体，各一行）
────────────────────────────
[主题分组]
  · 事件标题 — 2 句综述
    ├ 一致：xxx                    ← consensus
    └ 分歧：xxx（来源A vs B）      ← conflicts
────────────────────────────
值得一读（低热度高价值）
```

**多源冲突视觉必须克制**：左侧细色条 + 小字标注，不用红色感叹号 —— 冲突是常态，不是警报。

### 15.5 三条可检验的约束

| 约束 | 检验方法 | M0 落地 |
|---|---|---|
| 任何操作 ≤ 2 次点击可达 | 首页到「开始读某篇」应为 1 次点击 | ✅ 列表常驻，1 次点击即进阅读区 |
| 键盘全覆盖 | 不用鼠标能完成浏览、标记、切换筛选 | ✅ `/` 搜索、`j`/`k`/`↑`/`↓` 切换、`s` 收藏、`Esc` 返回 |
| 空状态有引导 | 每个空列表都给出「下一步做什么」的具体按钮 | ✅ 4 种空态各有标题 + 一句可执行提示 |

键盘快捷键的可检验定义（`m0-09-ui.mjs` 逐条断言，不是文档承诺）：

| 键 | 行为 |
|---|---|
| `/` | 聚焦搜索框 |
| `Esc` | 返回列表 / 失焦搜索框 |
| `j` `↓` | 下一篇 |
| `k` `↑` | 上一篇 |
| `s` | 收藏当前篇 |

**键盘在阅读区也要生效**。第一版实现里 `if (typing \|\| openId) return` 直接把阅读区的按键全吞了，等于"进了阅读页就必须用鼠标" —— 与"键盘全覆盖"直接冲突。现在阅读区里 `j`/`k`/`s`/`Esc` 都可用。

### 15.6 技术侧

- **不引 Tailwind / shadcn（v1.1 修订）**：v1.0 写的是 `shadcn/ui + Tailwind`，理由是"组件源码在仓库里，删改不需对抗框架"。落地时算了一笔账：本项目最终只用到 **8 个组件**（按钮、输入、卡片、徽标、图标、列表项、空态、弹层），而 shadcn 那条路要带 40+ 个组件文件、一份 Tailwind 配置、一条构建链路和若干 peer 依赖。手写 **776 行 CSS（13KB，gzip 3.6KB）+ 13 个内联 SVG 图标**换来零构建依赖，在这个体量上更划算。

  这不是反对组件库 —— 如果日后组件数量超过 20 个，手写 CSS 的维护成本会反超，那时应当切回 shadcn。切换点写在这里，是为了不让"当初为什么不引"和"现在该不该引"各说一套。

- **暗色优先**：阅读器多在早晚使用，暗色是主色而非可选主题。实现上 `color-scheme: dark` 写在 `:root`，浅色用 `prefers-color-scheme: light` 覆盖 —— 默认就是暗色，不依赖系统偏好。

  **验收必须显式模拟暗色**：无头浏览器默认是 `prefers-color-scheme: light`，不显式 `Emulation.setEmulatedMedia` 的话截图与断言全是浅色，而"暗色是主色"这条根本验不到。第一版截图就踩了这个坑。

- **不做动画炫技**：只保留「列表进入 120ms 淡入」这类功能性过渡。动效超过 200ms 会让高频操作变慢。尊重 `prefers-reduced-motion`。

### 15.7 移动端（v1.2 新增）

移动端不是"桌面缩小版"。三处必须真的不同，靠 CSS 缩放做不到：

| 桌面 | 手机（< 640px） | 为什么必须换 |
|---|---|---|
| 左侧栏 218px | 底部 tab bar（6 项） | 390px 宽下侧栏吃掉 56% 的宽度 |
| 三栏并排 | 列表 / 阅读互斥，点开是浮层 | 三栏在 390px 下每栏不到 130px，不可读 |
| hover 出操作 | 操作常驻 | 触摸没有 hover，藏起来就等于不存在 |

**tab 项数从 5 变 6 的由来**（v1.24）：简报页（§15.4）上线后它成为一等入口，
桌面侧栏与移动端 tab 都要有。390px 下 6 格每格约 65px，仍高于 44px 的触摸下限；
宽度不是约束，**高度**才是（见下表第一行）。所以是加一格而不是把某项塞进二级菜单 ——
简报是每天的入口，藏进菜单等于没有。

**七条可检验的约束**（`m1-05-mobile.mjs` 逐条断言，不是文档承诺）：

| 约束 | 值 | 依据 |
|---|---|---|
| 触摸目标最小高度 | 44px | Apple HIG 与 Material 的通行下限，低于这个点不准 |
| 输入框字号 | ≥ 16px | iOS Safari 在 < 16px 的输入框聚焦时会强制放大页面 |
| 底部安全区 | `env(safe-area-inset-bottom)` | iPhone 的 Home 条会盖住最后一行 |
| 底部留白 | ≥ 56px | 否则列表最后一条被 tab bar 永久遮住 |
| 横向溢出 | 0 | `scrollWidth > innerWidth` 会让页面能左右拖动 |
| 阅读浮层 z-index | ≥ 30 | 要盖住 tab bar（tab bar 是 30） |
| 横屏 | 隐藏侧栏与 tab bar | 见下面的坑 |

**横屏的坑**：iPhone 横放时宽度 852px，**已经超过 640px 的"手机"断点**，于是侧栏又冒出来占 218px —— 而可用高度只剩 393px。这是纯宽度断点的必然缺陷，必须同时按高度判断：

```css
@media (max-height: 480px) and (max-width: 900px) { ... }
```

截图实测确认过这个情况（`m06-landscape.png` 第一版确实出现了侧栏），补上后 28/28 才绿。

**视口元信息也要改**，否则安全区变量恒为 0：

```html
<meta name="viewport" content="..., viewport-fit=cover" />
```

`viewport-fit=cover` 缺失时 iOS 不会把内容延伸到刘海区域，`env(safe-area-inset-*)` 全部返回 0 —— 断言会"通过"但实际没生效。这是典型的静默失败：CSS 写对了，值却是 0。

**响应式规则集中一处**：`styles.css` 只管桌面，`mobile.css` 管所有断点。两个文件各写一套断点时，`< 900px` 与 `< 640px` 会互相覆盖出难以复现的中间态。

⚠️ **但 `feeds.css` 是例外，它排在 `mobile.css` 之后**（`main.tsx` 的导入顺序是 `styles → mobile → feeds`）。
CSS 同权重规则由"后出现的"胜出，所以在 `mobile.css` 里写 `.folder-twist { width: 40px }` 会被
`feeds.css` 的 `.folder-twist { width: 18px }` 盖掉 —— **规则存在、查得到、就是不生效**。
实测症状：375px 下量到的仍是桌面的 18×18，而 devtools 里两条规则都在。

同一类失效还有个更隐蔽的版本：`m1-05` 之前只量 `.feeds-page` 里**渲染出来的**按钮，
没有分组数据时那些 chip 根本不渲染，于是"按钮高度 ≥36px"一直绿，
而真实环境里 chip 只有 30px。**空真断言**（vacuously true）比没有断言更危险：
它给出一个"已经测过了"的错觉。

两条对策，都已落地：

1. `feeds.css` 自己管的组件（chip、分组管理列表、排序控件），移动端覆盖写在
   `feeds.css` 的 `@media (max-width: 640px)` 里，顺序天然正确。`mobile.css` 里只留一行
   注释指向它，避免以后有人"顺手"搬回去。
2. 触摸断言一律**先断言控件真的渲染出来了**，再断言尺寸。测不到就是 FAIL 不是 PASS ——
   见 `m1-05` 里那组配置页控件。

### 15.8 列表型页面的质量约束（v1.3 新增）

订阅页是第一个"可能长到几十上百行"的页面。它的显示问题有个共同点：**行为断言全绿也能存在**。实测踩到四个：

| 问题 | 表现 | 根因 |
|---|---|---|
| 图标语义错位 | 刷新的图标像星形，暂停用星形，删除用文字 ✕ | 图省事复用了 `IconSparkle`/`IconStar` |
| 吸顶缺分隔 | 滚动的行从头部下方穿过，看着像渲染错位 | sticky 头部没画下边界 |
| 手机上操作消失 | "刷新"和"暂停"在手机上点不到 | 写了 `.icon-btn:not(.danger) { display:none }`，把三个都藏了 |
| 长标题撑高 | 一行从 66px 变 89px，整列节奏乱 | 标题没做单行截断 |
| 图标空方块 | favicon 拉不到时留一个 30px 空格子 | `onError` 只做了 `display:none` |

于是这四项各有一条断言（`m1-06-feeds-ui`）：

| 约束 | 检验方法 |
|---|---|
| 行高一致 | 30+ 行取 `getBoundingClientRect().height` 的 min/max 必须相等 |
| 长标题单行 | `scrollWidth > clientWidth`（真的截断了，不是"刚好放得下"） |
| 状态徽标不被截 | 标题截断后徽标的 `right` 仍在视口内 |
| 操作不越界 | 每个 `.feed-ops` 的 `right <= innerWidth` |
| 头部吸顶 | `position === 'sticky'` + 滚动后按钮仍在可视区 |
| **手机上操作可用** | 逐个读 `display`，断言刷新/暂停/删除三个都在 |
| 图标永不空方块 | 每格都必须有底层占位图标（`svg`），favicon 叠在上面 |

最后一条是关键：**"藏起来"和"没有"在截图上长得一样**，只有读 `display` 才能分辨。第一版就是靠这条抓到的。

**测试自身也有坑**，这一节踩了三个：

1. 验"截断"的标题刚好塞进桌面宽度（540px 文字 / 622px 容器），`scrollWidth === clientWidth`，断言恒假看着像实现坏了。**构造边界数据要保证它真的越过边界。**
2. 验"图标降级"时数据里 `icon_url` 全是 `null`，根本走不到那条路径，恒 PASS。**断言必须能证明自己走到了被测分支。**
3. 补了坏图标后发现对照样本缺失——坏图标 `onError` 后被移除，`faviconAttempts` 恒为 0。再补一个 data URI 真实图标（离线可用）。

第 2、3 条是同一类错误的两次发作：**空转的断言比没有断言更危险**，它给出的是虚假的安全感。

### 15.9 长跑验证的进程卫生（v1.5 修订：已随插件下架）

一轮完整验证之后，系统里曾留下 **115 个 msedge 进程 / 6.9GB 内存**。
表现是紧接着的 `build.sh --sea` 报：

```
Fatal process out of memory: Zone
```

这个报错完全看不出根因——它看起来像 node 自己内存不够，实际是系统内存
被无头浏览器吃光了。

### 当时为什么会漏（结论保留，代码已删）

三个独立的原因，缺一层就会漏。这三条是平台事实，换任何项目都成立：

| 层面 | 问题 |
|---|---|
| 信号 | 只挂 `process.on('exit')`；`timeout` 命令和 Ctrl+C 走 SIGTERM/SIGINT，`exit` **不触发** |
| 平台 | **Windows 上 `child.kill('SIGTERM')` 走 TerminateProcess，不执行目标进程的信号处理器** |
| 进程树 | `taskkill /T` 之后仍剩 42 个 msedge —— 浏览器的 GPU / utility / broker 子进程在父进程死后会被系统收养，脱离原进程树，按树杀追不到 |

第二条最反直觉：写在 `process.on('SIGTERM')` 里的清理代码，在 Windows 上
对于"被 timeout / 被任务管理器结束"这种最常见的场景**一次都不会执行**。
所以"挂个信号处理器"这个直觉方案在这里是无效的。

### v1.5 的决定：把浏览器交给插件

上面三条的修法（`onCleanup` / `sweepStale` / `killByMarker` 三层、
`scripts/lib/cleanup.mjs` + `m1-08-cleanup` + pid 登记目录）之所以存在，
前提是**验证脚本自己起浏览器、自己攒残留**。

浏览器插件接管自动化之后这个前提不成立了：插件跑在用户自己的浏览器里，
生命周期由插件管理，脚本侧没有可泄漏的进程。于是整套基础设施按「不为
已消失的问题付维护成本」的原则删掉：

| 删除 | 原因 |
|---|---|
| `scripts/lib/cleanup.mjs`（205 行） | 只有自起浏览器才需要 |
| `scripts/verify/m1-08-cleanup.mjs`（250 行） | 验的是已删除的机制 |
| `scripts/shot-ui.mjs` / `scripts/shot-mobile.mjs` | 截图改由插件出 |
| `.tmp/run/` pid 登记 | 不再登记任何进程 |

现在只剩 `scripts/lib/proc.mjs`（`killTree` + `onExit`，约 40 行）：
3 个布局验收脚本仍然要起一次无头浏览器量行高/截断/横向溢出——这些是
纯布局数值，插件侧的截图判不了——正常退出时 `killTree` 杀掉即可。

**代价要写清楚**：`onExit` 在 Windows 上被外部硬杀时同样跑不到。所以
"长期反复跑 `verify-all`"这件事，要么接受每轮结束自己看一眼进程数，
要么就少跑。这是已知的、明确接受的取舍，不是遗漏。

### 现在的收尾（`scripts/lib/proc.mjs`）

```
killTree(pid)   杀整棵进程树（Windows 用 taskkill /F /T）
onExit(fn)      正常退出 / SIGINT / 未捕获异常 → 跑一次 fn
```

没有 pid 登记、没有启动扫残留、没有标记匹配。三个布局脚本各自
`onExit(cleanup)` 一次，正常退出时杀干净就够了。

### 附带修掉的两个问题

- `tsconfig.json` 一直 `exclude: ["src/client"]`，**前端 .tsx 从来没被
  类型检查过**。Vite 的 esbuild 只擦类型不校验，写错变量名照样构建成功。
  新增 `tsconfig.client.json`（moduleResolution: bundler + jsx: react-jsx），
  第一次跑就抓出 `NAV[0]` 在 `noUncheckedIndexedAccess` 下是 undefined。
- 前端检查进脚本：`npm run typecheck:client` / `typecheck:all`。

### 15.10 订阅的一键批量管理（v1.6 新增）

导入 OPML 之后第一件事不是"读文章"，而是**把 20~30 个源收拾一遍**：
有几个接不到、有几个该放进某个分组、有几个想先暂停。逐行点五下 ×30 行
这件事没人会做完，所以需要一个批量模式。

**交互约定**（`管理`按钮 → 每行出勾选框 → 顶部出批量栏）：

| 元素 | 行为 |
|---|---|
| 「管理」按钮 | 在标题区右侧，与「分组 / 导入 / 导出」同排。进入后按钮变「退出管理」 |
| 行勾选框 | 只在该行 `.feed-row` 左侧出现，24px 见方；点行内其它区域不选中（避免和"打开"冲突） |
| 组头勾选框 | 点整个分组的全选/全不选 |
| 顶部批量栏 | 显示「已选 N 个」+ 全选/清空 + 各操作按钮；未选中时按钮 disabled |
| 操作确认 | 只有「删除」需要确认（且要写明"未读条目会一并删除"）；移动/暂停/刷新都是一步即成，可撤销成本低 |

**六类操作**对应六个批量端点，前端不循环调单条接口：

```
POST /feeds/bulk/folder     {feedIds, folderId}   移到分组（null = 移出）
POST /feeds/bulk/status     {feedIds, status}     active | paused
POST /feeds/bulk/delete     {feedIds}             删除（保留已读/已收藏条目）
POST /feeds/bulk/refresh    {feedIds}             全部入抓取队列
```

四条而不是六条：移动与移出合并（`folderId: null`），暂停与恢复合并
（`status`）。分开会让后端出现两段只差一个常量的代码。

**为什么必须是批量端点，而不是前端 `Promise.all` 循环调 `POST /feeds/:id`**：

1. **原子性**。32 个源移进分组，中途第 17 个失败（并发写锁），用户看到的是
   "一半在组里一半没在"，还得手动找出来。批量端点在**一个事务**里做完，
   要么全成要么全不成。
2. **往返数**。32 次请求在手机上（弱网）是 32 个 RTT，批量是 1 个。
3. **可观测**。批量接口能返回 `{requested, done, skipped}`；前端循环只能
   靠 `catch` 里拼错误，用户看到一句"部分失败"却不知道是哪些。

**边界条件**（每条都有对应断言，见 `m1-08-bulk`）：

- `feedIds` 为空 → 400，不是静默成功（前端也可能因为状态竞态发出空数组）
- 混入不存在的 id → **其余照做，返回 `skipped`**，不整体失败。
  理由是"另一个标签页刚删掉一个源"不该阻断这次操作。
- 删除批量时不存在的 id → 同样 `skipped`，不是 404
- 超过 500 个 id → 400（防滥用；个人库不会到这个量级）
- 删除沿用单条的语义：**未读条目随订阅删，已读/已收藏保留并解绑**
- 批量刷新只处理 `status !== 'paused'` 的源，暂停的跳过并计入 `skipped`

### 15.11 阅读页交互（v1.7 新增）

需求方反馈：「rss 阅读器功能性太弱，比如跳转源网页、对应的链接不能点击」。
实测核对了三条，其中**两条是真缺陷，一条是能力缺失**：

| 现象 | 实测结论 | 性质 |
|---|---|---|
| 正文链接点了之后阅读器整个消失 | 正文 3176 个链接里 2196 个（69%）**没有 `target`**，点击在主框架导航，SPA 状态全丢，浏览器后退才回来 | 缺陷 |
| 列表行没法「在新标签页打开」 | 行元素是 `<button>`，中键点击与 Ctrl+点击都不生效；一个 `<a>` 都没有 | 缺陷 |
| 找不到「去源站」 | 详情接口只返回文章 URL，不返回 feed 的 `site_url`；22 个源全有 `site_url`，542/547 条目能用上 | 能力缺失 |

**最容易误判的是第一条**：链接并非"不能点"，而是"点了代价太大"。
用户点一次就得用浏览器后退回来，第二次就不敢点了 —— 体感等同于不可点。
所以断言不能只测"有没有 `href`"，必须测**点击后主框架的 URL 有没有变**。

#### 三类链接的出口约定

| 链接类型 | 出口 | 理由 |
|---|---|---|
| 正文内的文章链接 | **新标签页**（`target="_blank"` + `rel="noopener noreferrer"`） | 阅读上下文是稀缺资源，不能被一次外链点击销毁 |
| 正文内的锚点（`href="#..."`） | **当前页跳转**，不新开 | 锚点是同一文档内的定位，新开标签等于把用户扔进一个只有片段的新页 |
| `mailto:` / `tel:` | 保持协议默认行为，不加 `target` | 交给系统处理，浏览器不导航 |

`sanitize.ts` 在清洗时统一加 `target`，而不是靠 feed 自觉 —— 实测只有 31% 的链接自带
`target`，且集中在少数源。这是**安全边界所在的唯一位置**，在此处加也顺带保证
插件导入的 HTML 走同一条规则。

#### 列表行改成可中键打开的链接

行元素从 `<button>` 改为 `<div role="button" tabindex="0">`，行内标题是真 `<a href>`。
这样：左键点行任意处 = 在阅读区打开（原行为）；左键点标题 = 同上；
**中键 / Ctrl+点击标题 = 新标签打开**（浏览器原生行为，不需要写代码）。

`<a>` 不能嵌进 `<button>`（HTML 内容模型禁止交互元素嵌套），
所以这不是"加一个链接"，是**必须换行元素**。键盘可达性用 `role="button"` +
`Enter`/`Space` 手动补回，`m1-09-reader` 有一条断言专门验这个。

#### 双出口：原文 与 源站

| 出口 | 目标 | 位置 |
|---|---|---|
| 打开原文 | 这篇文章的 URL | 阅读栏图标 `↗`（原有）+ 快捷键 `v` |
| 去源站 | feed 的 `site_url`（站点首页） | 阅读栏站点名可点（原有是纯文本）+ 详情里的一行「来自 X ↗」 |

两个出口是不同需求：读完一篇想继续看这个站点还有什么；而"打开原文"是核对排版/看评论。
`site_url` 为 `null` 时（网页捕获条目）不渲染该入口，不是渲染一个死链。

#### 已读可回退

原来只有 `POST /entries/read`，没有反向操作 —— 误点开一篇就永远变已读，只能去库里改。
新增 `POST /entries/unread {ids}`。阅读栏加「标为未读」按钮，快捷键 `m`（对齐 Miniflux）。

#### 阅读偏好（字号 / 宽度 / 主题）

三个值存 `localStorage`，只影响阅读区，不影响全局主题：
`--reader-font`（15/16.5/18/20px）、`--reader-width`（60/72/84ch）、
`--reader-theme`（跟随系统 / 亮 / 暗 / 米色）。

**不存到服务端**：这是"这台设备上看着舒服"的偏好，不是账号数据。
换个浏览器就该重新调 —— 存服务端反而会出现"手机上设的字号把桌面也改了"。

#### 快捷键扩充

只加四个，全部对齐 Miniflux（`miniflux.app/docs/keyboard_shortcuts.html`），
不引入 `gg`/`G` 这类需要状态机的组合键 —— 实现成本高，收益低：

| 键 | 行为 | 来源 |
|---|---|---|
| `o` / `Enter` | 在阅读区打开选中条目（列表焦点在行上时） | Miniflux `o` |
| `v` | 新标签打开当前篇原文 | Miniflux `v` |
| `m` | 切换已读/未读 | Miniflux `m` |
| `t` | 跳到列表顶部 | Miniflux `z t`，简化为单键 |

`t` 而不是 `gg`：`gg` 需要计时器区分"按了一次 g"和"按了两次 gg"，
而列表顶部是高频动作，等 300ms 才生效的快捷键比没有更烦。

**边界条件**（每条都有断言，见 `m1-09-reader`）：

- 焦点在输入框时，`v`/`m`/`t` 全部不生效（否则打字会触发跳转）
- `v` 对没有原文 URL 的条目（极少数插件捕获）不动作，不打开空白页
- `m` 在"未读"视图下把当前篇标未读 → 该条从列表消失，焦点落到下一条，不落到虚空
- 正文里 `href="#"` 或 `href="#section"` 的链接**不**加 `target`
- 列表行 `role="button"` 必须同时有 `tabindex="0"`，否则键盘 Tab 不到

### 15.12 控件的形状尺度（v1.8 新增）

需求方反馈：「部分按钮的形状太突兀」。这句话没法直接改代码 ——
"突兀"是相对的，必须先量出**参照系**。实测把四个页面上每个可见按钮的
圆角 / 内边距 / 高度 / 背景全读出来（`getComputedStyle` + `getBoundingClientRect`），
按圆角落簇，得到这张表：

| 圆角 | 出现次数 | 出现在哪 |
|---|---|---|
| `7px` | 24 | 导航项、工具栏按钮、图标按钮、文末出口 |
| `14px` | 7 | 分组筛选 chip、弹窗 |
| `0px` | 23 | 列表行（相邻行共边，刻意不留圆角） |
| `5px` | 11 | 阅读偏好面板里的分段按钮 |
| `4px` | 2 | 列表行的迷你图标按钮（22px 见方） |

五档圆角本身不算错 —— 圆角应当随**控件尺寸**缩放，22px 的按钮用 7px
圆角看起来就是胶囊，50px 高的卡片用 4px 又会显硬。真正的问题是**同一尺寸
的控件用了不同圆角**：

| 缺陷 | 实测 | 为什么"突兀" |
|---|---|---|
| 「只看分组 · 清除」是一整块 129×40 的实心按钮 | `.scope-clear` 落到了全局 `button` 规则上，`padding: 7px 13px` + `background: var(--bg-elev2)` + 边框 | 它左边是搜索结果框、右边是列表，一块实心方块夹在中间，视觉重量和"清除一个筛选"这件小事严重不匹配 |
| 22px 迷你按钮圆角 4px，而同为图标的 32px 按钮圆角 7px | `.icon-btn.tiny` 手写了 `border-radius: 4px` | 同一组图标按钮在 hover 时圆角会"跳"一下 |
| 偏好面板的 `5px` 分段按钮 | `.seg-btn` 手写了 `5px`，而外层 `.seg` 是 `var(--radius-sm)` = 7px | 内圆角比外圆角小 2px 是正确做法，但这里只小 2px 却因为 2px 的内边距显得错位 |
| 文字按钮高度三档并存 | `.btn` 40px / `.btn.block.prefs-reset` 31px / `.btn.tiny` 27px | 尺寸档位本身合理，但 `prefs-reset` 的 31px 是 `btn` 基样式 + 自定义 `padding: 5px` 撞出来的**意外值**，不是设计值 |

**收敛规则**（写进 `:root`，不再散着手写）：

| 变量 | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `7px` | **一切矩形控件的默认圆角**：按钮、输入框、导航项、下拉 |
| `--radius-xs` | `4px` | 小于 24px 的控件：迷你图标按钮、`kbd`、favicon、小徽标 |
| `--radius-pill` | `999px` | 胶囊：chip、圆点徽标。写成 999px 而不是固定值，高度变化时不会露出直角 |

`--radius: 10px` 只留给**容器**（卡片、面板、弹窗），不用于按钮。

判断标准不是"统一成一个数"，而是**同类控件同圆角、且圆角随尺寸单调**。
`m1-10-ui-scale` 把它变成断言：

- 所有可见 `button` / `a.btn` / `a.icon-btn` 的圆角必须落在 `{0, 4, 7, 999}` 四档里（`.seg` 内的分段按钮按"外圆角 − 内边距"算出 5，单独放行）
- 同一 `class` 的按钮高度必须唯一（差一档就是缺陷）
- 行内小控件（`< 24px`）圆角必须是 4px，不许跟 32px 的用同一个值
- `chip` 必须是 999px 真胶囊（写死 14px 会在高度变化时露直角）
- 采样覆盖面自检：必须同时采到图标按钮 / 文字按钮 / chip / 分段按钮 / 列表行，
  否则前面几条可能在"页面上只有 3 个按钮"的情况下全绿

**为什么这条要单独一步**：它没有"接口"，全是样式。样式缺陷的行为断言
天然是绿的（按钮点得动、文字没错），只能靠**度量**抓。§15.8 那次
"藏起来和没有在截图上长得一样"是同一类教训的另一面。

**配套的尺度外溢**（同一轮修的，不单独开步骤）：

| 位置 | 症状 | 处理 |
|---|---|---|
| 手机订阅页操作区 | `.feeds-actions .btn` 跟 `.btn` 的 32px 一起缩，低于 m1-05 的 36px 红线 | 手机断点显式 `height: 36px`；空态的 `.empty-actions .btn` 是另一组 DOM，必须一起写 |
| 手机订阅行内操作 | 4 个 40px 按钮 + gap 占 194px，365px 的行里标题只剩 91px，「共 24 条」被压到 5px（等于不显示） | 收到 36px（m1-06 的红线是 ≥ 36），让出 16px 给标题与条数 |
| 列表头「N 条」 | 用 `items.length` 显示的是本页已加载条数，组内 45 条时首页显示「30 条」 | 改用后端返回的 `total`；界面上加一条 45 > 30 的断言才抓得住 |

### 15.13 分组内查看订阅源（v1.8 新增，v1.13 改为侧栏分组树）

需求方反馈（v1.8）：「分组不能查看分组内的不同订阅源信息，需要加上」。
需求方反馈（v1.13）：「分组采样左侧下拉栏，不然分组内部订阅数量多会导致
博客列表栏显示不全」。

v1.8 的实现是「列表头部一行 chip 横向滚动」。它解决了"看不到组内源"，
却把代价转嫁给了列表栏：

| 问题 | 实测 |
|---|---|
| 组内 11 个源时 chip 行连间距吃掉 41px | 列表一屏从 9 条掉到 8 条 |
| 横向滚动 = 看不全 | 正是需求方说的「显示不全」 |
| 与「全部/未读」分段、刷新、搜索框挤在同一条竖向带 | 组内源越多，列表首屏越矮 |

v1.13 改成**侧栏的可展开分组树**：分组行就地展开，组内源作为子行挂在下面。
范围的选择全部收在左栏一处，列表栏一行不占。

| 元素 | 行为 |
|---|---|
| 分组行 | 点击 = 选中该组（看整组条目）**并**展开/收起；整行都是点击区 |
| 子行 | 组内每个源一行，带未读数（0 也显示）；点一下过滤到该源 |
| 再点同一个子行 | 取消源筛选，回到整组 |
| 高亮 | 选「整组」时组行高亮；选中某个源时只有那个子行高亮 |
| 组内 1 个源 | 仍可展开 —— 子行里能看到"这个源有没有新内容"，这是信息不是噪声 |
| 组内 0 个源 | 不渲染子节点；组行仍可选中（该组条目可能还在） |
| 头部「×」 | 清除**全部**筛选（先清源、再清组），一次退回全库 |
| 未分组 | **v2.0 起有入口**：未分组源平铺在分组区块里，与分组行同级（§15.26）。代码本来就走 `folderId=none` 通用处理，所以这一条只改渲染 |

**为什么是树而不是下拉框（`<select>`）**：下拉一次只显示一个值，选完就收起 ——
而「组内哪个源积压了」需要的是一眼看到全部未读数。树在同一块空间里同时给出
"有哪些源"和"各自多少未读"，而且不占列表栏。

**数据来源**：`GET /feeds` 一次取回全部源，前端按 `folderId` 分组。
不新增接口：该接口本来就返回 `unread` / `total` / `status` / `folderId` /
`folderName`。也不按分组逐个取 —— 改成树之后任何组都可能被展开，
按组取会变成 N 次请求；单人自托管的源总量在几十到几百条，一次全量更省。
（v1.8 用的是 `GET /feeds?folderId=`，只取当前组。）

**边界条件**（每条都有断言，见 `m1-11-folder-feeds` 与 `m1-18-sidebar-tree`）：

- 选中分组时该组**自动展开** —— 否则用户点了分组却看不到组内的源
- 当前筛选的源被移出该组 → 自动退回整组，不留一个指向不存在源的筛选态
- 切到另一个分组 → 源筛选清空（否则会请求"新组的源 + 旧组的 feedId"，结果必然为空）
- 点固定视图（收件箱/未读/收藏/历史）→ 分组与源筛选都清空，树全部收起
- 源筛选与搜索可叠加：`?folderId=X&feedId=Y&q=Z` 三者同时生效
- 未读数为 0 的源仍然出现（"这个源没新内容"本身是信息）

### 15.14 收件箱阅读控制（v1.9 新增）

需求方反馈：「收件箱需要可以选择全部和未读，还要添加刷新按钮，让已读可以刷新」。

现状的毛病有两个，第二个比第一个严重：

1. **「全部」无处可选**。侧栏有「收件箱」和「未读」两个入口，点了「未读」之后
   想回到"全部都看"只能点回首栏 —— 而这不该是两个页面，它是**同一个列表的
   一个筛选**。
2. **已读之后列表不会自己变**。读完一条，它在原地变灰（`opacity: 0.55`），
   但「收件箱」的全量列表里仍占着位置；在移动端、在别人刚给你推了几十条之后，
   用户没有"我手动拉一下"的办法，只能刷新整个页面。

**交互约定**：

| 元素 | 行为 |
|---|---|
| 分段控件「全部 / 未读」 | 位于列表标题行右侧（与「N 条」同一行）。点「未读」→ `view=unread`；点「全部」→ 清掉 `unread` 语义，回到 inbox 全量 |
| 刷新按钮（图标） | 立即重新拉取当前列表（保留当前 view / 分组 / 源 / 搜索），并把侧栏角标与「N 条」一起重算 |
| 刷新过程中的样子 | 按钮进入旋转态并 `disabled`，**列表不清空**（清空会闪白，比不刷新更难受） |
| 分段控件与侧栏「未读」 | 是**同一份状态**：侧栏点「未读」后分段控件上「未读」要亮；在分段控件上点「全部」后侧栏「未读」要灭 |

**为什么放在标题行右侧而不是单独一行**：§15.2 要求一屏能看到 8~10 条。
分段控件（高 24px）+ 刷新图标（高 24px）塞进已有的标题行，垂直成本为 0；
单独占一行要吃掉约 34px，等于每屏少一条。这也是 §15.12 的用处 ——
标题行里混排一个小尺寸分段控件和一个小图标按钮，圆角/高度都得先收敛好，
否则就是"新加的两个控件又是两个新形状"。

**「全部」到底是什么意思**：`view=inbox`（隐藏 `is_hidden=1` 的条目），
不是"包括已隐藏"。用户说的"全部"是"读过的也给我留着"，不是"把隐藏的也算上"。

**v1.16 修订**：本节说的「默认『全部』激活」已失效 —— 初始视图改为「未读」（§15.19），
理由与连带影响见那一节。本节的其余约定（切怎么切、刷新怎么不闪白、两处联动）不变。

**边界条件**（每条都有断言，见 `m1-12-inbox-view`）：

- 已读后点刷新，该条仍在「全部」里但已变灰；切到「未读」后它消失
- 在「未读」里把某条标为已读 → 刷新后不再出现（不是只把样式改了）
- 刷新保留当前筛选：分组 / 源 / 搜索词都不被重置
- 刷新期间列表条数不归零（不闪白）
- 分段控件在手机上不出现横向溢出（375px 视口）
- 侧栏「未读」与分段控件联动，不存在"两处同时高亮成不同状态"

**顺带修的一处**：列表行原来对已收藏的条目**同时**渲染了行内收藏按钮（`filled`）
和一个 `margin-left:auto` 的 `star-mark` 星标，等于一条收藏的条目上有两颗星。
需求方原话：「收藏按钮在点击之后，还有收藏按钮，这样子就是两个收藏图标」。
处理：删掉 `star-mark`，**只保留行内可点的那颗** —— 收藏状态本来就该是
可点击控件的自身状态（`IconStar filled`），再补一个纯装饰的星等于同一个信息说两遍。

### 15.15 配置中心（v1.9 新增）

需求方反馈：「分组添加下拉栏，添加配置功能。订阅管理等部分功能，放入配置中。
具体可以参考 huntly，写入需求」。

对照 Huntly 的实现（[Settings Management UI](https://deepwiki.com/lcomplete/huntly/5.7-settings-management-ui)、
[FeedsSetting.tsx](https://github.com/lcomplete/huntly/blob/ebe6dd28/app/client/src/components/SettingModal/FeedsSetting.tsx)）：
Huntly 有一个全高的 `SettingModal`，左侧 220px 固定分类栏（General / AI / Library /
Feeds / GitHub / Account），右侧条件渲染对应组件；订阅与 OPML、分组管理都在
**这个弹窗里**，主界面只负责读。本项目此前把订阅管理做成了与列表平级的独立页
（`page === 'feeds'` 占后两栏），结果是"读"和"配置"混在同一层导航里，
侧栏同时挂着「订阅」和「分组」，谁也不像次要功能。

**结构调整**：

| 位置 | 之前 | 之后 |
|---|---|---|
| 订阅管理（源列表 / 添加 / 编辑 / 批量 / OPML） | 独立页，占后两栏 | 配置弹窗的「订阅」分类 |
| 分组管理（建/改名/删） | 订阅页顶部的展开面板 | 配置弹窗的「分组」分类 |
| 账户（邮箱/名称/退出） | 侧栏底部 | 配置弹窗的「账户」分类（侧栏只留一个入口图标） |
| 侧栏「订阅」入口 | 切页 | **删除**（v1.13 规格修订，见下） |
| 订阅页的分组筛选 | 一排会换行的 chip | **下拉栏**（`<select>`）：全部 / 未分组 / 各分组 |

**v1.13 规格修订：侧栏不再留「订阅」入口**

需求方原话：「删除主页的订阅源按钮，全部放到配置里面，这一步差不多就处理完了」。

v1.9 当初的取舍是「保留侧栏『订阅』入口作为快捷方式，少一步」。实现完之后
这个理由不再成立：它本身就变成"第二个能打开订阅管理的门"，而弹窗里第一屏
就是订阅分类，进齿轮和进它付的点击次数一样（都是 1 次），快捷方式并不更快。
更麻烦的是它给侧栏带来一个和其它导航项长得一样、语义却不同（打开弹窗而不是
切页）的按钮 —— 用户点之前无法分辨。

所以整个「订阅源」区块（`.nav-section 订阅源` + 那个按钮）删除：

| 位置 | v1.9 | v1.13 |
|---|---|---|
| 桌面侧栏 | 「订阅」导航项，打开配置并停在订阅分类 | **整块删除**。唯一入口是右下角齿轮 |
| 手机底部导航 | 「订阅」，打开配置并停在订阅分类 | 保留位置，**改名「配置」+ 换成齿轮图标** |
| 侧栏区块标题 | 「订阅源」+「分组」两个 | 只剩「分组」一个 |

手机那一格必须留：手机上侧栏是隐藏的（`--sidebar-w: 0`），删掉它就再没有
任何入口能打开配置。改成「配置」+ 齿轮是因为它打开的是整个弹窗（订阅 /
分组 / 账户三个分类），叫「订阅」名不符实 —— 沿用 §15.12 的"同类控件
形状要与行为对人的暗示一致"。

**为什么分组筛选要从 chip 改成下拉栏**：chip 行的宽度随分组数线性增长，
10 个分组就会换 2~3 行，把源列表往下压 —— 而这一行的作用只是"选一个分组"。
下拉栏宽度固定，分组再多也不挤；而且分组名可以写全，不用靠 `max-width` 截断。
**分组数量少于 3 时不值得引入下拉**（一次点击 vs 一次点击+一次选择），
因此规则是：`folders.length <= 2` 仍用 chip，`>= 3` 用下拉栏 —— 两种形态
共用同一份 `filter` 状态，`m1-13` 会分别断言。

**配置弹窗里的分类**：

| 分类 | 内容 | 状态 |
|---|---|---|
| 订阅 | 源列表、添加订阅、编辑、批量管理、OPML 导入导出、全局刷新 | 本轮实现（从原订阅页整体迁入） |
| 分组 | 新建/改名/删除分组，显示每组源数 | 本轮实现 |
| 账户 | 邮箱、显示名、角色、退出登录 | 本轮实现 |
| AI 分析 | 模型 API 配置 | **占位**（M2） |
| 每日简报 | 生成时间、聚合范围 | **占位**（M3） |
| 备份与迁移 | 数据目录、导出 | **占位**（M6） |

占位分类不是假的：点得到、能展开，里面写清"这一步会配什么、属于哪个里程碑"，
并明确标注「待接入」。给用户的是"以后会有"的确定感，而不是装作不存在
（沿用 §15.5 里 `SOON` 那条的同一条理由）。

**为什么用弹窗而不是第四栏**：配置是低频动作，常驻一栏会永久占掉 1/4 屏宽。
Huntly 用全高弹窗是对的：它遮蔽了主界面（告诉你"现在在配置，不是在读"），
又保留了侧栏位置的肌肉记忆（左边的分类栏就在原侧栏的位置）。

**边界条件**（每条都有断言，见 `m1-13-settings`）：

- 弹窗打开时后层不可交互（有遮罩），`Esc` 能关
- 左侧分类切换只换右侧内容，弹窗本身不重挂（不会丢已填的表单）
- 关闭弹窗时尚未保存的编辑被丢弃，重开是干净的
- 分组下拉栏选「未分组」→ 只显示 `folderId` 为 null 的源；选「全部」→ 全部
- 从配置里改完分组后关闭弹窗，侧栏的分组列表与未读数要同步（不能留旧值）
- 手机上配置弹窗占满视口，左侧分类栏变成顶部横向滚动条
- **侧栏里没有任何能打开订阅管理的按钮**，`.nav-section` 只剩「分组」「即将支持」
  （v1.13）。这条不能靠"点不到就点不到"—— 必须显式断言它不存在，否则
  一个"两处都能进"的实现照样全绿
- **手机上底部导航的最后一格是「配置」**（不是「订阅」），并且它能打开弹窗 ——
  手机没有侧栏，这一格是唯一入口，删掉就彻底进不去了

### 15.16 三栏的宽度与密度（v1.13 新增）

需求方反馈：「使用前端技能分析排版，选择合适的优化方式；目前发现左侧的工具栏
和订阅的列表栏占用空间过大，可以适当缩小」。

先把当时的实际占用量出来（1440×960，实测 `getBoundingClientRect`）：

| 区域 | 实测 | 占视口宽 | 问题 |
|---|---|---|---|
| 侧栏 | 218px | 15.1% | 最宽的标签是「独立博客」4 字 ≈ 56px，加上图标 + 未读角标 ≈ 130px，**剩余 88px 是空的** |
| 列表栏 | 400px | 27.8% | 标题 2 行在 14px 字号下平均占 340px 里的 1.3 行；摘要 1 行 12.5px 平均只用 260px |
| 阅读区 | 822px | 57.1% | 正文 72ch ≈ 594px，**左右各留 114px 空** |

结论不是"三栏太宽"，而是**三条栏都按最坏情况定宽，而实际内容够不着**：

- 侧栏按最长的分组名定宽，但那个名字本来就有 `text-overflow: ellipsis`
- 列表栏 400px 是按"标题能排到 2 行满"定的，实测绝大多数标题 1 行就够
- 阅读区把省下来的宽度全变成左右留白（72ch 是硬指标，不该跟着变）

**收敛方案**（每项都配一条断言，见 `m1-19-density`）：

| 项 | 之前 | 之后 | 为什么是这个数 |
|---|---|---|---|
| `--sidebar-w` | 218px | **196px** | 减 22px 后最长标签（4 个汉字 + 角标）仍能完整显示，再长仍走省略号 |
| `--list-w` | 400px | **368px** | 368 时标题 2 行仍能排满（实测平均 1.4 行），摘要 1 行不变；再窄到 340 就会频繁出现"标题被截在第 2 行中间"的观感 |
| 侧栏内边距 | `14px 10px 10px` | `10px 8px 8px` | 侧栏是导航不是内容，分组标题上方已有 18px 空隙做分隔 |
| 列表行内边距 | `10px 14px 10px 16px` | `9px 12px 9px 14px` | 每行省 4px，一屏 9 行省出 36px ≈ 再多 0.4 条 |
| 列表头内边距 | `14px 14px 11px` | `12px 12px 10px` | 头部常驻，压缩收益全在首屏 |

**净效果**：阅读区 822 → 876px（+6.6%），侧栏+列表 618 → 564px（−8.7%）；
组内源多时列表栏**不再被 chip 行挤占**（§15.13 已改为侧栏树），首屏条目数从 8 回到 9。

**v1.14 补记：这一节留了尾巴，由 §15.3 收掉**

v1.13 只把阅读区的**容器**从 822 撑到 876px，但正文列宽还锁在 72ch（640px），
于是容器变宽的那 54px **全变成了左右留白**（两侧各 118px）。需求方随后指出
「主内容栏的空间空白太多」—— 正是这里。v1.14 把正文默认宽度放宽到 80ch
（§15.3），1440 屏下两侧留白降到 82px。

教训记在这里：「把宽度让给正文区」和「正文区真的用上了宽度」是两件事，
只断言容器宽度（`reader.w >= 870`）会漏掉后者。所以 §19.3 的 1.19 ② 现在
断言的是**正文列宽与两侧留白**，不是容器宽度。

**不做的三件事**（写下来是为了下次不重开讨论）：

1. **不把正文放宽到 90ch 以上**。80ch 已接近长行可接受的边界，再宽回扫成本明显上升（§15.3）。
2. **不做侧栏折叠按钮**。折叠后分组树消失，而分组树正是 v1.13 的核心；为多 196px 而牺牲一个功能入口，是拿功能换数字。
3. **不把列表栏做成可拖拽**。可拖拽宽度需要持久化位置 + 重置入口 + 边界夹取，三项加起来比"窄 32px"的收益大得多。真到需要时按 A.1.1 提需求。

**窄屏阈值必须跟着下限走**：列表栏 368px + 侧栏 196px = 564px，加上阅读区的最小可用宽（72ch ≈ 594px）
共需 1158px —— 所以 `<1220px` 时把两栏各让一点（§15.16 末尾的 `@media (max-width: 1220px)`），
否则 1180px 的笔记本上会出现"正文被压到 60ch 以下"。这条由 `m1-19-density` 在 1180px 与 1440px 两个视口断言。

### 15.18 阅读区边缘与侧边目录（v1.15 新增）

需求方反馈：「显示界面加上边缘显示，同时可以加上侧边目录显示，利用侧边的空白」。

两件事，起因是同一个：§15.3 把正文收到 80ch 之后，宽屏上正文两侧各剩 82px（1920 屏
各剩 322px）空白。这块空白目前**纯属浪费** —— 既没有视觉作用，也没承载信息。

**① 边缘显示：正文列当成一张"纸"**

改之前正文直接坐在阅读区背景上，1440 下两侧 82px 的白和正文是同一个颜色，
看不出"正文到哪儿结束"。改法：

| 项 | 值 | 为什么 |
|---|---|---|
| 纸的底色 | 比阅读区背景亮一阶（暗色 `#12151b` / 亮色 `#ffffff`） | 只差一阶：差太多会变成"卡片"，与 §15.0 的三栏平铺冲突 |
| 圆角 | `--radius-lg`（14px） | 复用既有圆角尺度（§15.12），不新增第 5 档 |
| 阴影 | `0 1px 3px` + `0 8px 28px`，透明度 < 0.1 | 宽屏上要能看出层次，暗色下必须几乎看不见，否则像 90 年代的投影 |
| 上下留白 | 纸与阅读栏之间 16px | 让"纸"浮起来，不是贴边铺满 |

**纸宽度 = 正文 80ch + 左右内边距**，不是"阅读区减去两侧固定空白"。这条很关键：
写成固定 padding 的话，用户把宽度调到 96ch 后纸就不够了。所以纸的宽度跟着
`--reader-width` 走，两侧空白是**剩余量**而不是设定量。

**② 侧边目录：只吃右侧空白，绝不压正文**

目录放在正文右侧的空白里，前提是那块空白**放得下**：

| 视口宽 | 阅读面板宽 | 正文旁剩余 | 目录 |
|---|---|---|---|
| ≥ 1600px | ≥ 1036px | ≥ 244px | 显示，190px 宽，正文宽度不变 |
| < 1600px | < 1036px | < 244px | **不显示**，正文宽度不变 |

1600 这个数是这样算出来的：纸宽 = 80ch(712px) + 左右内边距 56px = 768px，
再加目录 190px + 间距 28px = **986px**； 自身左右各 24px → 需要
**1034px 面板宽**。面板宽 = 视口 − 196（侧栏）− 368（列表栏），所以视口要
≥ 1598px，取整 **1600px**。侧栏/列表栏在 ≤1220 断点会更窄，但那一段视口
本来就 < 1600，不会冲突。

190px 是"中文小标题 9 个字 + 省略号"能读的宽度，再窄就只能显示 5~6 个字。
**目录永不挤压正文** —— 这是与"减少空白"这条需求的一致性要求：为了目录把正文
从 712px 压回 590px，等于把 v1.14 白做。

**空目录不显示**。实测 20 篇真实文章：只有"科技爱好者周刊"这类长文有 11~12 个 h2，
其余的（短讯、日报、通稿）**一个 h2 都没有**。所以规则是「正文里 h2/h3 ≥ 2 个才出目录」——
1 个标题的目录没有导航价值，0 个则是空栏。不显示时右侧空白保持空白（那本来就是留白）。

**交互**：

| 动作 | 行为 |
|---|---|
| 点目录项 | 平滑滚动到对应标题，不换页、不改 URL |
| 滚动正文 | 当前所在小节在目录里高亮（`aria-current="true"`） |
| 目录项过长 | 单行省略号，`title` 给全文 |
| 当前文章无小标题 | 整个目录栏不渲染（不是渲染成空的） |

**怎么拿到标题**：正文 HTML 已经在 DOM 里（`dangerouslySetInnerHTML`），
目录从 `.article-body h2, h3` **直接读 DOM**，不走服务端解析。理由：
- 服务端加一列 `toc` 要为 10 万条历史记录回填，成本远大于收益；
- 清洗后的 HTML 才是唯一真相（§11.2 的同一原则），从别处再解析一遍会漂移。

点击跳转用 `element.scrollIntoView({ behavior: 'smooth', block: 'start' })`，
不用 `scrollTo(y)`：标题位置受图片懒加载影响，算出的 y 会偏。

**边界条件**（见 `m1-20-reader-toc`）：

- 面板宽 1440（两侧各 82px）→ 目录**不渲染**，正文宽度与 v1.14 完全相同
- 面板宽 1600+ → 目录渲染，且正文列宽**仍是 80ch**（不被目录挤窄）
- 文章无 h2/h3 → 目录不渲染；有 1 个 → 也不渲染；有 ≥2 个 → 渲染且条目数 = 标题数
- 纸的宽度随 `--reader-width` 变（调到 64ch 时纸也变窄），不是固定像素
- 点目录项后目标标题进入视口顶部附近，且**主框架 URL 不变**
- 手机上（< 640px）纸取消圆角与阴影、铺满 —— 手机上"一张纸"没有意义

### 15.19 默认只看未读（v1.16 新增）

需求方反馈：「记得默认进去查看的都是未读数据，只有点击全部才会显示全部数据」。

改之前 `view` 的初值是 `'inbox'` —— 打开应用看到的是"读过的 + 没读过的混在一起"，
已读条目还占着一大半列表高度。这不是"提供了一个选项"，而是**每次都先把用户
不想看的塞给他**，再让他手动筛掉。默认值应该等于最常见的那次操作。

**这一条不是新增能力，是改默认值**，但它有三处连带影响，所以单独成步：

| 影响 | 处理 |
|---|---|
| 侧栏哪一项高亮 | 「未读」整项高亮。改之前侧栏亮「收件箱」、分段控件亮「全部」，本来就有一处含糊；现在默认是未读，亮「收件箱」会让人以为收件箱缺数据 |
| 分段控件 | 「未读」激活、「全部」不激活。`.seg-btn.on` 与 `aria-pressed` 必须一致（`m1-21` 两处都断言） |
| 要不要记住上次的选择 | **不记**。刷新页面回到未读。"上次点了全部"是一次临时查看，不是长期偏好；把它持久化会让下次打开又是混着的列表 —— 与这条需求相反 |

**这一条与 §15.14 的关系**：§15.14 定义的是"全部 / 未读怎么切、刷新怎么不闪白"，
这一条只改**初值**。§15.14 里「默认『全部』激活」那句随之失效并被本节取代，
`m1-12` 的那条断言同步改为「默认『未读』激活」，其余断言不变。

**边界条件**（见 `m1-21-default-unread`）：

- 首次进入：分段控件「未读」激活、「全部」不激活，列表里没有已读条目
- 侧栏「未读」同时高亮；点「全部」后侧栏高亮转到「收件箱」
- 「全部」看到的条数 ≥ 「未读」条数，差值 = 该范围内已读的条数
- 刷新页面回到「未读」（默认状态不持久化）
- 从分组或单个源进入时也是只看未读（默认值作用于所有范围，不是只作用于收件箱）
- **冷启动那次请求就带 `view=unread`** —— 不是先拉全部再在前端过滤。
  后者在 10 万条库上要多传几十页，而且"未读"的分页游标会和"全部"错位
- 手机上底部导航第 2 格「未读」同样高亮

### 15.20 未读清零后的落点（v1.17 新增，v1.18 推翻重做）

需求方反馈两条，指向同一个空洞：**「未读」为空时，界面不知道把人送去哪**。

> 「当没有未读数据的时候自动切换到对应订阅的所有订阅中」
> 「在某一个订阅中，没有新的未读信息，里面有一个跳转全部。应该跳转对应的全部，
> 而不是所有数据的全部」

第一条是"该自动跳"，第二条是"跳的地方错了"。它们不是两个 bug，是同一个
设计缺口的两面：§15.19 把默认视图改成「未读」之后，「未读」成为一个**正常
会空**的视图，而空态的处理还停留在「收件箱空 = 没有订阅」那个年代。

**改之前的两处具体表现**

| 场景 | 改之前 | 问题 |
|---|---|---|
| 点进一个已读完的源（4 篇都读过） | 进「未读」→ 列表空 → 显示「收件箱是空的 / 还没有订阅任何源」 | 文案直接说错：用户有 12 个源、只是这个源读完了。而"这个源里的文章"本来就有 4 篇，只是被「未读」筛掉了 |
| 在那个空态里点「看全部条目」 | `setScope({})` —— 分组和源一起被清掉，跳到**全库** | 用户想看的是"这个源都读过什么"，结果得到全库混合列表，还得自己重新点回那个源 |

**v1.17 的方案（已废弃，留档说明为什么错）**

规则一当时写成："点选范围时，该范围 0 未读就直接把 `view` 设成 `inbox`。"
它带来两个连续的问题，第二个是第一个的必然结果：

| # | 现象 | 根因 |
|---|---|---|
| 1 | 点进一个读光的源，「全部/未读」分段控件自己跳到「全部」 | 界面替用户改了他没点过的东西；用户点的是"未读"，看到的是"全部" |
| 2 | 一旦在任何一个范围里点过「全部」，之后点**所有**分组/源都停在「全部」 | `viewForScope` 里有 `if (base === 'inbox') return 'inbox'` —— 把**视图状态**当成了**范围的属性** |

需求方原话：「从长知识的无未读，切换到其他分组（有未读）还是在全部里面，
这个每次点击需要判断一下。」

**v1.18 的规则：分段控件不动，用分割线补已读**（详见 §15.24）

| 触发 | 行为 |
|---|---|
| 点分组 / 点组内源 | `view` 一律回到**默认值**（「未读」），不沿用上一个范围的选择 |
| 该范围 0 未读 | 列表在未读部分之后画一条分割线「更早的 N 条已读」，接上该范围的已读条目 |
| 该范围有未读 | 只列未读，不画分割线 |
| 读完最后一篇的那一刻 | **不自动补**，仍显示空态 + 「看全部」按钮 |
| 当前是全库（没有范围） | 不补已读（补出来等于把整个阅读历史铺进列表） |

"读完不自动补"这条仍然成立，理由与 v1.17 相同：**"读完这一篇"和"我要看
读过的"是两件事**。点选是**用户的移动**，读完是**内容的消耗**，只有前者
能作为改筛选的依据。

**规则二：空态里的按钮只切读/全部，不改范围**（v1.17 定，v1.18 保留）

两个动作拆成两个按钮，因为它们是两件事：

| 按钮 | 做什么 | 出现在 |
|---|---|---|
| 「看全部」 | 只把 `unread` 切成 `inbox`，**保留分组与源** | 「未读」清零时 |
| 「看全库条目」 | 清掉分组与源，回到全库 | 分组/源里一条条目都没有时（真的空范围） |

改之前只有一个「看全部条目」包办了前者，于是"在某个源里"点它必然跳全库。
一个按钮同时改两个正交条件（读/全部 × 范围），是它必然跳错的原因 ——
只有把条件拆开，按钮的文案才能指代它真正做的事。

**空态文案的分档**（v1.18 调整了两档的顺序）

| 条件 | 标题 | 为什么不能合并 |
|---|---|---|
| 有搜索词 | 没有匹配的条目 | 切「全部」也变不出东西，只该提示换词 |
| 有范围且 `scopeHasEntries === false` | 「组名」里还没有条目 | 源刚添加还没抓到，与"读完了"不同 |
| `view=unread` 且库里有源 | 未读已经清零 / 「组名」里没有未读 | 下一步是"去看读过的"，不是"去添加订阅" |
| 库里一条源都没有 | 收件箱是空的 / 还没有订阅任何源 | 新装用户，唯一有用的动作是添加订阅 |

**第二、三档的顺序在 v1.18 必须调换**：v1.17 里"真空范围"永远到不了「未读」
空态（被规则一自动切到「全部」了），所以按 `view` 分档没问题。取消自动切换
之后，一个刚添加、还没抓到的源会停在「未读」，于是它会被告知"这个范围里的
文章都读过了"—— 而它一条都没有。

判据必须是 `scopeHasEntries`（已读尾段的 total），**不能**用 `items.length`：
进空态时未读恒为 0，`items` 必然是空的，用它判断会恒为"没有条目"，反而把
"读光了"说成"还没有条目"。

第四档必须由 `feeds.length > 0` 判定，不能靠 `view` 或 `items.length` 推：
一个刚初始化、一条源都没加的用户和"全部读完了"的用户，`items` 都是空。

**一处必须等两份数据都到位**：空态渲染条件里加了 `feedsLoaded`。
源列表与条目列表是两个并行请求，缺了它，源列表慢一拍的那一瞬间会先画
一帧「还没有订阅任何源」—— 已订阅 12 个源的用户会看到它闪一下。
v1.18 再加一个 `!tailFetching`：读光的源此时列表也是空的，等尾段回来再决定
是画分割线还是画空态，否则会先闪一帧「未读已经清零」。

**边界条件**（见 `m1-22-empty-scope`）：

- 点进 0 未读的源 → 分段控件**仍是「未读」**，分割线补出该源的全部已读
- 点进 0 未读的分组 → 同上，且只含该组
- 点进有未读的源/分组 → 只列未读，**没有**分割线
- 手动选「全部」后点任何范围 → 回到「未读」（v1.18 修的 bug）
- 再点同一个源（取消源筛选回整组）→ 也按整组重判
- 读完最后一篇 → 显示空态 + 「看全部」，`view` 仍是 `unread`；点它 → 变成「全部」且**范围不变**
- 有搜索词时 0 命中 → 说「没有匹配的条目」，不补已读
- 真的空范围（源里 0 条条目）→ 说「还没有条目」+ 按钮「看全库条目」
- 库里 0 个源 → 空态是「去添加订阅」，不出现「看全部」
- 未读角标在读完一篇后**立即**减 1（分组行、源行、侧栏「未读」三处同步），
  不需要点刷新（`m1-22` ⑤）

### 15.21 按分组 / 按单个订阅清零未读（v1.17 新增）

需求方：**「缺少清除分组未读、单个订阅所有未读等功能」**。

这是 M1 一直缺的一块。§15.19 把默认视图改成「未读」之后，这个问题从
"可以有"变成了"必须有"：一个订阅积累了几百条未读、而用户只想要新的，
原来唯一的做法是一条一条点开 —— 那等于把"未读"这个默认视图变成惩罚。

**范围只有两档，没有第三档**

| 入口 | 范围 | 出现在 |
|---|---|---|
| 中间栏标题行 | 当前分组（`folderId`）或当前单源（`feedId`） | 有范围**且**该范围未读 > 0 |
| （不做） | 全库 | — |

**刻意不提供"清全库"**，后端 `POST /entries/mark-all-read` 在既没有
`feedId` 也没有 `folderId` 时直接 400。理由不是参数校验洁癖：

- 这个操作的代价和收益不成比例。清一个源是"这 40 条我不要了"，
  清全库是"这个库里所有源的所有未读都消失"，而它们的收益都是省几次点击。
- 全库清零一旦误触**没有撤销**（批量标未读得一条条来）。一个不可撤销、
  收益极小、可能损失几百条待读的巨大动作，不值得开一个按钮。

**只写 `is_read`，绝不写阅读历史**

| 字段 | `POST /entries/read` | `POST /entries/mark-all-read` |
|---|---|---|
| `is_read` | 1 | 1 |
| `first_read_at` | 首次打开时写入 | **不动** |
| `last_read_at` | 每次打开刷新 | **不动** |
| `read_count` | +1 | **不动** |

两个动作的语义不同：

- `read` 表达「我打开了这篇」，所以它产生阅读记录，出现在「历史」页。
- `mark-all-read` 表达「这些我不打算看了」，它是**视图层的意愿**，
  不是阅读事实。

在后者里补 `last_read_at = now` 的后果很具体：清一个 200 条未读的分组，
「历史」页会凭空多出 200 条从未打开过的文章，每条都标着"今天读过" ——
那是在伪造阅读记录，而且伪造得无法分辨。

**边界条件**（见 `m1-23-mark-scope-read`）：

- 按源清 → 只动那个源；同组其他源、组外源、未分组源一条不改
- 按分组清 → 组内全部源清空；组外一条不改
- 不带范围 → 400，且**一条都没被改**（不是"先清了再报错"）
- 重复条目（`duplicate_of` 非空）不算进返回的 `count`，也不被标记 ——
  它本来就不在时间线里，把它算进来会让"清了 42 条"和"未读掉了 40"对不上
- 幂等：已经清空的范围再清一次返回 `count: 0`
- 不存在的源/分组 → 200 + `count: 0`（不是 500：另一个标签页刚删掉它）
- UI：按钮只在「有范围 + 未读 > 0」时出现；点它必须确认，确认文案里
  要写明**多少条**会消失；清完按钮自己消失
- 清完之后分组行的角标归零，组内各源的数字靠重取 `/feeds` 校正 ——
  服务端只回一个总数，逐源的减法在客户端猜不准

### 15.22 中间栏标题行对齐（v1.17 修复）

需求方：**「中间栏的标题部分、数量、清除分组信息等都不对齐」**。

**改之前是什么样**

标题行原来是「h1 + 条数 + × + 分段控件 + 刷新」五样东西挤在一个
`align-items: baseline` 的 flex 里，各自用 `align-self` 找位置：

| 元素 | 原来的定位方式 | 结果 |
|---|---|---|
| h1 / 条数 | 跟着父级 baseline | 两个不同字号的文字各走各的基线 |
| 分段控件 | `align-self: center` + `margin-left: auto` | 自己贴右，位置由前面有谁决定 |
| 刷新 | `align-self: center` + `margin-left: 4px` | 同上 |
| × | 20×20（其余按钮 22×22） | 同一排里两种高度 |

两个具体后果，实测出来的：

1. **同一行两条中线。** 旧 CSS 下 h1 的中线在 24.8px，分段控件与刷新在
   27px —— 差 2.2px 不是玄学，就是"文字坐在基线上、控件坐在中线上"。
   把旧规则注入回页面实测得到这组数字（`.tmp/proof-m124-fails-before.mjs`）。
2. **前面少一个元素就整体左移。** 分段控件在「已收藏 / 历史」视图隐藏，
   隐藏后刷新按钮靠自己的 `margin-left: auto` 重新找位置 ——
   实测左移 **82px**。

**改法：把"一行"拆成两段语义**

| 段 | 内容 | 对齐方式 |
|---|---|---|
| 左段 | 标题 + 条数 | 我在看什么 |
| 右段 `.pane-actions` | 分段 / 清除未读 / 清除范围 / 刷新 | 能对它做什么 |

- 外层 `align-items: center`，整行只有一条中线；条数用 `line-height: 22px`
  与标题行等高，不再靠 baseline 碰运气。
- 右段整块 `margin-left: auto`，内部 `gap: 4px`。任何一个按钮显隐
  只影响自己那一格，其余位置不动。
- 右段里所有按钮统一 22×22（`.pane-actions .icon-btn.tiny`），
  与分段控件同高。原来 20 / 22 / 23 三种高度并排，怎么调都对不齐。

**判据必须是几何数字，不能是"看着顺眼"**

`m1-24-pane-head` 全部用 `getBoundingClientRect()`：

| 断言 | 阈值 | 为什么是这个数 |
|---|---|---|
| 所有可见控件的垂直中线极差 | ≤ 1.5px | 新实现实测 0.00px；旧实现 2.20px |
| h1 与「N 条」的中线差 | **≤ 1.0px** | 新实现 0.00px；旧实现 **1.20px** —— 用 1.5 会假绿（这条是收紧过的，见下） |
| 最右按钮右边缘与行右边缘 | ≤ 1.5px | 右段贴边 |
| 分段与刷新的间距 | 4 ± 1.5px | 间距由 gap 承担，不是某个按钮自带 margin |
| 分段隐藏后刷新 left 变化 | ≤ 1px | 旧实现 82px |
| 相邻控件不重叠 | `right[i] ≤ left[i+1]` | 防止"对齐了但挤在一起" |
| 375px 下 `scrollWidth ≤ clientWidth` | +1px | 窄屏不许溢出 |

**一个自己抓自己的坑**：② 的第一版阈值写 1.5px，而旧实现的实测差是
1.2px —— 那条断言在**改之前也是绿的**，等于空断言。所以每次定阈值都要
拿旧实现量一遍：把旧 CSS 注入活页面（不重建二进制），确认新阈值下它真的红。
`①`（极差 2.2px）就是被分段控件那 23px 高度撑出来的，
单独看两个文字元素抓不到 —— 两条断言要一起留。

### 15.23 瞬时失败不再把订阅判死（v1.17 修复）

需求方：**「发现有订阅失效，但是手动重试又是好的」**。

**现象与根因**

本机库实测：21 个源里 **15 个** `status='broken'`。逐条看日志，其中 **11 个**
的失败原因只有两种：

```
抓取失败 阮一峰的网络日志: 网络错误: fetch failed
抓取失败 月光博客: 请求超时（30s）
```

这 11 个 URL 现在用 curl 手工请求全是 200。也就是说源本身没问题，
是**那段时间整机网络在抖**。

判据原来是：

```ts
const broken = !err.retryable || count >= BROKEN_AFTER;   // BROKEN_AFTER = 3
```

`retryable` 只区分 404/410，其余一律 true —— 于是"连续三次网络不通"
等于 `count >= 3`，直接置 `broken`。而 **`broken` 是终态**：
`sweepDueFeeds` 只挑 `status = 'active'`，它再也不会被自动抓取。
用户必须手动点一次"重试"才回来 —— 这正是需求方描述的现象。

**改法与三条连带决定**

```ts
const broken = !err.retryable;   // 只有确凿的永久失效才置 broken
```

| 决定 | 取值 | 理由 |
|---|---|---|
| 瞬时失败 | 永远 `active`，只靠退避放慢（上限 8 倍 = 4 小时） | 站点临时挂了不该让它从时间线上消失 |
| 404 / 410 / 域名没了 | 第一次就 `broken` | 这才是"这个源真的没了"，用户需要看到明确结论 |
| `error_count` | 仍累加（封顶 999） | 它现在只服务退避与"最近老失败"提示，不再决定生死 |

**修判据不会回头改数据**

和 §7.5 那批 stuck 的 `pending` 是同一个道理：改代码只影响未来的写入。
已经躺在 `broken` 里的那批需要一个显式动作，所以加了
`POST /feeds/retry-broken`（订阅页顶部出现「重试失效源 · N」按钮）：

| 步骤 | 说明 |
|---|---|
| 只碰 `status='broken'` | active / paused 不动 |
| `error_count = 0`、`next_fetch_at = now` | 不用等退避窗口才抓 |
| 单事务 + 入队 | 与"全部刷新"同一条路径 |

**为什么不做"每小时自动复活"**：对真的死掉的源（域名没了），每小时试一次
只是往日志里加一排失败；而它对用户可见的成本正好是"看起来又坏了"。
让用户按一次按钮，比让服务自己猜要诚实。

**边界条件**（见 `m1-04-feeds` ⑨⑩）：

- 瞬时失败（500）连打 **5** 次仍 `active`，`error_count` 累加到 5
- 瞬时失败的源仍在 sweep 候选里（`status='active'` 且已到期）
- 404 一次即 `broken`，且再次抓取不会把它改回 active
- 「重试失效源」只改 broken；返回的 `revived` 数 = 改前 broken 数
- 复活的源 `error_count` 归零、`next_fetch_at` 立刻到期
- 断言必须打满 5 次而不是 3 次：只打 3 次的话，"第 4 次才置 broken"的
  实现照样能过

### 15.24 分割线补已读（v1.18 新增）

需求方：

> 「从长知识的无未读，切换到其他分组（有未读）还是在全部里面，这个每次点击
> 需要判断一下。我切换未读之后，如果某一个里面没有未读，只给他临时切换到全部，
> 或者还是显示未读，是指在列表栏中分割线，补充上全部的列表，可以参考 huntly 实现」

这段话里有两个独立要求，前一个是我们自己的 bug，后一个是新增能力。

**第一件：每次点选范围都要重判**（bug，见 §15.20 的 v1.17 复盘）

`viewForScope` 原来是 `if (base === 'inbox') return 'inbox'`。它能被需求方
一眼看穿，是因为那句话把**视图状态**当成了**范围的属性**：在一个分组里点
「全部」表达的是"这一组我想看全部"，不是"以后所有分组都看全部"。

修法是把它压成一条规则：**点选范围 = 回到默认的「未读」**。

```
const viewForScope = useCallback((): View => DEFAULT_VIEW, []);
```

函数保留而不是内联成 `setView(DEFAULT_VIEW)`：`pickFolder` / `pickFeed`
两处都要用，留一个名字才有一处可改。也刻意不再接收 `(folderId, feedId)`——
它现在不需要未读数就能回答，参数只会让人以为它还在做判断。

**第二件：0 未读时用分割线补已读**

不再偷偷切分段控件，而是在列表内部画一条分节线：

```
───────── 更早的 30 条已读 ─────────
[已读条目…]
```

六个设计决定，每个都有具体反例：

| 决定 | 反例（另一种做法为什么会出错） |
|---|---|
| 分段控件**不动** | 用户点的是"未读"，控件却自己跑到「全部」—— 他会以为自己点错了 |
| 分割线与主列表在**同一个 `<ul>`** | 拆成两个 `<ul>` 会多一层块级边界，分割线两侧行距对不上；"加载更多"该挂哪一个也变成问题 |
| 只在**有范围**时补 | 全库补出来等于把整个阅读历史铺进列表（本库实测 610 条），界面上"看完了"的错觉变成"永远看不完" |
| 只在**未读 = 0** 时补 | 还有未读时也补，「未读」这个分段控件和列表内容就对不上了 |
| 有**搜索词**时不补 | 用户搜"xx"是在找含这个词的未读，补已读等于把搜索意图改掉 |
| 标题条数改用**尾段 total** | 否则会出现「0 条」而列表里明明有 4 条 |

**为什么用"分割线"而不是"自动切全部"**：两者都解决了"进去看到空白"，
但前者把变化说在明面上 —— 上面是未读（0 条），下面是更早读过的。后者是
界面单方面换了筛选条件，用户没有任何途径知道自己看到的是"全部"。

**尾段的取数条件**（`App.tsx` 里那个 effect，五个准入条件）：

```
view === 'unread' && !debounced && (folderId || feedId)
  && total === 0 && cursor === null && !loading
```

第五个条件（`cursor === null`）容易被漏：未读本身还没翻完页时插分割线，
它后面还有未读，位置就是错的。

**标题条数的取舍**：`total` 的语义是"当前筛选的命中数"，补尾段之后它变成
未读的命中数（0）。所以有尾段时标题改用 `readTailTotal` —— 这一处要回答的
问题不是"未读有多少条"，而是"这个范围里有多少条"。两个问题用同一个变量
回答，必然有一个是错的。

**尾段翻页单独一个函数**（`loadMoreTail`）：复用 `load` 会把结果 append 到
`items` 并把 `cursor` 往前推，污染主列表的游标 —— 下一次 `load(true)` 重取
时从尾段的位置开始，主列表就少了一截。两个列表各有游标，就该是两个函数。

**顺带抽出的 `EntryRow` 组件**：不是为了复用，是因为分割线要求**同一行在
两处长得一样**。两份 JSX 会在某次修改后差 2px，而这种差别只有肉眼能发现。
抽出来之后，主列表（未读）、尾段（已读）、历史视图三处共用同一份行渲染，
历史视图通过 `meta` 插槽把"发布多久以前"换成"读多久以前"。

**后端新增 `view=read`**（`GET /entries?view=read`）：返回 `is_read = 1` 的
条目，与 `view=history`（`last_read_at IS NOT NULL`）不同 —— 后者只认"真的
读过"，而分割线要补的是"这个范围里剩下的条目"，必须与「全部」视图扣除
未读后完全一致（包括被「清除分组未读」批量标记的那些）。

**边界条件**（见 `m1-22-empty-scope` 60 条断言）：

- 点进 0 未读的源 → 分段控件仍是「未读」，4 条已读全部补在分割线下
- 点进 0 未读的分组 → 同上且只含该组
- 有未读的范围 → 只列未读，**没有**分割线（③ 是这条的反面用例）
- 手动选「全部」后点另一个分组 → 回到「未读」（④，v1.17 bug 的回归守卫）
- 再点同一个源（取消筛选回整组）→ 也按整组重判
- 读完最后一篇的那一刻 → 不自动补已读
- 全库 0 未读 → 仍是空态 + 「看全部」，不铺满全库
- 搜索 0 命中 → 说「没有匹配的条目」，不补已读
- 真·空范围 → 「还没有条目」+ 「看全库条目」（不是「未读已经清零」）

### 15.25 顺手改的 m1-11 前提（v1.18）

`m1-11-folder-feeds` 验的是"分组/源筛选"，不是"读/全部"。它原来在脚本开头
点一次「全部」，然后靠"点选范围会沿用当前视图"这个假设一路走到底。§15.24
取消沿用之后，4 条断言跟着红了 —— 红的是脚本的前提，不是实现。

修法是把"看该范围全部条目"的表态挪到 `clickGroup` / `clickLeaf` 里，每次
点选之后重新点一次「全部」。这样脚本的意图（"我在验范围筛选"）与实现规则
（"点选回默认视图"）不再互相假设。

**这一条值得记下来**：当一个规则被推翻时，依赖旧规则的前置**必须一起改**，
但改法要改在 **helper** 里而不是每条断言前 —— 后者会让人以为是 43 条断言
各自坏了。

### 15.26 未分组源平铺在侧栏（v2.0 新增，1.26 落地）

**需求方原话**：「未分组的直接在组的地方显示，没有分组就意味着在最外面直接看」。

v1.13 做侧栏分组树时，把未分组源留在了"侧栏无入口"的状态（§15.13 表格最后一行
写着「侧栏仍无入口」）。当时的理由是"未分组是过渡态" —— 但实测本机库 21 个源里
有 2 个未分组，而它们的条目在「收件箱」里照样出现。于是出现一个具体的坏结果：

> 在收件箱里看到一篇好文章，想知道"这是从哪个源来的" → 只能在配置弹窗里翻 21 行
> 找那个没有分组标签的源。而分组里的源，侧栏点两下就到了。

**做法：平铺，不造层级**

未分组的源直接作为**分组区块里的普通行**渲染，与分组行同级（同一缩进、
同一种行高）。不额外包一个可展开的「未分组」伪分组 —— 理由是需求方那句
"在最外面直接看"：伪分组多一次点击，而"未分组"通常只有个位数个源。

| 元素 | 行为 |
|---|---|
| 未分组源行 | 与分组行同缩进、同高度；点一下 = 只看这个源的条目（`folderId=none&feedId=X`） |
| 未分组行的高亮 | 与分组内子行同一套（选中即高亮），且**顶部筛选一并显示为「未分组 · 源名」** |
| 排序 | v2.1（§15.28）起**改到最前**，排在所有分组行**之前**；未分组内部按 `feeds.sort`，并列时按 `zh-CN` 拼音序。原先是"固定在所有分组之后、组内按标题"—— 那一版把未分组当成"剩下的东西"，而它们其实最需要被看见 |
| 一个未分组源都没有 | 整块不渲染，不留空标题 |
| 分组区块标题 | 从「分组」改为「分组与未分组源」？**不改** —— 一个区块里混两种东西却不说明，
  靠"它在分组列表上面"这一位置信息足够；改标题会让分组多时标题过长

**为什么不做成"未分组"伪分组（可展开）**：那会让侧栏出现两种可展开的东西
（真分组、伪分组），而伪分组里没有"组"这个实体 —— 点它的行选中什么？
选中"所有未分组源"是个真实需求（`folderId=none` 已支持），但它可以在列表栏
的标题里给一个「未分组」范围，不必占侧栏一行。

**边界条件**（每条一个断言，见 `m1-26-ungrouped.mjs`）：

- 未分组源不重复出现（既不漏在分组外，也不被算进任何组）
- 点未分组源行 → 请求带 `folderId=none&feedId=<id>`，列表只剩这个源的条目
- 再点同一行 → 取消源筛选，回到 `folderId=none`（所有未分组源）
- 未分组源的未读数与分组内源同一套角标规则（0 也显示）
- 搜索框输入后未分组行**仍然可见**（它只是源的清单，不是条目清单）
- 排序按 `localeCompare(.., 'zh-CN')`（拼音序）。实测本机 Node 24 的
  ICU 完整，`零/七/三` 得到 `零(ling) < 七(qi) < 三(san)`；而码点序会给
  出 `七 < 三 < 零`。用默认比较器不会报错，只会让清单看起来是乱的

**手机上这一块看不见 —— 这是既有行为，不是 1.26 引入的**

`mobile.css` 在 `≤640px` 下把 `.sidebar` 设成 `display: none`，用底部
tab bar 代替（§15.7：一行六个入口）。也就是说**手机上整个分组树都不存在**，
未分组行跟着一起消失。这不影响"侧栏有没有未分组入口"这个需求 ——
它的场景是"桌面上找不到那个源"，而手机上原先连分组筛选都做不到。

因此这条没有"抽屉里仍可点"的断言，取而代之的是：手机上**不因为未分组块
而报错或留空壳**（分组区块整块不渲染、tab bar 仍是 6 格）。要真正让手机
也能按源筛选，那是新增需求（需要设计抽屉或二级页），不在 1.26 范围内。

### 15.27 阅读页「总结」按钮（v2.0 新增，2.7 落地）

按钮放在**阅读工具条**（`reader-bar`）里，`AI 摘要` 卡片右侧。理由：那个卡片
是"这篇讲了什么"的静态答案，而总结是"按我要的方式再讲一遍"——两个动作属于
同一件事，放一起才不会被当成两个功能。

| 状态 | 表现 |
|---|---|
| 还没总结过 | 按钮写「总结」，点一下开始 |
| 生成中 | 按钮禁用 + 文案「总结中…」，正文区出现骨架条（不是转圈遮罩 —— 遮罩会让人以为页面卡了） |
| 有缓存（同提示词） | 直接展开，按钮写「重新总结」，旁边一行小字「缓存于 x 分钟前」 |
| 失败 | 气泡里给出 `kind` 对应的一句话（401 → 「key 无效」，network → 「连不上接口」），不吞错误 |
| 提示词被改过 | 旧缓存不显示为"这篇的总结"，而是列表里多一条「按旧提示词生成的」并标时间 |

**渲染复用简报的 Markdown 渲染器**（`client/digest/markdown.tsx`）。不新写一个，
因为"模型输出不能变成 HTML"这条约束守两遍就会有一遍漏。

**位置在正文之上还是之下**：**之上**，紧贴 AI 摘要卡片。总结短（几百字），
放在正文前是"先看结论再决定读不读"；放正文后等于读完才看到，那时它已经没用了。

---

### 15.28 分组与源的排序（v2.1 新增，1.27 落地）

**需求方原话**：「我希望可以在分组栏长按，去调整分组顺序等」，随后追加四条：
未分组源也要参与排序并能拖进/拖出分组；进入和移出分组要有提示；长按之后要有
悬浮/高亮一类的特效；配置里再给一套上下箭头的手动方式，不用长按。

**改之前的状态**：`folders.sort` 一直存在（建组时写 `MAX+1`，读取时
`ORDER BY f.sort, f.name`），但**没有任何能改它的入口** —— `PATCH /folders/:id`
只接受 `name`。用户看到的顺序就是"当初建它们的顺序"，建歪了只能改数据库。
源更彻底：`feeds` 表**没有** `sort` 列，顺序由 `ORDER BY status='broken', title`
决定，既不能排也不能摆。

#### 15.28.1 两个入口

| 入口 | 动作 | 适用 |
|---|---|---|
| 侧栏的任意分组行 / 源行 | 按住 500ms | 桌面鼠标 / 触屏 |
| 配置 › 分组 | ↑↓，**常显** | 手机 / 键盘 / 找不到长按的人 |

两条路改的是同一份数据、同一套提交接口，但**不动同一套界面状态**：侧栏是
拖拽模式，配置页是常驻箭头。

为什么配置页必须是常显箭头而不是复用拖拽：≤640px 时 `.sidebar` 是
`display: none`（§15.7），手机上整个分组树不存在 —— 配置页是那里**唯一**能管理
分组的地方。而配置页的场合是"一次整理十几项"，箭头每点一次都是明确的
"上移一格"，可键盘完成，也能被断言精确验证。

#### 15.28.2 长按判定

`pointerdown` 起 500ms 定时器，下列任一情况取消：`pointermove` 累计 > 8px、
`pointerup` / `pointercancel`、`contextmenu`。取消后若本次是 `pointerup` 且未超
位移阈值，**照常当点击**（选中分组/源）。

- **500ms 的来历**：低于 400ms 会和"点一下选中"抢手势，用户点得稍慢就直接进了
  排列模式，而他这一下原本只是选分组；高于 600ms 又显得没反应。
- **8px** 是触摸抖动容差；超过它说明用户在滚动或拖选，不是想排序。

#### 15.28.3 长按之后的视觉

需求方要的"特效"按常规做法实现，每个阶段都要有信号：

| 阶段 | 表现 |
|---|---|
| 长按触发 | 该行浮起：`--bg-elev` 底 + `--shadow` + 放大到 1.02；其余行降到 0.72 不透明度 |
| 拖动中 | 浮起卡片跟指针走；**原位置留淡色占位**而不是整行消失（整行消失会让下面的行整体上跳，正在拖的人失去参照） |
| 悬停在行间 | 目标行上/下边缘一条 2px `--accent` 落点线，同一时刻只有一条 |
| 悬停在分组行上 | 整行 `--accent-soft` + 一圈 `--accent` 描边，表示"放进去"；此时**不画**落点线 |
| 松手在原位 / 拖到窗外 / `Esc` | 退回原位，顺序不变，不发请求 |

浮起卡片必须 `pointer-events: none`：否则它永远在指针正下方，
`findDropTarget` 会一直命中它自己，落点永远不动。

浮起卡片必须 `position: fixed`：侧栏是 `overflow-y: auto`，
拖出侧栏右边界的部分会被裁剪。

#### 15.28.4 进入 / 移出分组的提示

跨组移动后，窗口底部中间弹一条 toast，2.6 秒后自动消失，带「撤销」：

```
  ✓  「阮一峰的网络日志」已移入「科技 IT」   撤销
```

- 「撤销」把归属与位置一起还原。**只改 `folderId` 是不够的** —— 那会让它落在
  原组末尾，而不是原来的位置。
- **同组内纯调序不弹 toast**：那是原地微调，屏幕上那一行只是上下挪了一格，
  弹一条比不弹更吵。只有跨组才提示 —— 因为"归属改变"在侧栏里只体现为一行换了
  位置，没有提示的话用户很难确认自己做对了。
- **失败时**同一位置换成红色 toast，带原因，**不自动消失**，要人点掉。
  一闪而过的失败信息等于没告诉用户。

#### 15.28.5 提交时机

**每次落位 / 点一次箭头就提交一次**，不攒到「完成」再提交。攒着的话，排到一半
刷新页面、切标签、来电话回来，攒着的调整全部丢失，而且丢得无声。
「完成」只负责退出模式；退出**不是**撤销。

失败时**不退出排列模式**。退出等于用户刚做的调整无声消失，他只会以为"又白弄了"。

#### 15.28.6 数据与接口

```
PATCH /api/v1/folders/reorder     { ids: string[] } → { items: FolderWithCount[] }
POST  /api/v1/feeds/arrange       { folderId: string|null, ids: string[] } → { ok, moved }
```

- 两个接口同一条规则：列出的按 `ids` 顺序拿 `sort = 0..n-1`，
  **未列出的保持原相对次序、顺延在后**。
- 为什么允许只给一部分 id：两个标签页同时开着，A 页新建了一个分组，B 页此时提交
  它自己看到的那几个 —— 要求"必须给全部"会把 B 页的提交拒掉；按"未出现即删除"
  处理则那个新分组直接没了。两种都不对。
- 为什么是整表提交而不是"把 X 移到第 k 位"：一次拖动可能跨好几行，逐条移动要么
  变成 N 次请求，要么前后端各算一遍插值 —— 谁算谁就容易对不上。整表提交只有一种
  真相。
- `POST /feeds/arrange` 一个端点覆盖三种动作（组内调序、移入某组、移出到未分组），
  因为它们说的是同一句话。拆成三个的话，跨组拖动（同时换组又定序）还得前端先
  判断是哪一种，而那正是最容易写错的地方。
- 有不属于本用户的 id 就**整体拒绝**，不静默跳过：静默跳过会让"我提交了 5 个，
  怎么只动了 4 个"变成无法解释的现象。

⚠️ **`PATCH /folders/reorder` 必须注册在 `PATCH /folders/:id` 之前**。
Hono 按注册顺序匹配，反了的话 `"reorder"` 会被当成分组 id，接口永远 404
「分组不存在」。`/folders/unfile/feeds` 与 `/feeds/bulk/refresh` 都踩过同一个坑，
源码里都留着注释。

#### 15.28.7 新增 `feeds.sort`（迁移 0007）

```
ALTER TABLE feeds ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_feeds_folder_sort ON feeds(user_id, folder_id, sort);
```

`listFeeds` 改为 `ORDER BY f.status = 'broken', f.sort, f.title IS NULL, f.title`。
失效源仍排最后（§15.23 不变）。默认 0 是刻意的：老数据全部并列在 0 上，
于是退回按标题比，**迁移前后界面上完全看不出变化**。

**四个排序键必须前后端一致**：失效源 → `sort` → 空标题 → 标题拼音。
客户端比较器在 `arrange.ts` 的 `compareFeedInGroup`，侧栏与配置页共用。
少任何一个键都会在 `sort` 并列时露馅（迁移后老数据全是 0，一开始**全都并列**）：
少了「失效源」一个刚被判死的源会跑到组内第一个；少了「空标题」一个刚订阅
还没抓到标题的源（`title` 为 null）会跑到最前，因为 `''` 比任何中文都小。

新建源写"所在组的 MAX+1"而不是 0：写 0 的话新源会插到所有老源前面 ——
用户刚加一个源，它跑到了列表最顶上，而他从没排过。

**每一个改变 `folder_id` 的写路径都必须同时写 `sort`**，统一走
`nextSortInFolder(db, userId, folderId)`。漏掉的症状是源带着**旧组的序号**
插进新组中间 —— 位置看起来随机，而且完全不可复现（取决于它在旧组排第几）。
这类 bug 在演示路径上永远不出现，只在用户真正用批量移动之后才被撞见。
五个调用点，一个都不能少：

| 路径 | 为什么会漏 |
|---|---|
| `createFeed` | 插入新行，容易只顾着 `folder_id` |
| `assignFeedsToFolder` | `POST /folders/:id/feeds` 与 `/folders/unfile/feeds` 都走它 |
| `bulkMoveToFolder` | 配置 › 订阅 的「移入…」，一次改几十条 |
| `updateFeed({folderId})` | `PATCH`/`PUT /feeds/:id`；**只在 folderId 真的变了时**才重置，改标题/间隔不该动序号 |
| `deleteFolder` | 最隐蔽的一个，见下 |

⚠️ `deleteFolder` 的 `ON DELETE SET NULL` 是 SQLite 内部执行的，**没有任何 JS
代码在里面跑**，所以被解散的源会带着原组序号（0、1、2…）落进未分组，插到
未分组已有源**中间**去。用户看到的是"删了一个组，未分组列表顺序莫名其妙变了"。
只能显式 `UPDATE ... SET folder_id = NULL, sort = ?` 一遍再删 ——
`SET NULL` 自己修不了这个问题。

⚠️ **前端对未分组源的并列项不能用 SQLite 的默认排序接手**：BINARY 比较会给出
"七 < 三 < 零"（码点序 `七 4E03 < 三 4E09 < 零 96F6`），必须保留
`localeCompare(.., 'zh-CN')` 的拼音序。m1-26 ① 抓的就是这个 ——
它不报错，只是清单看起来是乱的。

#### 15.28.8 边界条件（每条一个断言，见 `m1-27-arrange.mjs`）

- `PATCH /folders/reorder [C,A,B]` 后 `GET /folders` 就是 C,A,B
- 只提交一个 id → 它第一，其余保持原相对次序、不丢
- 提交未知 id → 4xx，且顺序**完全没变**（不是部分成功）
- `ids` 非数组 / 空数组 / 混入非字符串 → 400
- `POST /feeds/arrange` 移进某组：`folderId` 与 `sort` 都变，移出同理
- 长按满 500ms → 进入排列模式；按不满就松手 → **不进入**且照常选中
- 位移 > 8px 再松手 → 不算长按（既不进模式，也不当点击）
- 排列模式下点 ↓ → 顺序变化，且 `GET` 跟着变（不是只有 DOM 动了）
- 拖动中浮起卡片出现、落点线出现；松手后浮起卡片消失
- 跨组落位 → toast 含源名与目标组名，带「撤销」；点撤销 → 回原组
- 配置 › 分组：首行 ↑ 禁用、末行 ↓ 禁用；点 ↓ 后顺序落库
- 配置里组内源的 ↑↓ 与「移到…」生效
- **未分组源行排在所有分组行之前**（`getBoundingClientRect().top` 比较）
- 排列模式下侧栏无横向溢出，分组行高与进入前**逐行相同**（允许 1px 亚像素）

**为什么单独一个脚本而不是并进 m1-18**：m1-18 验的是"树搬迁"（chip 行有没有真删掉、
手风琴、0 源分组）。排序是另一组失败模式 —— 树完全正常、点击照常过滤，只有
"顺序提交了但没落库"或"拖完 DOM 变了刷新又回去"才会红，那两种在只看点击行为的
断言下完全隐身。

#### 15.28.9 实现时踩到的两个坑（写给下一次的自己）

1. **`check()` 的回调不能是 async**。harness 拿到 Promise 时 `Boolean(r.ok)` 恒为
   false，报出来却是"断言失败" —— 看起来像业务代码坏了，实际是写法问题。
   m1-27 初版有 15 处这么写，先 await 再在回调里断言即可。
2. **拖动测试里的坐标必须在长按之后重新量**。进入排列模式会收起手风琴，
   整棵树上移几十像素。用长按前的坐标会落到下面好几行 —— 实测症状是
   "拖到甲组却进了丙组"，而代码本身完全正确。

#### 15.28.10 我做的三个决定

1. **进入排列模式时收起全部手风琴**。展开的组行高几十像素，落点计算会漂；
   拖动时子行跟着父行走还会让整块跳。
2. **排列模式下组内源也渲染**（不受手风琴限制）。否则组内源根本没法排 ——
   而"组内源也能排"正是需求方要的。
3. **拖柄放在原来的箭头位，不让箭头兼作拖柄**。排列模式下箭头点了也没意义
   （展开/收起和排序无关），复用它会让人试一次才明白。

#### 15.28.11 触摸屏上长按会被浏览器抢走

桌面上长按一行没有副作用，所以这个问题在开发时看不出来，只能在真机上撞见，
或者把 CSS 也写进断言。手机上长按的那 500ms 里，浏览器会先动手：

| 平台 | 浏览器先做的事 | 结果 |
|---|---|---|
| iOS Safari | 弹「拷贝 / 查询」长按菜单 | 菜单盖住侧栏，排序无从开始 |
| iOS / Android | 开始选中文字，整行变蓝 | 视线被带走，`pointermove` 也被选字吃掉 |
| Android Chrome | 弹上下文菜单 | 同上 |

三条 CSS 一起加才有用，少一条都会退回上述行为：

```css
.tree-row, .tree-leaf {
  user-select: none;            /* 不让长按开始选字 */
  -webkit-user-select: none;    /* 老 iOS 只认带前缀的 */
  -webkit-touch-callout: none;  /* iOS 的长按菜单，只有这个属性管得住 */
  touch-action: pan-y;          /* 上下滚动照旧，横向意图留给拖拽 */
}
```

**范围只到侧栏树的行，不能往上提。** 正文必须能选中 —— 划词批注依赖它，
把 `user-select: none` 挂到 `.sidebar` 或 `body` 上会把阅读页一起废掉。

`touch-action: pan-y` 而不是 `none` 也是同理：`none` 会让侧栏在手机上
不能滚动，而侧栏在 1280×700 这类矮窗口里是会自滚的（§15.19 验过）。

断言拆成两条，因为**这两条各有一个读不出来的地方**：

- `user-select` 与 `touch-action` 读 `getComputedStyle` 即可；
- `-webkit-touch-callout` **读不到**：Chrome 既不把它放进 computed style，
  也会在序列化 `CSSStyleDeclaration.cssText` 时丢掉它（它不建模这个属性）。
  只能 `fetch` 样式表原文用正则找。第一版用 `cssText` 查，永远返回 false ——
  而那个 false 看起来像"CSS 没写对"，实际是查法不对。

### 15.29 AI 配置页的分层折叠（v2.2）

**需求方原话**：「AI配置界面太繁琐」。

**改之前是什么样**：整页 4 张卡全部**同时展开**，一共 6 个输入框 + 8 个按钮，
垂直高度约 1400px —— 在一个 900px 高的弹窗里要滚三屏。四张卡的顺序还是
「运行状态 → 模型连接 → API Key → 总结提示词」：

| 卡 | 输入框 | 按钮 | 什么时候真正要动 |
|---|---|---|---|
| 运行状态 | 0 | 1（刷新） | 每天看一眼 |
| 模型连接 | 4（地址 / 快模型 / 强模型 / 向量模型 / 预算） | 1（保存） | **一次**（首次配置） |
| API Key | 1 | 3（保存 / 测试 / 删除） | **一次**（首次配置），之后偶尔换 |
| 总结提示词 | 1（10 行 textarea） | 3（保存 / 填入默认 / 恢复默认） | 偶尔 |

问题不是"字段太多"，而是**三类信息混在同一屏**：日常要看的（今天花了多少、
为什么没分析）、一辈子改一次的（baseURL、三个模型名）、完全可选的
（提示词）。三者的访问频率差两个数量级，却用同样的视觉重量并排堆着。

**改法：按访问频率分三层，后面的层默认收起。**

| 层 | 内容 | 默认状态 | 判据 |
|---|---|---|---|
| **① 概览** | 运行档位 / 今日·本月花费 / 今日调用 / 已分析 | **常显** | 打开这一页 90% 的目的是看它 |
| **② 常用操作** | API Key（含测试连接）、每日预算 | **常显** | 首次配置必须能一眼看到，不能藏 |
| **③ 高级设置** | 接口地址、三个模型名 | **收起** | 部署期注入的值，改它等于换服务商 |
| **④ 提示词** | 总结提示词 | **收起** | 可选功能，多数人不动 |

**为什么把「模型连接」按字段拆开，而不是整卡折叠**：

预算（`dailyUsd`）与 baseURL 的访问频率完全不同 —— 前者是"这个月想省点钱"
会去调的东西，后者填错就换个服务商。整卡折叠会让"调预算"多两次点击，
而调预算是这一页里**唯一高频的写操作**。所以只折叠三个模型名与地址，
预算留在 ②。

**为什么 Key 卡不折叠**：它是这一页的入口功能。§8.8 的整个动机就是
"用户要能在界面上填 key"，把入口藏在折叠里等于把它变回"去改环境变量"。
折叠状态下它仍然占屏，是这个页面**唯一值得**占屏的写操作。

**折叠控件的规格**（沿用侧栏分组树的视觉语言，不新增控件形态）：

- 用原生 `<details>` / `<summary>`，不是自绘的按钮 + 条件渲染。
  理由：键盘可达、`aria-expanded` 与屏幕阅读器行为全部由浏览器免费给，
  而自绘版在 §15.28.11 已经证明"看起来对、真机上行为不对"很容易发生。
- `summary` 行高 ≥ 44px（触摸红线，§15.7 的同一标准）。
- 展开状态**不跨次记住**：每次打开都是收起的。与 §15.19 的「默认只看未读」
  同一条理由 —— "上次点开了"是一次临时查看，不是长期偏好；而把它持久化
  会让下次进来又是一屏展开的样子，与本节的目的相反。
- 折叠标题右侧显示**当前值的摘要**（`deepseek-chat`、`已配置 sk-…c3f9`），
  这样收起时也知道里面是什么，不必点开确认。

**为什么不是「向导式分步」（把配置拆成 3 步）**：向导适合"首次必须走完"，
而这一页在首次之后会被反复打开看用量。分步会把"看一眼今天花了多少"
变成"点三次下一步"。折叠是**可逆**的信息分层，向导是**阻塞**的流程。

**为什么不是「删掉模型名输入框」**：那是 §8.7 三层配置的唯一用户入口。
删掉它，用户换模型就只能改环境变量 —— 而 NAS 用户（本项目的首要场景）
改环境变量要重启容器，那正是 §8.8 想免掉的成本。

**保留的既有约束不变**：空输入框 = 不修改（§8.7 的"空值不打回默认"）、
key 只回显掩码、提示词按指纹缓存。折叠只改**呈现顺序与默认可见性**，
不改任何字段语义。

**验收**：`m2-08-ai-settings.mjs`。至少包括 —— ① 默认打开时 ③④ 两个
`<details>` 是收起的、①② 可见；② 点开 ③ 后三个模型名输入框出现，
再点一次收起；③ 折叠摘要行显示当前模型名与掩码；④ `summary` 行高 ≥ 44px；
⑤ 折叠状态下整页高度比改前减少 ≥ 400px（用同一视口量 `scrollHeight`，
阈值写死，防止"加了折叠但没省出空间"这种假达标）；⑥ 预算输入框在
收起状态下**仍可修改**（它是 ②，不能在折叠区里）；⑦ 折叠不丢输入
（在预算框输入后展开再收起，值还在）。


---


## 十六、CI 与发布

### 16.1 三个 workflow

| Workflow | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push / PR | 类型检查、单测、lint、构建验证、残留检查 |
| `release.yml` | tag `v*` | 二进制 + Docker 镜像 + 校验和 + Release |
| `nightly.yml` | 每日 cron | 拉真实 RSSHub 路由库做集成回归，发现上游变更 |

**CI 与本地用同一套工具链**：三个 workflow 都不装系统 Node，而是 `./scripts/bootstrap.sh` 后直接用 `.toolchain/node/bin/npm`。这样「本地能过、CI 挂掉」这类环境差异不存在，也让 §4.5 的残留检查在 CI 里天然可跑。

唯一例外是 `binaries` job 需要**目标平台**的 node 可执行体（Windows 产物在 Linux runner 上造），所以它额外下载一份放到 `vendor-*`，这份不参与运行，只作为 SEA 的注入底本。

### 16.2 `release.yml`

```yaml
name: Release
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write
  packages: write

env:
  # 与 bootstrap 的默认值保持同一处来源，改版本只改这里和 scripts/lib
  CHENG_RSS_NODE_VERSION: v24.13.0

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # CI 也用项目内工具链：本地与 CI 走完全相同的解释器，避免「本地过 CI 挂」
      - name: 引导项目内 Node
        run: ./scripts/bootstrap.sh
      - name: 依赖（缓存落在项目内 .cache/npm）
        run: .toolchain/node/bin/npm ci
      - run: .toolchain/node/bin/npm run typecheck
      - run: .toolchain/node/bin/npm run lint
      - run: .toolchain/node/bin/npm test
      - run: .toolchain/node/bin/npm run build:client   # Vite → dist/client
      - name: 残留检查（构建不写 $HOME）
        run: ./scripts/check-no-residue.sh
      - uses: actions/upload-artifact@v4
        with: { name: client-dist, path: dist/client }

  binaries:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: linux-x64
            node_os: linux
            node_arch: x64
          - target: windows-x64
            node_os: win
            node_arch: x64
    steps:
      - uses: actions/checkout@v4
      - name: 引导项目内 Node
        run: ./scripts/bootstrap.sh
      - run: .toolchain/node/bin/npm ci
      - uses: actions/download-artifact@v4
        with: { name: client-dist, path: dist/client }
      - name: 构建标准 bundle
        run: .toolchain/node/bin/npm run build:server
      - name: 打包前端 zip（SEA assets 用，见 §3.4）
        run: .toolchain/node/bin/npm run pack:client-zip
      - name: 取得目标平台的 node 可执行体
        id: nodebin
        shell: bash
        run: |
          # 版本号来自 job 级 env，不依赖 runner 上装了什么
          VER="${{ env.CHENG_RSS_NODE_VERSION }}"
          case "${{ matrix.node_os }}" in
            win)  PKG="node-$VER-win-x64.zip";          BIN="node.exe" ;;
            *)    PKG="node-$VER-linux-x64.tar.xz";     BIN="node" ;;
          esac
          mkdir -p .tmp && cd .tmp
          curl -fsSLo pkg "https://nodejs.org/dist/$VER/$PKG"
          case "$PKG" in
            *.zip)      unzip -q pkg -d raw ;;
            *.tar.xz)   mkdir -p raw && tar -xJf pkg -C raw ;;
          esac
          SRC="$(find raw -maxdepth 2 -name "$BIN" -type f | head -1)"
          cp "$SRC" "../vendor-$BIN"
          echo "bin=vendor-$BIN" >> "$GITHUB_OUTPUT"
      - name: 生成 SEA
        run: |
          # Node 25.5+ 可用一条 node --build-sea；Node 24 用 postject 三步
          .toolchain/node/bin/node scripts/build-sea.mjs \
            --main dist/server.js \
            --executable "${{ steps.nodebin.outputs.bin }}" \
            --out dist/cheng-rss-${{ matrix.target }}
      - name: 冒烟测试（linux）
        if: matrix.target == 'linux-x64'
        run: |
          chmod +x dist/cheng-rss-linux-x64
          ./dist/cheng-rss-linux-x64 version
          ./dist/cheng-rss-linux-x64 migrate --data .tmp/t
          ./dist/cheng-rss-linux-x64 serve --data .tmp/t --port 3111 &
          sleep 3
          curl -fsS localhost:3111/api/health
          curl -fsS localhost:3111/ | grep -q 'id="root"'   # 静态资源内嵌校验
          ./dist/cheng-rss-linux-x64 doctor --data .tmp/t
      - uses: actions/upload-artifact@v4
        with: { name: bin-${{ matrix.target }}, path: "dist/cheng-rss-${{ matrix.target }}*" }

  docker:
    needs: [build, binaries]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest
      - uses: actions/download-artifact@v4
        with: { pattern: "bin-*", path: dist, merge-multiple: true }
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### 16.3 Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
# 依赖层单独缓存；.npmrc 里的 cache 路径在容器内指向 /app/.cache
COPY package*.json .npmrc ./
RUN --mount=type=cache,target=/app/.cache/npm \
    npm ci --cache /app/.cache/npm
COPY . .
# 构建期临时文件也关在容器内
ENV TMPDIR=/app/.tmp TMP=/app/.tmp TEMP=/app/.tmp
RUN --mount=type=cache,target=/app/.cache/npm \
    npm run build:client && npm run build:server && npm run build:sea

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist/cheng-rss-linux-x64 /app/cheng-rss
ENV DATA_DIR=/app/data PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD ["/app/cheng-rss", "doctor", "--quiet"]
ENTRYPOINT ["/app/cheng-rss"]
CMD ["serve"]
```

构建期缓存用 BuildKit 的 `--mount=type=cache`（缓存落在构建机 Docker 自己的区域，且不会进入最终镜像层），**不要**把 `npm ci` 的中间产物 COPY 进任何层 —— 那个会让镜像凭空多 300MB。

### 16.4 六条发布门禁

| 门禁 | 检查 | 拦住的问题 |
|---|---|---|
| 二进制冒烟 | 编译后启动 → 访问首页 → 建库 → doctor | 源码能跑、二进制跑不起来 |
| 静态资源内嵌 | `curl /` 返回含 `id="root"` 的 HTML | 二进制启动但页面 404 |
| 迁移幂等 | 空目录 migrate 两次不报错 | 重复执行迁移崩库 |
| Docker healthcheck | 容器起来后变 healthy | 镜像能起但服务不可用 |
| **导出/导入往返** | 导出 → 新容器导入 → 条目数一致 | 备份不可用 |
| **项目外零写入** | 干净容器里跑 `bootstrap` + `build`，`$HOME` 与系统目录无新增 | 污染用户机器，卸载留垃圾 |

倒数第二条经常被跳过，但它是「存档迁移备份」需求的**实际验收** —— 没有 CI 验证，备份坏了会在真需要时才发现。最后一条是 §4.3 承诺的验收，脚本见 §4.5。

---

## 十七、项目结构

> 这一节按**实际落地**的结构写（v2.2 校正）。此前它描述的是规划态 ——
> `services/`、`packages/prompts/`、`middleware/` 等目录从未创建，
> 而真实模块按业务域分（`feeds/` `extract/` `dedupe/` `ai/` `cluster/` `digest/`）。
> 规划态的结构图留在 git 历史里，不再维护。

```
cheng-rss/
├─ .toolchain/node/               # 项目内 Node 24 + npm（bootstrap 下载，gitignored）
├─ .cache/{npm,docker}/           # npm 与 docker 构建缓存（gitignored）
├─ .tmp/                          # 临时文件（gitignored，§19.10c）
├─ .npmrc                         # cache=./.cache/npm（prefix 不能写，见 §4.3）
├─ README.md                      # 面向使用者：快速开始 / 配置 / 成本 / 已知限制
├─ PLAN.md                        # 本文档：规格与决策记录
├─ LICENSE                        # MIT
├─ docs/
│  ├─ configuration.md            # 全部配置项、AI 提供方、预算、排查
│  ├─ architecture.md             # 模块划分、数据流、选型与放弃的方案
│  ├─ design.md                   # 界面规格、正文提取、去重、聚类、引用安全
│  ├─ development.md              # 本地开发、验收机制、写断言的规矩
│  ├─ 界面设计方案.md               # 视觉规格（配色/密度/控件尺度）
│  ├─ 分组排序方案.md               # 1.27 的两个入口与长按判定
│  └─ mockups/                    # 静态草图与截图（可直接在浏览器打开）
├─ scripts/
│  ├─ bootstrap.{sh,ps1}          # 下载并解压 .toolchain/node
│  ├─ dev.{sh,ps1}  build.{sh,ps1}
│  ├─ build-client.mjs            # Vite 构建前端
│  ├─ build-server.mjs            # esbuild → dist/server.cjs（内嵌 .sql）
│  ├─ build-sea.mjs               # bundle + postject → 单文件二进制
│  ├─ pack-client-zip.mjs         # dist/client → dist/client.zip
│  ├─ verify-all.mjs              # 验收总入口（55 个脚本）
│  ├─ clean-tmp.mjs               # 清 .tmp/verify
│  ├─ check-no-residue.mjs        # 确认没留临时文件
│  ├─ lib/{proc,tmp,cdp}.mjs      # 子进程收尾 / 临时目录 / 无头浏览器
│  └─ verify/                     # 每步一个验收脚本 + harness.mjs
├─ src/
│  ├─ index.ts                    # 入口：serve|worker|migrate|doctor|version|mcp|export|import
│  ├─ cli.ts                      # 子命令实现（mcp/export/import 尚未落地）
│  ├─ server/
│  │  ├─ app.ts                   # 组装 AppContext（cfg + db + 版本）
│  │  ├─ config.ts                # 三层配置解析
│  │  ├─ errors.ts  logger.ts     # 错误类型 / 模板限速日志
│  │  ├─ static.ts                # 静态资源（SEA 内嵌 zip → fflate 解压）
│  │  ├─ routes/                  # 7 个路由组
│  │  │   {auth,feeds,entries,digests,highlights,rsshub,settings}.ts
│  │  ├─ feeds/                   # RSS/Atom/RDF 解析、OPML、自动发现、抓取
│  │  ├─ extract/                 # 正文提取（Readability + linkedom）
│  │  ├─ dedupe/                  # URL 规范化 / SimHash / 余弦向量
│  │  ├─ ai/                      # client / service / prompt / schema / usage / budget
│  │  ├─ cluster/                 # 事件聚类 + 逐簇归约
│  │  ├─ digest/                  # 简报：run / index / schedule / render / md-parse
│  │  ├─ search/                  # FTS5 + 程序侧 bigram
│  │  ├─ highlights/              # 划词高亮（三选择器降级）+ 简报联动
│  │  ├─ entries/history.ts       # 阅读历史的时间分桶
│  │  ├─ jobs/                    # 队列 + 内联 runner + handlers
│  │  ├─ auth/                    # session / require-user
│  │  └─ db/                      # client / schema / migrate / migration-sql / text-blob
│  └─ client/                     # React 19（无路由库，useReducer 管视图）
│     ├─ App.tsx                  # 三栏 + 视图状态
│     ├─ feeds.css mobile.css     # 样式（手写，非 Tailwind）
│     ├─ settings/                # 配置中心各分类
│     ├─ digest/                  # 简报页 + markdown 渲染
│     ├─ highlights/  summary/    # 高亮与单篇总结
│     └─ api.ts  arrange.ts  icons.tsx
├─ Dockerfile
├─ docker-compose.yml
├─ .github/workflows/ci.yml
├─ tests/fixtures/                # HTML 快照、AI 响应样本
└─ data/                          # 唯一状态：app.db, secrets.json, config.json, files/, backups/
```

`.gitignore` 关键项（决定「删目录即卸载」能否成立）：

```gitignore
.toolchain/
.cache/
.tmp/
node_modules/
dist/
data/
*.log
```

**只有 `data/` 需要备份**，其余全部可重建。

**文档分工**（v2.2 建立）：README 面向使用者，只留"怎么用"；`docs/` 四份按主题
分（配置/架构/设计/开发）；PLAN 保留规格与决策记录。三者的关系是
**README 不重复 PLAN 的取舍理由，PLAN 不重复 README 的操作步骤**。

---

## 十八、API

```
# 订阅
GET    /feeds?folderId=          列表（未读数、健康度、分组）
POST   /feeds                    {url} → 自动发现 feed
PUT    /feeds/:id                编辑：标题 / 分组 / 抓取间隔
PATCH  /feeds/:id                间隔/文件夹/分析档位/状态
DELETE /feeds/:id
POST   /feeds/import  GET /feeds/export        OPML（含分组）

# 订阅批量操作（§15.10：一次事务，不是前端循环）
POST   /feeds/bulk/folder        {feedIds, folderId}  移到分组；folderId=null 即移出
POST   /feeds/bulk/status        {feedIds, status}    active | paused
POST   /feeds/bulk/delete        {feedIds}            删源，已读/已收藏条目保留
POST   /feeds/bulk/refresh       {feedIds}            入抓取队列（暂停的跳过）

# 分组（folders 一层扁平结构）
GET    /folders                  列表（含 feedCount / unread）
POST   /folders                  {name}
PATCH  /folders/:id              {name}
DELETE /folders/:id              组内订阅退回未分组，不删源
POST   /folders/:id/feeds        {feedIds} 批量移入
POST   /folders/unfile/feeds     {feedIds} 批量移出（注意：必须注册在 :id 之前）

# RSSHub 搜索
GET    /rsshub/search?q=&type=keyword|url
POST   /rsshub/preview           {route, params} → 最近 5 条
POST   /rsshub/refresh           刷新路由库

# 条目
GET    /entries                  ?feedId=&folderId=&view=&q=&tier=&since=&cursor=
                                 （§15.13：feedId 与 folderId 可叠加，即"某组里某个源"）
GET    /entries/:id              含正文 + AI 分析 + feedSiteUrl/feedTitle（§15.11 双出口）
POST   /entries/read             {ids:[], progress?}
POST   /entries/unread           {ids:[]}            已读回退（§15.11）
POST   /entries/:id/progress     {progress: 0~1}     阅读进度滚动上报（节流 1 次/2s）
POST   /entries/:id/analyze      手动重跑

# 高亮
GET    /entries/:id/highlights
POST   /highlights  PATCH /highlights/:id  DELETE /highlights/:id
GET    /highlights?cursor=&entryId=&tag=
POST   /highlights/:id/insight   SSE

# 聚合
GET    /clusters                 ?window=24h&minHeat=
GET    /clusters/:id             含 consensus/conflicts
GET    /digests  GET /digests/:id  POST /digests

# 检索 / 问答
GET    /search?q=&mode=keyword|semantic|hybrid
POST   /chat                     SSE，带 citations

# 系统
GET    /stats                    用量/成本/队列深度/失败条目/源健康
GET    /settings  PATCH /settings
POST   /settings/test-ai
POST   /backup  GET /backup/list
POST   /export  POST /import
```

错误体统一 `{ error: { code, message, retryable } }`。所有 handler 经 `requireUser()` 取 `userId` —— 预留多人的单点开关。

---

## 十九、分步实施与逐步自验证

本章是**落地执行清单**。原则：**每一步结束都能自己判定通过/失败，不依赖"感觉差不多了"**。

### 19.1 验证机制的基准

每一步配一个 `verify` 脚本（`scripts/verify/<step>.mjs`），也可用 `cheng-rss verify <step>` 调起。它**只做断言、不做修复**，输出：

```
PASS  m0-01-toolchain   4 项断言
FAIL  m0-02-schema      schema_migrations 应为 1 行，实际 0
```

三条硬规则：

| 规则 | 原因 |
|---|---|
| 每步必须**先失败再通过** —— 实现前跑一次确认它真能报红 | 否则可能是个永远绿的假断言 |
| 断言检查**产物**（库里有什么、HTTP 返回什么），不检查"代码里有没有某函数" | 后者改了名字就失真 |
| 每步独立可重跑，不依赖前面步骤的残留状态 | 有残留的验收会掩盖问题 |

**第四条约束针对脚本本身**：`scripts/verify/` 下的每个断言都必须能追溯到本文档的某一节。脚本不放宽阈值的理由见附录 A.5 —— 改阈值要比改实现更慎重，因为前者会让所有指标一起失真。

本文档的每一章都对应可执行的验收：§1.1 的需求表列出「规格章节 / 实施步骤 / 验收脚本」三列，任一需求都能顺着它查到具体是哪个脚本在验证。**查不到验收脚本的需求，等于没有验收标准**，不允许进入实现。

**验收脚本统一用 `.mjs`**，跨平台不需要 `.sh`/`.ps1` 两份。Node 24 能直接执行 `.ts`，但脚本保持 `.mjs`，避免与业务代码的类型依赖纠缠：

```bash
./.toolchain/node/bin/node scripts/verify/m0-02-schema.mjs
```

这是 §4.3 把 Node 放进项目内的额外收益：**验收脚本不再受平台脚本差异困扰**。

### 19.2 M0：骨架（5~6 天，拆成 10 步）

| # | 步骤 | 产出 | 自验证命令 | 通过判据 |
|---|---|---|---|---|
| 0.1 | 项目内工具链 | `.toolchain/node`、`.npmrc`、`.gitignore`、`scripts/bootstrap.{sh,ps1}` | `m0-01-toolchain.mjs` | ① `node -v` = v24.13.0 ② `npm config get cache` 在项目内 ③ 构建前后 `$HOME` 文件数不变 |
| 0.2 | 表结构与迁移 | `schema.ts`、`migrations/0001_init.sql`、`migrate.ts` | `m0-02-schema.mjs` | ① 19 张业务表逐一点名存在（不数数量，FTS5 的 shadow 表会干扰计数）② 再跑一次不报错且 `schema_migrations` 行数 = 迁移清单长度（**不写死 1**：后续每加一个迁移都会让它假红）③ `integrity_check` = ok ④ `entries_fts` 可 `MATCH` |
| 0.3 | 数据库访问层 | `db/client.ts`、`adapter.ts` | `m0-03-db.mjs` | ① WAL 生效 ② `busy_timeout`=5000 ③ 写 1 万条 < 3s ④ 两进程并发写不报 `SQLITE_BUSY` |
| 0.4 | HTTP 骨架 | `src/index.ts`、`app.ts`、子命令 | `m0-04-server.mjs` | ① `version`/`doctor` 有输出 ② `/api/health` 200 ③ 未登录访问 `/api/v1/feeds` 返回 401 |
| 0.5 | 认证 | cookie session + Bearer 双认 | `m0-05-auth.mjs` | ① 登录返回 `Set-Cookie`（`SameSite=Lax`、`Path=/`）② 带 cookie 200 ③ 带 Bearer 200 ④ `loginUserInfo` 未登录返回 **200** 而非 401 |
| 0.6 | Job runner | `jobs/runner.ts` | `m0-06-jobs.mjs` | ① 入队 100 → 全 `done` ② 同 `dedupe_key` 只留 1 条 ③ handler 抛错 → `attempts=3` 后 `dead` ④ 杀进程重启后 `running` 重置为 `pending` |
| 0.7 | 检索层 | `entries_fts`、bigram 双端切分 | `m0-07-search.mjs` | ① 10 万条下 `"芯片"` 有结果（**2 字词必须能查**）② 无命中 < 5ms ③ `"半导X体"` **不**误命中 `"半导体"` ④ 时间线 < 5ms、未读数 < 3ms |
| 0.8 | 三路构建 | `build-sea.mjs`、`pack-client-zip.mjs`、Dockerfile | `m0-08-deploy.mjs` | ① 二进制启动首页 200 且含 `id="root"` ② 同一 `data/` 在源码/二进制/Docker 间互换启动 ③ 插件 3 端点在 Docker 里也通 ④ `$HOME` 零写入 |
| 0.9 | 界面（v1.1 新增，v1.14 改正文宽度判据） | 三栏布局、`icons.tsx`、`styles.css` | `m0-09-ui.mjs` | ① 三栏并存且不重叠 ② 列表项 70~130px、一屏 8~10 条 ③ 正文列宽 = 偏好字符数（默认 80ch，实测；断言从 `--reader-width` 读出，不写死）且 1440 屏下两侧留白 40~90px ④ 默认暗色 ⑤ 空态有引导 ⑥ `/` `Esc` `j` 键盘可用 ⑦ 窄屏阅读区浮层化 |
| 0.10 | 资源与性能预算（v2.0 新增） | 日志模板级速率限制、空闲基线采样 | `m0-10-resources.mjs` | ① 空闲 60s：RSS ≤ 130 MB、CPU 均值 ≤ 1.5%、stderr ≤ 20 行/分钟 ② 空闲日志里**没有**逐条重复的同一模板（同一模板 ≤ 3 行 60s）③ 前端产物 gz：JS ≤ 120 KB、CSS ≤ 15 KB、二进制 ≤ 100 MB ④ **空闲不增长**：90s 内 15s 一采，峰值 ≤ 130 MB、峰谷差 ≤ 25 MB、末值 ≤ 峰值（不写"单窗口增量"，因为实测稳态是 V8 锯齿）⑤ 队列空时 `jobs` 表 6s 内不增长、无滞留 pending/running；打完 20 次请求 RSS 仍 ≤ 130 MB ⑥ **P4 限速器**（9 条）：同一模板连灌 20 次只放 3 行、折叠 17 条记在账上、`takeSuppressed` 是取走语义、20 个不同模板全放、窗口内第 4 次折叠、过窗口配额重置、模板归一只动数字（745 篇 ≡ 3 篇）、归一只动数字**不动引号内容**（no-key ≠ http-500）、模板表有上限（灌 1000 个模板后最早被逐出）⑦ **走真实出口再验**（4 条）：经 `log.info` 灌 20 条同一模板只写出 ≤3 行、20 个**字母**模板 20 行全出（名字里带数字会被归一成同一模板 —— 第一版就红在这，红在一个正确行为上）、同窗口 10 条只出 3 行、跨窗口第一行带「另有 7 条同类已折叠」且那行不占配额 ⑧ **临时文件落在项目内**（8 条，§19.10c）：`useProjectTmp()` 后 `os.tmpdir()` 指向 `.tmp/verify`、目录真的建出来、`mkdtempSync` 落在项目内、路径不再含 `/AppData/`、`dirSize` 读出非零体积、`cleanTmp` 删得掉并报出释放量、不越界删掉 `.tmp/linuxnode` 缓存 |

**M0 门禁**：`scripts/verify-all.mjs` 依次跑完 11 项（0.1~0.10 + `docker-path`）、全绿才进 M1。任何一项红都不能跳过 —— 这些是地基，跳过会在 M2 以后以「奇怪 bug」的形式回来。

判据是**累积**的：跑到 0.5 时，0.1~0.5 五项过了就算这一步完成，0.6~0.9 仍应报红（它们还没实现）。这正是「先失败再通过」的意义：**每次新增一步，只应让对应的那项从红转绿，其余项状态不变**。如果 0.6 实现完 0.3 反而红了，说明引入了回归。

**0.9 的定位**：它是唯一一项**用真实浏览器验"看起来对不对"**的验收。为什么必须有它：0.1~0.8 全是行为断言（状态码、字节数、耗时），一个布局错乱、正文只有 66 字符宽、或者点开条目就跳页的界面能让 9/9 全绿。这正是实际情况 —— 补上 0.9 之后立刻抓到两个真问题（列表 148px 一屏只 4 条、72ch 实测 582px）。

没有 Chromium 系浏览器的机器上 0.9 整节 SKIP（退出 0），不算失败 —— 环境缺失不是实现问题。但它 SKIP 时必须在汇总里看得见，不能静默通过。

### 19.3 M1：阅读 + RSSHub（3.5~4 周，26 步）

| # | 步骤 | 自验证 | 通过判据 |
|---|---|---|---|
| 1.1 | Feed 解析（RSS2.0 / Atom / RDF） | `m1-01-feed-parse.mjs` | ① 三种格式都能解出条目 ② `content:encoded` 优先于 `description` ③ 坏日期不产生 NaN ④ 相对链接按 base 补全 ⑤ HTML 网页被拒且原因可读 |
| 1.2 | OPML 导入导出 | `m1-02-opml.mjs` | ① 文件夹层级保留 ② 导出再导入源数一致 ③ 属性名大小写容错 ④ 非 OPML 文件抛错而非静默成功 |
| 1.3 | 正文清洗（安全边界） | `m1-03-sanitize.mjs` | ① `script`/`iframe`/`svg` 连同内容删除 ② `onerror`/`onclick` 属性删除 ③ `javascript:` 与 `data:text/html` 拦截 ④ 排版标签全保留 |
| 1.4 | 订阅 CRUD + 自动发现 + 抓取 | `m1-04-feeds.mjs` | ① 贴首页能发现 feed ② 重复订阅幂等 ③ 条件请求 304 不重复入库 ④ 404 三次后 `broken` ⑤ 取消订阅保留已读/已收藏 |
| 1.5 | 移动端 | `m1-05-mobile.mjs` | ① 侧栏换底部 tab bar ② 触摸目标 ≥44px ③ 输入框字号 ≥16px ④ 安全区 padding ⑤ 无横向溢出 ⑥ 横屏不出现侧栏 |
| 1.6 | 订阅页界面 | `m1-06-feeds-ui.mjs` | ① 30+ 源行高一致 ② 长标题单行截断且徽标保留 ③ 操作按钮不越界 ④ 头部吸顶 ⑤ 手机上刷新/暂停/删除都可点 |
| 1.7 | 订阅分组与编辑 | `m1-07-folders.mjs` | ① 建/改名/删分组，重名拒绝 ② 按组过滤准确 ③ 删分组后订阅退回未分组且不丢条目 ④ 编辑标题/分组/间隔生效 ⑤ OPML 往返保留分组 |
| 1.8 | 订阅一键批量管理 | `m1-08-bulk.mjs` | ① 四个批量端点各自生效且一次事务 ② 空 `feedIds` → 400 ③ 混入不存在的 id → 其余照做并计 `skipped` ④ 批量删除保留已读/已收藏 ⑤ 批量刷新跳过暂停的源 ⑥ 前端全选/组选/清空后计数与按钮 disabled 一致 |
| 1.9 | 阅读页交互（v1.7） | `m1-09-reader.mjs` | ① 正文非锚点链接全部 `target="_blank"`，`#锚点` 不加 ② 点正文链接主框架 URL 不变 ③ 列表标题是真 `<a>`，中键可新标签开 ④ `role=button` + `tabindex=0` + Enter 可开 ⑤ 详情返回 `feedSiteUrl`，阅读栏源站可点 ⑥ `POST /entries/unread` 把已读改回未读 ⑦ `o`/`v`/`m`/`t` 生效且输入框内全部失效 ⑧ 字号/宽度/主题刷新后保持 |
| 1.10 | 控件形状尺度（v1.8） | `m1-10-ui-scale.mjs` | ① 所有可见按钮圆角落在 `{0,4,7,999}` 四档（`.seg` 内允许 5）② 同一 class 的按钮高度唯一 ③ `<24px` 的非分段控件圆角必须是 4px ④ chip 是 999px 真胶囊 ⑤ 「只看分组·清除」不再是实心大块（无背景、无边框、高度 < 28px，且是图标不是长文案）⑥ 采样覆盖面自检，防四条断言空转 |
| 1.11 | 分组内查看订阅源（v1.8） | `m1-11-folder-feeds.mjs` | ① 选中分组后列出组内全部源（含未读数，0 也显示）② 点源过滤到该源、标题带组名+源名 ③ 再点取消回整组 ④ 组内 1 个源时不显示筛选行 ⑤ 换组/换固定视图时源筛选清空 ⑥ 筛选的源被移出组后自动退回整组，**且分组保留** ⑦ 源筛选与搜索叠加生效 ⑧ 标题旁「N 条」是命中总数：组内 45 条 > 一页 30 时仍显示 45 |
| 1.12 | 收件箱阅读控制（v1.9，v1.16 默认值改未读） | `m1-12-inbox-view.mjs` | ① 标题行右侧有「全部/未读」分段控件，点「未读」后列表只剩未读 ② 点「全部」回到全量且**已读条目仍在**（只是变灰）③ 刷新按钮点击后重新请求且保留 view/分组/源/搜索 ④ 刷新期间列表条数不归零（`items.length` 不出现中途 0）⑤ 侧栏「未读」与分段控件同一份状态（点一处另一处同步，不会两处高亮不同）⑥ 已收藏行只有一颗星（`star-mark` 已删除，星星就是那个可点按钮）⑦ 375px 视口下标题行无横向溢出 |
| 1.13 | 配置中心（v1.9，v1.13 删除侧栏入口） | `m1-13-settings.mjs` | ⓪ 侧栏 `.nav-section` 里不再有「订阅源」标题、不再有任何含「订阅」的按钮，配置入口只剩齿轮 1 个（v1.13：需求「删除主页的订阅源按钮」）① 侧栏齿轮打开配置弹窗并停在订阅分类（不再切独立页）② 六个分类都在，M2/M3/M6 三个标「待接入」且点开有 ≥3 条清单 ③ 分类切换不重挂：**先在添加面板写入半截 URL**，切走再切回值还在 ④ 遮罩挡住背后点击（`elementFromPoint` 落在弹窗内）⑤ `Esc` 能关且 DOM 真的移除；重开不记住上次分类（关窗前先切到分组做前置）⑥ 分组筛选：`folders>=3` 用 `<select>`、`<=2` 用 chip，删一个组掉到 2 时自动换回 chip ⑦ 下拉选「未分组」只显示 `folderId` 为 null 的源，选回「全部」5 个源都回来 ⑧ 分组页能改名、删组有确认框且说明"订阅退回未分组"，删完订阅页源数不变、未分组 +1 ⑨ 关闭弹窗后侧栏分组列表同步（改名生效、删掉的消失）⑩ 手机上弹窗铺满视口、分类栏横向可滚、分类项 ≥36px、无横向溢出；底部导航最后一格是「配置」且能打开弹窗 |
| 1.14 | 正文提取（Readability 兜底） | `m1-14-extract.mjs` | ① 5 个真实站点（离线夹具）提出正文 ≥ 参照容器 60%，且不含 `script`/`onerror` ② 提取失败（404 / 非 HTML）回退 feed 内 HTML，**条目仍在且不卡 pending** ③ 触发条件生效：feed 正文 ≥ 500 字时**一次网络请求都不发**，且**不排进 extract 队列** ④ 提出内容不到 `max(500, feed×1.2)` 时不替换（认错节点时保留可读内容）⑤ 落库字段齐：`extracted_by`/`stage`/`stage_error`/`word_count` ⑥ 没有 `<body>` 的页面不抛异常且能提出正文 ⑦ 重复入队不重复抓、不覆盖已有结果 ⑧ 20 条短摘要并发提取全部 `extracted`，成功率 100% |
| 1.15 | 去重（向量层） | `m1-15-dedupe.mjs` | ① 同 URL 不同 utm 参数判重（含 fbclid/gclid/spm/ref/share_*，且 `?p=`/`?id=` 等语义参数保留、不同文章不被误合并）② 余弦 >0.95 判重：逐字相同 + 四种转载变体（标题加站名 / 加版权声明 / 加导语 / 改开头一句）全部命中，不同事件余弦 <0.3 ③ 混入 20 条重复后重复率 <1%（3000 条基数）④ 三层短路：URL 命中不再算向量、不重复写库 ⑤ 重复条目不进时间线、`duplicate_of` 指回原件、`includeDuplicates=1` 可查 ⑥ 向量维度 256 / 字节 = dim×4 / model=`local-hash-v1`，坏 BLOB 不抛 ⑦ 提取到全文后向量随之更新（否则摘要型源永远漏判）⑧ 超短正文不写向量 |
| 1.16 | 列表/阅读/历史 API | `m1-16-ui-api.mjs` | ① 游标分页不重复不漏（250 条含 120 条**同一毫秒**，按 id 打破平局；游标只按第一个下划线切，否则 `e_1a2b…` 被截成 `'e'`，同毫秒整批跳过）② `POST /read` 两次 → `read_count=2`，且 `first_read_at` 不被覆盖、`last_read_at` 前进；标未读不清阅读历史 ③ 历史按**本地日历日**分四桶（今天/昨天/本周/更早），边界值 00:00:00 与 23:59:59 逐个断言；跨月跨年不误判；`groupByDay` 跳过空桶 ④ `total` 用不含游标的条件算（翻页时不缩小）⑤ 界面：分组标题渲染且有粘性、行内时间是 `readAt` 而非 `publishedAt`（数据里两者刻意差 5 天）、`read_count>1` 才有 ×N 角标 ⑥ 畸形游标/负数 limit 不 500、超大 limit 夹到 100 |
| 1.17 | RSSHub 搜索 | `m1-17-rsshub.mjs` | ① 关键词搜到路由：中文按 namespace 中文名（「哔哩哔哩」）、英文按 namespace（zhihu）、按路径（hotlist）都能命中；搜不到返回空数组而非 500 ② URL 反查命中且命名空间与域名匹配（不是把整段 URL 当关键词搜）、未知域名返回空 ③ 试订阅预览 ≥1 条且 ≤5 条、内容带路径指纹（证明请求真的发到了拼出的地址）、返回完整可订阅地址、404 路径给明确错误 ④ 断网后关键词与 URL 反查都仍可用，且结果与联网**完全一致**（缓存被真的用上）；缓存 7 天后标 `stale` 但仍可搜；两个上游一半过期也报 stale（`fetchedAt` 取较早那个）⑤ 闭环：预览地址能直接订阅成功、落库 URL 一致 ⑥ 界面：面板挂在「添加订阅」里、关键词列出候选、选中后按模板生成参数输入框（`:uid` → uid 输入框、用 example 预填）、**没预览不出现「订阅这个地址」**、预览后出现条目+订阅+外链 |
| 1.18 | 侧栏分组树（v1.13） | `m1-18-sidebar-tree.mjs` | ① 侧栏每个分组行可展开，展开后列出组内全部源并显示各自未读数 ② 组内 11 个源时列表头部**没有任何筛选行**（chip 行已删除），列表一屏条数与无分组时相同 ③ 点组内某个源 → 列表只剩该源条目、标题为「组名 · 源名」、只有该子行高亮 ④ 再点同一子行 → 回整组，组行高亮 ⑤ 点另一个组 → 前一个组收起、新组自动展开、源筛选清空 ⑥ 组内 1 个源仍可展开；组内 0 个源不渲染子节点 ⑦ 点固定视图（收件箱/未读/收藏/历史）→ 分组与源筛选清空且树全部收起 ⑧ 源被移出组 → 自动退回整组且分组保留（沿用 1.11 ⑥）⑨ 源筛选 + 搜索叠加生效 ⑩ 树自身滚动，不把侧栏撑破（700px 高的视口下收件箱仍可点到） |
| 1.19 | 三栏密度收敛（v1.13，v1.14 改②③） | `m1-19-density.mjs` | ① 1440px 下侧栏 196px、列表 368px、阅读区 ≥870px（三个数各自断言，不是"变小了"）② 正文列宽 = 偏好字符数的实测值（默认 80ch，从 `--reader-width` 读，不写死）且两侧留白 40~90px ③ 1180px 下正文列宽 ≥ 594px ④ 组内有源时列表头部高度与无分组时**完全相等**（chip 行不占位）⑤ 侧栏最长分组名能完整显示或走省略号，不压在角标上 ⑥ 1440×960 下首屏条目数 ≥ 9 ⑦ 手机上 `--sidebar-w` 仍是 0、底部 tab bar 仍在（收窄不许把移动端规则带歪） |
| 1.20 | 阅读区边缘与侧边目录（v1.15） | `m1-20-reader-toc.mjs` | ① 正文列有可见边缘：与阅读区背景色**不同**、有圆角（14px）、有阴影；纸宽度随 `--reader-width` 变（调到 64ch 时纸也变窄，不是固定像素）；三个阅读主题（light/dark/sepia）下边缘都成立，且标题与正文同色（防止"深底深字"）② 1440 面板宽下**目录不渲染**，正文列宽与无目录时完全相同（目录不许挤压正文）③ 1600 面板宽下目录渲染，条目数 = 正文 h2+h3 数，每个标题都补了 id，且正文列宽仍是偏好字符数 ④ 文章无小标题 / 只有 1 个 → 目录不渲染（不是渲染成空栏）⑤ 点目录项后目标标题进入视口（`top` 落在 -10~120px），主框架 URL 不变 ⑥ 滚动正文后对应目录项高亮（`aria-current`），且同时只有一项 ⑦ 长目录项走省略号且 `title` 给全文 ⑧ 375px 下纸取消圆角与阴影、铺满全宽 |
| 1.21 | 默认只看未读（v1.16） | `m1-21-default-unread.mjs` | ① 首次进入（无任何本地状态）分段控件「未读」激活、「全部」不激活，且列表里**没有已读条目** ② 侧栏「未读」同样高亮（两处状态一致，不许一边亮「收件箱」一边只给未读）③ 点「全部」后已读条目出现，侧栏高亮转到「收件箱」④ 刷新页面后回到未读（默认状态不持久化 —— 上一次的「全部」不该被记住）⑤ 从分组/源进入时也只看未读 ⑥ 「全部」看到的条数 ≥ 「未读」条数，差值 = 该范围内的已读数 ⑦ 冷启动那次请求的 `view` 参数就是 `unread`（不是先拉全部再在前端过滤） |
| 1.22 | 未读清零后的落点（v1.17 立，**v1.18 推翻重做**） | `m1-22-empty-scope.mjs`（60 条） | ① 点进 0 未读的源 → 分段控件**仍是「未读」**（不再偷偷切成「全部」），该源 4 条已读全部补在分割线「更早的 4 条已读」下面，标题仍是「组名 · 源名」、条数为该源 4 条 ② 点进 0 未读的分组 → 同上且只含该组 3 条 ③ 有未读的范围 → 只列未读、**没有分割线**（① 的反面；少了它，一个"永远补全库"的实现也能过 ①②）④ 手动选「全部」后点另一个分组 / 组内源 → 回到「未读」（v1.17 `if (base === 'inbox') return 'inbox'` 的回归守卫；测法必须是"先全部再点"，正序点选抓不到）⑤ 读完一篇未读 → 侧栏「未读」、分组行、源行**三处数字同时**减 1，且没点刷新；刚读完那一刻**不**自动补已读 ⑥ 全库 0 未读 → 仍是空态「未读已经清零」+ 「看全部」，**不**把全库已读铺进列表；点「看全部」→ `view` 变全部、范围不变 ⑦ 有搜索词 0 命中 → 「没有匹配的条目」，不补分割线 ⑧ 真·空范围（源里 0 条）→ 「还没有条目」+ 「看全库条目」，点下去范围被清空 ⑨ 库里 0 个源 → 「去添加订阅」，不出现「看全部」 |
| 1.23 | 分组 / 单源未读清零（v1.17） | `m1-23-mark-scope-read.mjs` | ① 按源清只动那个源，同组与组外源一条不改 ② 按分组清只动组内，组外不改 ③ 不带范围 → 400 且一条都没改（不提供"清全库"）④ **不写阅读历史**：`first_read_at` 仍全空、`read_count` 之和仍是 0 ⑤ 重复条目不算进 `count` 也不被标已读 ⑥ 幂等（再清一次 0 条）、不存在的范围 200+0（不是 500）⑦ UI：按钮只在「有范围 + 未读>0」出现、点击必须先确认且文案含条数、取消后一条不改、确认后分组与源子行角标归零、清完按钮自己消失 |
| 1.24 | 中间栏标题行对齐（v1.17） | `m1-24-pane-head.mjs` | ① 标题行里每个可见控件的垂直中线极差 ≤ 1.5px ② h1 与「N 条」的中线差 **≤ 1.0px**（旧实现 1.2px，用 1.5 会假绿）③ 最右按钮贴住行右边缘、分段与刷新间距 = 4px ④ 分段控件隐藏（已收藏视图）后刷新按钮 left 变化 ≤ 1px（旧实现 82px）⑤ 六个控件同时在（分组+有未读）时中线仍一致、互不重叠、都不出界、超长标题被截断 ⑥ 375px 下标题行与页面都不横向溢出 |
| 1.25 | 瞬时失败不判死 + 重试失效源（v1.17） | `m1-04-feeds.mjs`（⑨⑩） | ① 瞬时失败（500）连打 5 次仍 active、error_count 累加到 5、仍在 sweep 候选里 ② 404 一次即 broken ③ 「重试失效源」只改 broken、revived 数对得上、error_count 归零、next_fetch_at 立刻到期、原本 active 的源不被动 |
| 1.26 | **未分组源平铺到侧栏**（v2.0） | `m1-26-ungrouped.mjs` | ① 未分组源作为外层行出现在分组区块里，**与分组行同级**：**文字左边界差 ≤ 1px**（量 `.nav-label` 的 x，不是按钮的 x —— padding 只推文字不推盒子，量盒子对"加了缩进"的变异是瞎的，实测 20px padding 全绿）、**行高差 ≤ 1px**、**箭头位宽差 ≤ 1px** ② 它**不出现在任何分组的子行**里（不重复）③ 点它 → 请求带 `folderId=none&feedId=<id>`，列表只剩该源 3 条未读 ④ 再点同一行 → 取消源筛选回 `folderId=none`，列表变回全部未分组未读 10 条 ⑤ 未分组源也显示未读角标（0 不显示 badge、3 显示「3」、7 显示「7」——三个不同数字，抄错一个就红）⑥ 一个未分组源都没有时**整块不渲染**、不留空壳，而分组区块照常 ⑦ 源行总数（已展开组子行 + 未分组行 + 未展开组内源）= `/feeds` 源数（**不漏不重**）；未展开的组不渲染子行；再展开「组乙」后子行 +1、未分组行仍是 3（互不挤占）⑧ 选中未分组源后标题行显示「未分组 · 源名」⑨ 375px 下侧栏本就 `display:none`（既有行为，本次不改）：未分组块不造成横向溢出、tab bar 仍 6 格且每格 ≥44px、列表栏占满 375px；回到桌面尺寸后未被弄坏 | 33 |
| 1.27 | **分组与源的排序**（v2.1） | `m1-27-arrange.mjs` | **接口层**：① `PATCH /folders/reorder [C,A,B]` 后 `GET /folders` 就是 C,A,B（只验"接口能调"不够 —— 路由顺序写反时它 404，而顺序落库才是真判据）② 只提交一个 id → 它第一，其余**保持原相对次序跟在后**（不丢、不错乱）③ 未知 id → 4xx 且顺序**完全没变**（不是部分成功）④ `ids` 非数组 / 空数组 / 混入数字 → 400 ⑤ `POST /feeds/arrange` 移进某组：`folderId` 与 `sort` **都**变 ⑥ 移出到未分组（`folderId:null`）同理 ⑦ 只排一部分 → 未列出的同组源按原次序顺延在后；不存在的分组 404。**界面层**：⑧ 未分组源行的 `top` < **所有**分组行（v2.1 把它从最末挪到最前，推翻 §15.26 的排序行）⑨ 长按满 500ms → 进排列模式并出现「完成」⑩ 按不满就松手 → **不进入**且那一下仍当点击（选中该分组）⑪ 位移 40px 再松手 → 不算长按（既不进模式也不当点击）⑫ 点 ↓ → 顺序变化且 **`GET` 跟着变**（不是只有 DOM 动了）⑬ 拖动中浮起卡片与落点线都出现、松手后浮起卡片消失、拖完顺序落库 ⑭ 首行 ↑ 与末行 ↓ 是 `disabled` 而不是只变淡 ⑮ 「完成」与 Esc 都退出且退出**不是撤销**（顺序保持）⑯ 排列模式下侧栏无横向溢出、分组行高与进入前**逐行相差 ≤1px**（进入模式不许把侧栏撑高，否则光是进模式就挤掉一屏条目）⑰ 配置 › 分组：每个分组行两颗常显箭头（没有长按、没有"进入排列"前置步骤）、首末正确禁用、点 ↓ 后顺序落库 ⑱ 展开分组 → 组内源也有 ↑↓ 与「移到…」，点 ↓ 与换组都落库。**跨组**：⑲ 悬停在分组行上整行高亮（`into` 态，与落点线互斥）⑳ 落位弹 toast（含源名 + 目标组名）带「撤销」㉑ 点撤销 → 源回到原组原位置 | 55 |

**已完成**：1.1~1.26（含 0.9 三栏 UI、移动端、订阅分组与编辑、一键批量管理、
阅读页交互、控件形状尺度、分组内查看订阅源、收件箱阅读控制、配置中心、正文提取、
去重、列表/阅读/历史 API、RSSHub 搜索、侧栏分组树、三栏密度收敛、阅读区边缘与侧边目录、
默认只看未读、未读清零后的落点、分组/单源未读清零、标题行对齐、瞬时失败不判死、
未分组源平铺侧栏、分组与源的排序）。**1.27 是 v2.1 新增，已落地，57 条断言全绿**。

**原 1.8「进程清理」已下架**（v1.5）：浏览器自动化交给 DSH 浏览器插件后，
"脚本自起浏览器 → 攒残留 → 三层清理"这条链的前提消失，`cleanup.mjs`、
`m1-08-cleanup` 与两个截图脚本一并删除，只留 40 行的 `scripts/lib/proc.mjs`。
详见 §15.9。腾出来的位置由 v1.6 的 1.8「批量管理」占用，v1.7 的 1.9「阅读页交互」接在它后面，
原 1.9~1.12 顺延为 1.10~1.13。

v1.8 又插入 1.10「控件形状尺度」与 1.11「分组内查看订阅源」，
原 1.10~1.13（正文提取 / 去重 / 列表 API / RSSHub）顺延为 1.12~1.15，M1 从 13 步到 15 步。

v1.9 再插入 1.12「收件箱阅读控制」与 1.13「配置中心」，上面那四条顺延为 1.14~1.17，M1 到 17 步。
1.13 排在 1.12 之后的理由是：1.12 要往列表标题行里加控件，而 1.13 会动侧栏与导航层；
先加控件再搬结构，被搬动的只是"页面"这一层，标题行不用改第二遍。
反过来先搬再改，就要在那个刚做完大改的弹窗里再摸摸抠一遍标题行。
1.10 排在 1.11 前面的理由是：两者都要动列表头部，先收敛形状再往里加东西，
否则新加的 chip 行会继承同一套散乱的圆角，等于把缺陷复制一份。

v1.13 再插入 1.18「侧栏分组树」与 1.19「三栏密度收敛」，M1 到 19 步。
这两步的顺序不能反：1.18 把 chip 行从列表头部**拿走**，1.19 才去收窄列表栏 ——
反过来的话，先在 400px 宽、带头部的列表栏上算好新宽度，紧接着 chip 行一删，
那组数字又要重算一遍。**先搬走占位者，再定尺寸**。

v1.15 追加 1.20「阅读区边缘与侧边目录」，M1 到 20 步。
v1.16 追加 1.21「默认只看未读」，M1 到 21 步。它是**改默认值**而不是新增能力，
但要单独成步的理由是：默认值一变，侧栏高亮、分段控件、以及要不要记住上次选择
三件事同时要重新决定 —— 塞进 1.12 里改，那条 1.12 的验收脚本就得同时验
初值和切换，两件事的失败原因混在一起就定位不到。它必须排在 1.19 之后，
理由是同一条：1.19 定下了"正文 80ch、两侧各剩多少空白"，1.20 才有那块空白可用。
目录的显示阈值（面板 ≥1500px）本质是**对剩余空白的计算**，宽度没定死之前算不出来。
这也是它没法和 1.19 合并成一步的原因 —— 合并的话，那个阈值会在同一次提交里
被定两次。

v1.17 追加 1.22「未读清零后的落点」，M1 到 22 步。它不是新能力，而是 §15.19
改默认值之后暴露出来的两处空洞（需求方反馈）：点进一个已读完的源看到"你还没有
订阅"，而空态按钮又把范围一起清掉。单独成步的理由是它**同时动了三件事**——
点选范围时的视图决策、空态的文案分档、以及读完一篇后三处未读数的同步。
前两件是界面语义，第三件是状态同步，失败原因完全不同；混在 1.21 里验，
红了分不清是"默认值"错了还是"角标"没跟上。

v1.17 同时追加 1.23「分组 / 单源未读清零」、1.24「标题行对齐」、
1.25「瞬时失败不判死」，M1 到 25 步。这三条与 1.22 是同一批需求方反馈，
但不合并的理由各不相同：

- **1.23 是新增能力**（有 API、有按钮、有确认），与 1.22 的"改落点"不同类；
- **1.24 是纯几何**，它的验收脚本一行文字断言都没有，全是 `getBoundingClientRect`
  的数字 —— 和"空态该说什么话"放一起验，失败时完全无法归因；
- **1.25 改的是服务端判据**（`recordFetchError`），它连前端都不碰，
  混进 UI 步骤里会让"跑一遍 UI 脚本"看起来像验过了服务端。

**v1.18 把 1.22 整条重做了**，步骤编号不动（它还是"未读清零后的落点"这件事，
只是答案换了）。这样处理而不新开 1.26，是因为旧方案不是"少做了一半"，
而是**判断错了**——按 A.1.1，需求层的那一行必须改写，对应的验收脚本也跟着
重写；留一步废弃的 1.26 会让人以为两套方案都在生效。

代价是 `m1-22` 的断言从 47 条变成 60 条，上一版的 ④（"已在全部时点任何范围
→ 仍是全部"）**反向翻转**成"回到未读"。这条翻转本身有记录价值：它是 v1.17
那个 `if (base === 'inbox') return 'inbox'` 的回归守卫，删掉就等于把 bug 的
入口重新打开。

1.25 排在最后，是因为它动了 `broken` 的语义，而 1.23 的 UI 断言里
"清完之后按钮自己消失"依赖源列表能正常取回 —— 先修抓取判据再验界面，
红的时候不会怀疑到"是不是源都被判死了导致列表空"。

**v2.0 的 1.26 为什么编号在后、却不需要重排 M1**：它只往分组区块**末尾**
追加一段渲染，不动任何已有步骤的输出。真正的耦合只有一处 —— 源筛选的
自愈判据从 `folderFeeds` 改成 `feedsInScope`（因为 `folderId='none'`
不在 `feedsByFolder` 里）。这处不改的话，症状是"点了未分组的源，高亮闪一下
就消失"，而不会让 1.11 的既有断言变红 —— `m1-11` 只测真分组。
换句话说：**新增的范围类型要在"自愈"这条判据里被考虑到**，
否则它会静默地把自己撤销掉。

**M1 门禁**：`m1` 全绿 + **50 个真实源连跑 3 天无崩溃**（脚本跑不了，必须真跑）。

**1.1~1.4 拆分的理由**：原计划把"feed CRUD + OPML"放成一步（1.1）。落地时发现解析、OPML、清洗、抓取四件事各自有独立的失败模式，混在一步里任何一个红都定位不到根因。拆开后每一步都能单独跑、单独红、单独修。

### 19.4 M2：AI 分析（1~1.5 周，7 步）

**状态：2.1~2.7 全部完成，7 个脚本 277 条断言全绿**（2026-10-30）。其中 2.6 / 2.7 为 v2.0 新增。
除门禁里的黄金测试集外，本节所有判据都已自动验证。

| # | 步骤 | 自验证 | 通过判据 | 断言数 |
|---|---|---|---|---|
| 2.1 | AI 客户端 + 结构化输出 | `m2-01-ai-client.mjs` | ① mock 返回裸文本/围栏 JSON/合法 JSON 三种都能解析 ② zod 失败自动重试一次 ③ 二次失败进死信不阻塞队列 ④ 降级链 `json_schema → json_object → text`，且判据看报文不看状态码 ⑤ 传输层重试边界：429/5xx 退 2 次、401/404 一次都不重试 ⑥ 每次调用（含重试）各一条 `ai_usage` ⑦ 无 key 时不发请求 ⑧ 未知模型按 `pricing.default` 计 | 54 |
| 2.2 | 单篇分析流水线 | `m2-02-analyze.mjs` | ① 20 篇真实文章全产出摘要，**且每篇摘要对应它自己**（不是"20 篇都有摘要"这种弱断言）② 缺字段 → `stage=failed` 且 `stage_error` 说得出哪个字段 ③ 重跑不重复计费（指纹相同一次请求都不发）④ 正文更新后重分析 ⑤ 空正文不调模型 ⑥ 失败不覆盖已有好结果 ⑦ 摘要进 FTS ⑧ tier 落库 ⑨ **没配 key 时不把整库打成 failed** ⑩ 分析完自动产向量 ⑪ 列表/详情接口带出 summary 与 analysis | 44 |
| 2.3 | 受控分类 + tier | `m2-03-classify.mjs` | ① slug 不在列表 → 判 `other`（不是 NULL）② tier 边界正确（39/40/69/70/89/90）③ 模型自造 slug 长不出新分类 ④ 大小写容错但**不做**近义/模糊匹配 ⑤ 落库层用假客户端真跑后查库验证 | 42 |
| 2.4 | Embedding | `m2-04-embed.mjs` | ① 维度 = 配置值 ② BLOB 字节 = dim×4 ③ 1000 条 1536 维余弦 < 20ms（实测 3.9ms）④ 输入 = 标题+摘要+首段（不含正文后续）⑤ 换模型重算 ⑥ 不与 `entry_vectors` 互相覆盖 ⑦ 维度不符不落库 | 33 |
| 2.5 | 成本审计 + 预算闸门 | `m2-05-budget.mjs` | ① 每次调用都有 `ai_usage` 记录（含失败与重试）② 设 `dailyUsd=0.001` 超限后降 `fast_only` 且**请求照发、模型换成 fast** ③ 再超（月门）则停止、**一个请求都不发**、UI 上可见「已暂停」与原因 ④ 日/月按本地日历边界 ⑤ `0` = 不限额 ⑥ embedding 在日门不降级、月门一起停 ⑦ 闸门可注入 | 35 |
| 2.6 | **API key 可在界面填写 + 全局失败不刷屏**（v2.0） | `m2-06-api-key.mjs` | ① `PATCH /settings/ai/key {apiKey}` 后 `GET /settings/ai` 返回 `hasKey:true`、`keySource:'file'`；`{apiKey:""}` 删除文件 → `keySource` 回到 `none`；过短（<8）与含空白的 key 被 400 拒；`PATCH /settings/ai` 收到 `apiKey` 时 400 并**指名**该用 `/settings/ai/key` ② **响应里不出现完整 key**：掩码是前 3 + 后 4 且**整个响应体文本**里搜不到明文（只断言"返回了掩码"抓不到既给掩码又附带明文的实现）③ `secrets.json` 已创建、权限收紧到仅当前用户（POSIX `mode & 0o777 === 0o600`；Windows 走 `icacls` 且输出里**没有 `(I)` 继承标记**）④ **不进 `app.db`**：直接读 `app.db` 的字节搜 key；`-wal` / `-shm` 也各搜一遍（SQLite 先写 WAL，只看主库会放过"刚写进去还没合并"的实现）⑤ 文件优先于环境变量（第二个进程同时有两者 → `keySource:'file'`，掩码是文件里那个 key 的）⑥ `POST /settings/ai/test`：401 时 `ok:false` + `kind:'http-401'` + 中文 hint（不是原始报文）；正常时 `ok:true` + 模型名，且探针请求 `max_tokens=1`（不是跑一次推理）⑦ **没 key 时 100 条 analyze 只产出 ≤2 行同类日志**，条目**不落 `failed`**，且确实一条分析都没产出（证明前一条不是"本来就成功"）⑧ 孤儿 analyze 回填：判据认得出这 100 条、排进队列后**同一时刻再调一次不再加**（幂等）⑨ 填上 key 后回填能重新认领那 100 条，且**分析真的开始产出**（≥5 篇有 `entry_analysis` 行） | 35 |
| 2.7 | **单篇总结 + 可编辑提示词**（v2.0） | `m2-07-summary.mjs` | ① `POST /entries/:id/summary` 返回 Markdown（含 `##` / `-` / `---`）且落库；**返回的总结对应这一篇**（标题回显在结论里）；落库时记了 16 位十六进制的提示词指纹 ② 同提示词再点 = **0 次上游请求**（`cached:true`）；`force:true` 才重算；`GET` 只读缓存不生成 ③ 改提示词 → 1 次请求、同一篇有 **2 行**（旧的不被覆盖）；**改回默认后立刻命中旧缓存（0 次请求）** —— 这条是"按指纹存而不是覆盖"的决定性断言 ④ 四类占位符都被替换、`user` 里不残留未替换的 `{{…}}`、模板里没写的 `{{summary}}` 被**追加**（不是静默丢）、无高亮时不追加空的高亮段 ⑤ 长文按 `SUMMARY_BODY_CLIP=12000` 截断：`user` 长度 < 14000、**结尾那句确实被截掉**（否则等于没截断）、截断处写明"已截断，共 N 字" ⑥ 读/生成别人的条目总结都返回 **404**（不是 403，避免泄露"存在"）⑦ 无占位符的提示词、超长（>8000 字）、非字符串都被 400 拒并说明；**校验失败后配置没有被写脏** ⑧ 空正文不调模型返回 `kind:'empty'`；模型返回空白时判 `empty` 且**不落库** ⑨ 解析器（`digest/md-parse.ts`，纯函数）认出 h2/p/ul/hr、`<script>` 只当字面文字、`[n]` 识别为 cite 段、`[文字](url)` 当普通文字（不给模型留"偷偷写链接"的路） | 39 |
| **2.8** | **AI 配置页分层折叠**（v2.2，§15.29） | `m2-08-ai-settings.mjs` | ① 两个折叠卡默认**收起**、展开状态不跨次记住 ② 用原生 `<details>`/`<summary>`（键盘与 `aria-expanded` 由浏览器给）③ 折叠头行高 ≥44px（触摸红线，与 §15.7 同一标准）④ 折叠头**不带 `user-select:none`** —— 那条是 §15.28.11 给侧栏长按加的，提到卡片上会让配置页标题选不中而画面完全正常 ⑤ 点概要行能展开、**展开后地址 + 三个模型名输入框确实可见**、再点能收起 ⑥ 收起时摘要行显示当前模型名与提示词状态（收起也知道里面是什么）⑦ 预算卡独立于折叠之外，**收起状态下仍能改**（它原本就在「模型连接」卡里，是最容易回归的一条）⑧ 折叠状态比全展开矮 **≥400px**（实测 2027→1237）—— 没有这条，把四张卡都加上 `<details>` 但内容一字不动也能过 ⑨ 展开/收起不丢输入。<br>**⑤ 的判据踩过一个坑**：关闭的 `<details>` 里子元素 `offsetParent` **不为 null**、`getBoundingClientRect()` 也**仍返回真实高度**（实测 37px）—— Chrome 用 `content-visibility` 实现折叠，不是 `display:none`。所以「用 offsetParent 判可见」在这种结构上**恒为真**。唯一真判据是 `checkVisibility()`（关闭 false / 展开 true）。反向验证过：把 details 改成默认 `open`，新断言红、旧断言仍绿 | 19 |

**M2 门禁**：`m2` 全绿 ✅ **+ 黄金测试集 20~30 篇，摘要准确率 ≥85%、分类 ≥80%**（人工标注一次作为回归基线）。

> 黄金测试集不在本节 —— 它要真人标注、跑真实模型、跨模型版本比较，属于一次性人工工作而非自动断言。
> 自动部分（离线、可复现、零成本）已全部覆盖；剩下的这一项需要需求方在配好真实 key 后人工做一次，
> 结果作为回归基线记进本文档。

**为什么不用 `openai` SDK、为什么降级判据看报文、为什么失败要分类到 `kind`** —— 见 §8.6。
**为什么日门降级而月门停止、为什么配置是三层、为什么闸门是注入的回调** —— 见 §8.7。

### 19.5 M3：每日简报（1.5 周，4 步）

**状态：3.1~3.5 全部完成，5 个脚本 221 条断言全绿**（2026-10-30）。除门禁里的误聚率外，本节所有判据都已自动验证。

| # | 步骤 | 自验证 | 通过判据 | 断言数 |
|---|---|---|---|---|
| 3.1 | 聚类 | `m3-01-cluster.mjs` | ① 100 条同事件样本聚成 ≤3 簇 ② 不同事件不误聚（20 个无关事件 ≥18 簇、最大簇 ≤2 条）③ 100 条 < 1s ④ average linkage 而非单链接（构造 A-B 近、B-C 近、A-C 远的链式三联，必须切成 2 簇）⑤ heat 由源数/条数/重要性/新鲜度共同决定，"单源+高重要性"不挤掉"多源都在报" ⑥ 语义向量覆盖 ≥50% 才整体切换，不逐条挑 ⑦ 成员按与簇心相似度降序 ⑧ 边角：空/单条/全同/零向量/超大簇 ⑨ **两条能力边界断言**把"hashEmbed 只看字面重叠"固定住（防止有人调低阈值提高召回） | 33 |
| 3.2 | 簇级归纳 | `m3-02-cluster-summary.mjs` | ① 输出含 `consensus`/`conflicts` ② 单来源簇标注「单一来源，待验证」**且 conflicts 强制清空** ③ 输入多篇但说法一致时 `conflicts` 为空而非编造 ④ 编造的来源名（"据多家媒体报道"、"新浪科技频道"）被剔除并记进 `droppedSources` ⑤ 只引用一个来源的"分歧"整条剔除（无法交叉验证）⑥ 输入能区分"第几篇/来源名/标题/摘要"，超限截断且写明"其余 N 篇未列出" ⑦ 归纳失败有兜底标题（用原标题，不是「事件 1」）⑧ 整窗重算不累积旧簇、级联删 `cluster_entries` | 39 |
| 3.3 | 简报生成 | `m3-03-digest.mjs` | ① `{{cite:id}}` 全被替换为脚注（同一簇引用两次复用同一编号）② **无一处 URL 是模型编造** —— 裸 URL 与 md 链接一律抹掉并记进 `strippedUrls`，编造的 id 变可见 `[?]` 并记进 `invalid` ③ 同窗重跑是覆盖不是新增，且 **id 不变**（推送出去的链接不能失效）④ 四段结构齐全、highlights 恰好 3 条 ⑤ 单来源主题喂进模型时带标注、多来源不带 ⑥ 模型完全没写引用时有兜底脚注 ⑦ 本地日历日边界 ⑧ ≤12 簇 | 47 |
| 3.4 | 定时生成 + 推送 | `m3-04-schedule.mjs` | ① 改时间到 08:00 触发一次（左闭：恰好 08:00 就跑，不是 08:01）② 失败按 10/60 分钟退避、3 次后当天放弃、第二天重置；成功一次后当天不再跑 ③ 无新内容不发空简报，落 `digest_skips` 记录（只测"没有 digest 行"会让它每分钟重试 1440 次/天）④ **改生成时间不产生第二份**（`period_start` 兼当"哪一天"是这里的老毛病，已拆出 `day_key`）⑤ 三条否决路径各有持久痕迹、四种状态（none/待跑/已跳过/已失败）各自可解释 ⑥ `/digests/status` 真机验路由顺序 | 59 |
| 3.5 | 简报页 | `m3-05-digest-ui.mjs` | ① 引用表**落库**（`digests.cites` 快照，不是从 `body_md` 反查 —— 占位符早在 3.3 落库前就被换成 `[1]` 了，反查永匹配不到，那是"两半都对但接不上"的典型）② 详情接口按 `cites` 顺序返回簇，**顺序与正文 `[1][2][3]` 对齐**（SQL 的 IN 不保证顺序）；簇被清理后仍给 `missing` 条目而不是空号 ③ 正文用**自写的极简 Markdown → React 节点**渲染（不用 `dangerouslySetInnerHTML`，模型输出不经 HTML 解析就没有注入面）④ 脚注点开是**浮层卡片**不跳页，卡片里带"N 篇报道 / M 个来源" ⑤ 冲突视觉克制（左侧细色条 + 小字，**无红色 alert**）⑥ 空引用存 NULL 不存 `[]`，老数据与"确实没有"可区分 ⑦ 侧栏简报从「待接入」转为可点入口 ⑧ 「值得一读」区块有数据来源 ⑨ 浮层能关掉（Esc / 点外面 / 再点同一脚注切换）—— sticky 浮层关不掉等于读正文时永久挡一条 | 43 |
| **3.6** | **简报主链修复**（v2.2） | `m3-06-digest-chain.mjs` | **这个脚本存在的理由就是"既有全绿而线上从未成功过"** —— 3.1~3.5 的断言分两类：纯函数（聚类/引用替换/调度判定）和**在调模型之前就返回**的路径（`m3-04` 只走「没 key」「窗口为空」）。主链上一次都没被真正跑过。① 有内容时 `runDigest` 不抛异常（`loadMembers` 曾查 `e.content_text` —— 该列从 0001 起就不存在，正文在 `entry_contents.html` 的 gzip BLOB 里）② 上游真被调用 3 次（2 簇 = 2 次归纳 + 1 次生成），不是空跑出来的 ok ③ `saveDigest` 真写 `day_key`（曾恒 NULL → `digestDue` 每分钟重跑全套模型调用、`digestStatus` 永远 `pending`、`uq_digest_day` 对 NULL 失效导致同一天多份）④ 生成后 `digestDue` 说「今天已生成」、状态是 `generated`、带得上那份的 id ⑤ 再点「现在生成」是覆盖且 id 不变 ⑥ 无内容仍落 `digest_skips`（回归 m3-04）⑦ `saveDigest` 不传 dayKey 时从 `periodStart` 推本地日 ⑧ **异常也落一次 attempt** —— `runDigest` 文档写着「不抛异常」但实现只在四条显式判定路径上返回，异常发生在 `recordAttempt` 之前，于是退避机制完全不存在（线上 17 行 attempt 全是「没配 key」，跑主链的那些次一行都没落）⑨ 0008 迁移把历史 NULL 补成本地当天 00:00 且可重复执行 | 25 |

**M3 门禁**：`m3` 全绿 + **连跑 3 天，人工评估误聚 < 10%**。

> 与 M2 的黄金测试集同理：误聚率要真人看三天真实数据。自动部分已覆盖"结构正确性"
> （能聚、不误聚、引用不伪造、重跑不重复、简报页能把引用追到事件），
> 但"这一簇到底是不是同一件事"只有人能判。

### 19.5b M4：高亮（1~1.5 周，4 步）

**状态：4.1~4.4 全部完成，4 个脚本 146 条断言全绿**（2026-10-29）。

| # | 步骤 | 自验证 | 通过判据 | 断言数 |
|---|---|---|---|---|
| 4.1 | 三选择器锚定 | `m4-01-anchor.mjs` | ① 偏移未变时 `via=position`，**且切出来的就是那一段**（不是"找到就算了"）② 正文前面多 500 字后仍定位到**原来那一段**，而不是同位置的新内容 ③ 正文中间插入不影响后文 ④ **position 一级必须校验 quote** —— 正文前面加导语会让整篇高亮"整体偏移但都找到了"，用户看到"高亮跑到别处"，比"找不到"更难发现 ⑤ 同一段出现 3 次时靠 context 消歧到正确那处，无 context 时明确说"可能不是原位" ⑥ 全失败 → `via=none`、pos 写 NULL、**行保留**（删除的话用户再也找不回来）⑦ 原文恢复后 orphaned 自动清零（不是一次性判死）⑧ 部分丢失只标失配的那条 | 42 |
| 4.2 | 高亮 API | `m4-02-highlights-api.mjs` | ① 创建/读/改/删/全局列表全通，返回体是驼峰（不泄漏库结构）② **前端拿旧正文提交时不被静默接受**：偏移与 quote 不符按 quote 重算，都对不上则 400 让用户重选 ③ 颜色只收三种（`red` → 400 并列出允许值）④ **note 能被清空**（用 COALESCE 的实现清不掉，空串会被当成"没传"）⑤ 列表**包含 orphaned** 且带标记 ⑥ 游标分页在有删除时**不漏行**（offset 分页会漏）⑦ 越权改/删返回 404（不是 403，避免泄露"这条存在"），越权 PATCH 确实没写进去 | 44 |
| 4.3 | 划词 UI | `m4-03-highlights-ui.mjs` | ① 划词后工具条出现在选区附近（不是屏幕左上角）② 点色块后 **mark 的文本正好是选中的那一段**（不是整段正文）③ 加批注/改颜色后底色与文字都跟着变 ④ **前后端纯文本坐标等价**：刷新页面、只留服务端存的 posStart/posEnd 重画，仍落在同一段文字上 ⑤ orphaned 单独一段可见、且不再画底色 ⑥ 3 个颜色块 + 「AI 解读」入口与「编辑批注」并存 | 27 |

> ① 的容差（±40px 横向 / ±120px 纵向）**不是随手给的松值**，它当初是靠
> "纸顶到正文顶约 72px"这个实况通过。v2.0 在正文上方插了总结卡之后那段
> 距离涨到 179px，① 当场变红 —— 而真因是**工具条的定位父级用错了**
> （坐标按 `.article-body` 算、却按 `.reader` 定位），见 §11.3。
> 修的是定位父级（加一层 `.article-wrap`），**没有动容差**。
> 这个例子说明容差型断言的价值在于"涨破时能报警"，所以它红了不该先想着放宽。
| 4.4 | 高亮 × AI 联动 | `m4-04-ai-linkage.mjs` | ① 单条解读返回非空并落库，重复调用走缓存（**0 次请求**）、`force` 重算 ② 上下文是**这一段的前后各 600 字**：含前文、含后文、**不含 600 字以外的结尾**（否则一个灌全文的实现也能过）③ few-shot **≥3 条才注入**，2 条时返回空串而不是半截标题 ④ **不含别的用户的高亮**（数据隔离）⑤ 措辞是"可参考"不是"必须给高分"（硬规则会让标过两篇之后所有文章都变 mustRead）⑥ orphaned 与 30 天以前的高亮不进 few-shot ⑦ 简报小节原文照列、带批注、空列表返回空串、≤5 条 | 52 |

**M4 判据对照**（§19.6 原表）：① 改提取器后旧高亮仍能定位 → 4.1 第 1~3 条；② 破坏 position 靠 quote 找回 → 4.1 第 4 条；③ 再破坏 quote 靠 range 找回 → **降级为 orphaned**（服务端不做 range，理由是 XPath 是浏览器侧表示，无法在正文重提后重算，见 §11.1）；④ 全失败标 orphaned 且列表可见 → 4.1 第 6 条 + 4.2 第 5 条 + 4.3 第 5 条。

> ③ 的降级是**有意的规格收窄**：range 只作为前端最后一次尝试，服务端判不了就不假装判。
> 这一条若要完整实现，需要把前端的 range 结果回写服务端，而那个回写会在下一次
> 正文变更时立刻失效 —— 收益小于复杂度。

**为什么服务端只做 position/quote 两级、为什么失配保留行、为什么客户端要复刻纯文本映射** —— 见 §11.1 与 §11.1b。

### 19.6 M5~M8

| 阶段 | 关键步骤 | 自验证判据 |
|---|---|---|
| **M5 检索 + MCP**（1~1.5 周） | 混合检索 → RAG 流式 → MCP 6 工具 | ① 20 个问题都有可点击引用 ② Inspector 能列出 6 个工具 ③ stdio 与 HTTP 都能调通 |
| **M6 备份迁移**（1 周） | 增量快照 → 按体积保留 → 导出/导入 | ① `VACUUM INTO` 副本 `integrity_check`=ok ② 超 `maxGB` 时最旧被删 ③ **导出→干净环境导入→条目数/高亮数一致** |
| **M7 插件补全**（1~1.5 周） | 归档/稍后读/集合/黑名单 | ① 16 端点逐个对照 HAR 契约 ② 真实插件全流程走通 |
| **M8 打磨**（1 周） | 分类 UI、监控、prompt 回归 | ① 黄金测试集全绿 ② 连跑 2 周无人工介入 |

### 19.7 需求 → 步骤 → 脚本 反查索引

§1.1 的每项需求，都能顺着这张表查到「在哪一步实现、由哪个脚本验收」。**这是本文档作为验收标准的实际载体** —— 任何一项需求若在这张表里找不到脚本，说明它的验收标准缺失，不允许开工。

| 需求（§1.1） | 实施步骤 | 验收脚本 | 里程碑门禁 |
|---|---|---|---|
| 1 RSS 订阅 / OPML / 全文提取 | 1.1~1.6 / 1.14 | `m1-01`~`m1-06` `m1-14` | `verify/m1` |
| 2 RSSHub 搜索 | 1.6 | `m1-06` | `verify/m1` |
| 3 AI 分类分级 | 2.1 / 2.2 / 2.3 / 2.4 / 2.5 | `m2-01`~`m2-05` | `verify/m2` ✅ |
| 4 每日简报 | 3.1 / 3.2 / 3.3 / 3.4 / 3.5 | `m3-01`~`m3-05` | `verify/m3` ✅ |
| 5 高亮 | 4.1 / 4.2 / 4.3 / 4.4 | `m4-01`~`m4-04` | `verify/m4` ✅ |
| 6 阅读历史 | 1.5 | `m1-05` | `verify/m1` |
| 7 检索与 RAG | 0.7 / M5 | `m0-07` `m5-*` | `verify/m0` `verify/m5` |
| 8 MCP 服务器 | M5 | `m5-*` | `verify/m5` |
| 9 备份 / 迁移 | 1.4 / M6 | `m1-04` `m6-*` | `verify/m6` |
| 10 Huntly 插件兼容 | 0.5 / 0.8 / M7 | `m0-05` `m0-08` `m7-*` | 真实插件 |
| 11 现代简洁 UI | 0.9 / 1.5 / M8 | `m0-09` `m1-05` `m8-*` | `verify/m0` `verify/m1` `verify/m8` |
| 12 CI 打包 + Docker | 0.8 | `m0-08` | `verify/m0` |
| 13 订阅批量管理 | 1.8 | `m1-08-bulk` | `verify/m1` |
| 14 阅读页交互 | 1.9 | `m1-09-reader` | `verify/m1` |
| 15 分组内查看订阅源 | 1.11 | `m1-11-folder-feeds` | `verify/m1` |
| 16 收件箱阅读控制 | 1.12 | `m1-12-inbox-view` | `verify/m1` |
| 17 配置中心 | 1.13 | `m1-13-settings` | `verify/m1` |
| 18 控件形状尺度（非需求，规格层） | 1.10 | `m1-10-ui-scale` | `verify/m1` |
| **24 AI key 可在界面填写** | 2.6 | `m2-06-api-key` | `verify/m2` |
| **25 未分组源平铺侧栏** | 1.26 | `m1-26-ungrouped` | `verify/m1` |
| **26 单篇总结 + 提示词可编辑** | 2.7 | `m2-07-summary` | `verify/m2` |
| **27 资源与性能可验收** | 0.10 | `m0-10-resources` | `verify/m0` |
| **28 分组与源的顺序可调** | 1.27 | `m1-27-arrange` | `verify/m1` |
| 约束：三路部署 | 0.8 | `m0-08` | `verify/m0` |
| 约束：环境隔离 | 0.1 / 0.8 | `m0-01` `m0-08` | `verify/m0` |
| 约束：多人预留 | 0.5 | `m0-05` | `verify/m0` |
| 约束：资源与性能预算（§5.7） | 0.10 | `m0-10-resources` | `verify/m0` |

**二十七项需求里，只有第 10 项（插件兼容）的最终验收不完全靠脚本** —— 它必须用官方原版插件真人操作一次。这是本文档唯一承认「脚本无法覆盖」的地方，因此在门禁里单列，不混进 `verify` 的自动判定。

### 19.8 依赖与并行

```
0.1 工具链
 └─ 0.2 表结构 ─┬─ 0.3 DB 层 ─┬─ 0.4 HTTP ─┬─ 0.5 认证 ─┬─ M1 阅读
                │              │            │            └─ 0.8 部署
                │              │            └─ 0.6 Job runner ─┬─ M1 抓取
                │              └─ 0.7 检索 ───────────────────┴─ M2 AI
                └─ （M4 高亮需要 0.2 的高亮表，可与 M2 并行）
```

可并行三处：

- **0.7 检索** 与 **0.6 Job runner** 互不依赖，可同时做。
- **M4 高亮**（前端 + 锚定算法）与 **M2 AI** 无依赖，两人时可并行。
- **M6 备份** 只依赖 0.3，可在 M1 之后任意时点插入。
- **0.10 资源预算** 只读运行时数据（RSS/CPU/日志行数/产物体积），不依赖任何功能步骤，
  可以随时补跑；但**它必须早于 2.6**，因为"缺 key 刷屏"要先有基线才看得出改善了没有。
- **1.26 未分组** 与 **2.6 / 2.7** 互不依赖（一个改侧栏渲染、两个改 AI 路径），
  三条可并行；实施顺序按"改动面从小到大"排：1.26 → 2.6 → 2.7。

### 19.9 工期汇总

| 阶段 | 步数 | 工期 | 累计 |
|---|---|---|---|
| M0 | 10 | 5~6 天 | 5~6 天 |
| M1 | 26 | 3.5~4 周 | 4.5~5 周 |
| M2 | 7 | 1.5~2 周 | 6~7 周 |
| M3 | 4 | 1.5 周 | 7.5~8.5 周 |
| M4 高亮 | 4 | 1~1.5 周 | 8.5~10 周 |
| M5 检索+MCP | 3 | 1~1.5 周 | 9.5~11.5 周 |
| M6 备份 | 3 | 1 周 | 10.5~12.5 周 |
| M7 插件 | 2 | 1~1.5 周 | 11.5~14 周 |
| M8 打磨 | 3 | 1 周 | **12~14.5 周** |
| **合计** | **52 步** | | |

v2.0 的四个新步骤（0.10 / 1.26 / 2.6 / 2.7）已落进上表：M0 从 9 到 10、
M1 从 25 到 26、M2 从 5 到 7。工期增量约 +0.5~1 周，已含在 M2 的
1.5~2 周里（2.6 与 2.7 的手工活主要在两处 UI 卡与提示词模板，
服务端路径与 2.2/2.3 共用）。

**已实测的四条新增步骤耗时**（用于校准后续估算）：
0.10 ≈ 全天空闲采样（脚本实际跑 4 分钟）；1.26 ≈ 半天（渲染 + 一处自愈判据）；
2.6 ≈ 一天半（secrets / notice / backfill 三个模块 + 三个端点 + 一张卡）；
2.7 ≈ 一天（summary 模块 + 迁移 + 两个端点 + 阅读页卡片）。

**建议顺序**：M0 → M1 → M2 → M3 得到可自用闭环（约 8 周），再 M4 → M5 → M6 → M7 → M8。

三条排期理由：

- **插件兼容拆两段**：M0 的 0.5 落 cookie session、0.8 落「连接+保存+角标」三个端点，因为这三点决定表结构与认证方式，晚做要返工；其余 M7 补完。
- **RSSHub 搜索放在 M1**：它是获取内容的前提，找不到源后面全是空转。
- **MCP 提前到 M5**：复用检索层，成本低、日常收益明显。

### 19.10 通用自检

不确定某步是否真做对时，跑这三个（比单点断言更早暴露问题）：

```bash
# 1. 全量验证
./.toolchain/node/bin/node scripts/verify/all.mjs

# 2. 从零重建（确认没有隐式依赖上一步的残留）
./.toolchain/node/bin/node scripts/verify/all.mjs --fresh

# 3. 干净环境（确认没有隐式依赖开发机的状态）
docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim \
  bash -c './scripts/bootstrap.sh && ./.toolchain/node/bin/node scripts/verify/all.mjs --fresh'
```

### 19.10b 验收脚本的三条硬约定

这三条都是**踩过之后**才写下来的，违反时症状都很像"机器卡了"或"通过了其实没通过"：

**① 用 CDP 的脚本必须显式 `process.exit()` 收尾。**
CDP 的 WebSocket 会让事件循环保持活跃，即使浏览器已经被 `killTree` 掉。
症状：脚本打完 `33/33 PASS` 就挂在那里不返回。它特别难认 ——
单独跑时用 `timeout 300` 包一层，`tail` 照样看得到 PASS，看起来是"通过了"；
放进 `verify-all` 串行跑就变成"整套验收停在某个脚本上，20 分钟没有输出"。
（实测：m1-26 打完 PASS 后 `timeout` 强杀，`real 5m0.0s`。）

**② CDP 的每条命令都要带超时。**
`Page.reload` 之后紧接着 `Runtime.evaluate` 时，被测页面正在换掉执行上下文，
那条 evaluate 的应答**有时永远不来**。`scripts/lib/cdp.mjs` 里 `send()` 与
`evaluate()` 都带超时并抛普通 Error，调用方原本的 `.catch(() => false)`
于是自动覆盖"页面还没就绪"这条正常路径。

**③ `verify-all` 对每个脚本加硬超时兜底。**
10 分钟（`SCRIPT_TIMEOUT_MS`），`killSignal: 'SIGKILL'`。超时要**明确喊出来**
（`超时 600s 被强杀（检查这个脚本是否卡在某个永不返回的调用上）`）——
静默地把挂死记成一个普通 FAIL，下一个人会去翻断言，而那里什么都没有。

另外两条沿用已久的：**`check()` 的回调必须严格同步**（返回 Promise 会被当成
truthy，断言等于恒真）；**`eq()` 是 `Object.is`**，比较数组/对象要用
`JSON.stringify` 两边各一次。

### 19.10c 调试与验收的临时文件必须落在项目内

**规矩：任何脚本（验收、构建、调试）写临时文件一律写进 `.tmp/`，不写系统临时目录。**

理由两条，都是实测出来的：

**① 系统临时目录的垃圾没人负责清。** 一次全量验收（55 个脚本）在 `%TEMP%`
留下 **32 个目录、合计 4.8GB**，其中最大的几个是 500MB 的无头浏览器 profile。
这不是"偶尔漏一个"，是稳定复现。项目内的 `.tmp/` 有 `.gitignore` 兜着、
有清理入口、出问题时也找得到 —— 系统临时目录三样都没有。

**② 路径更短。** `%TEMP%` 在这台机器上是 36 字符，项目内是 17 字符起。
Windows 260 字符上限下，`--user-data-dir` 里的嵌套 profile 目录很容易顶到。

实现方式**不是**逐个改 55 个脚本，而是把 `os.tmpdir()` 指过去：

- `scripts/lib/tmp.mjs` 的 `useProjectTmp()` 设 `TMPDIR / TEMP / TMP` 三个变量
- `scripts/verify/harness.mjs` 在模块顶层调用它 —— 所有验收脚本都 import
  harness，所以**一行改动覆盖全部 55 个脚本**，各脚本照旧写
  `mkdtempSync(join(tmpdir(), 'x'))`
- `scripts/verify-all.mjs` 额外设一次，子进程继承环境变量

> 这条依赖一个**实测过的平台行为**：Windows 上 `os.tmpdir()` 每次调用都读
> `TEMP`，不缓存。进程内改 `process.env.TEMP` 后立刻生效（实测：
> `before: C:\Users\...\Temp` → 改后 `after TEMP change: <新路径>`）。
> 换成会缓存的实现（比如某些 Java/Python 运行时）就必须改写法。

**清理由两道组成，缺一不可：**

| 时机 | 谁做 | 覆盖什么 |
|---|---|---|
| 脚本正常结束 | 各脚本 `cleanup()` → `removeDir()` | 正常路径 |
| 整轮验收结束 | `verify-all` 末尾 `cleanTmp()` | 被 SIGKILL 的、`cleanup` 没跑到的、句柄没释放删不掉的 |

第二道不是冗余。**Windows 上进程被硬杀时 `process.on('exit')` 一次都不执行**，
所以 `cleanup()` 在超时场景下等于不存在。

**为什么删除必须重试。** `taskkill /F /T` 返回后，msedge 的 crashpad handler
与 gpu process 仍会短暂持有 profile 里的文件句柄。实测（278 文件 / 12MB）：
killTree 后**立刻** `rmSync` → `EPERM: Permission denied`；等 310ms → 成功。
原来 20 处 cleanup 都写成 `try { rmSync(...) } catch {}`，把这个 EPERM
静默吞掉了 —— 于是每跑一个 UI 脚本就留一个 13~500MB 的 profile。
`removeDir()` 就是"重试 6 次、每次等 120ms 的 rmSync"，同步睡
（`Atomics.wait`）因为收尾路径没法 `await`。

**手动清理入口**：`node scripts/clean-tmp.mjs`（`--dry-run` 只报体积）。
平时不需要跑 —— `verify-all` 收尾自动清。它存在的理由是"上一次验收被
Ctrl+C 打断"或"某个进程还卡着句柄，想先看看占了多少"。

**`verify-all` 的两个相关开关**：`--keep-tmp` 保留 `.tmp/verify` 便于排查
（默认清）；清理时若仍有删不掉的项，会明确报出来而不是假装干净。

**m0-10 里有 8 条断言盯着这件事**（⑥ 组）：`useProjectTmp()` 后
`os.tmpdir()` 确实指向项目内、真的建出来了、`mkdtempSync` 落在项目内、
不再含 `/AppData/`、`dirSize` 能读出体积、`cleanTmp` 能删掉、
释放体积不是恒 0、以及**没有越界清掉 `.tmp/linuxnode` 之类的缓存**。

---

## 二十、成本估算

假设 50 源、日均新增 500 条、去重后 300 条进分析：

| 项 | 计算 | 量级 |
|---|---|---|
| 单篇分析输入 | 300 × ~4000 token | 1.2M/日 |
| 单篇分析输出 | 300 × ~400 token | 0.12M/日 |
| Embedding | 300 × ~500 token | 0.15M/日 |
| 聚类 + 简报 | 每日 1~3 次长上下文 | 0.1M/日 |
| **合计** | | **≈1.6M token/日 ≈ 4800 万/月** |

按国内主力模型每百万 token 数元级估算，**月成本几十元量级**；用 GPT-4 级模型放大 10~20 倍。因此**分级路由是必需项**，不是优化项。

开启粗筛 + 截断 + 批量合并后，实际进入精读的通常降到 150~200 条/日。

### 20.1 磁盘成本（容易被忽略的一半）

AI 成本之外还有磁盘。按 §13.3 的措施生效后：

| 时段 | 条目数 | 库体积 | 备份（上限 10GB） | 合计 |
|---|---|---|---|---|
| 第 1 月 | ~1.5 万 | ~150 MB | ~1 GB | **~1.2 GB** |
| 第 6 月 | ~9 万 | ~0.9 GB | ~6 GB | **~7 GB** |
| 第 12 月 | ~18 万 | ~1.8 GB | 10 GB（触顶按体积滚动） | **~12 GB** |

**不做 §13.3 那三条措施的话，12 个月是 ~4.5GB 库 + 57GB 备份 = 61GB** —— 这是必须在上线前解决的事，不是后期优化。

NAS 上 12GB 是可接受量级；给 `data/` 预留 20GB 即可舒适运行一年。

### 20.2 开发目录占用（源码部署）

按 §4.3 把工具链也放进项目后，整个目录的构成：

| 部分 | 体积 | 说明 |
|---|---|---|
| `.toolchain/node` | ~104 MB | Node 24 + 完整 npm（解压后，压缩包即删） |
| `.cache/npm` | ~150~200 MB | 依赖包缓存，重复安装不再下载 |
| `node_modules` | ~120 MB | 含 esbuild / vite / react / react-dom |
| `dist/` | ~2 MB | 前端 224KB + 服务端 bundle 945KB + 二进制 |
| `data/` | 视使用 | 唯一需要备份 |
| **合计（不含 data）** | **~380~430 MB** | 全部在 `.gitignore` 内 |

对比「系统装 Node + 全局缓存」的方式：占用相近，但**删目录即完全卸载**，且不同项目之间不会互相污染依赖版本。

Docker 镜像 ~80MB、`data/` 预留 20GB、源码目录 ~400MB —— 三者互不重叠，一台 64GB 的小 NAS 余量充足。

---

## 二十一、风险与对策

| 风险 | 后果 | 对策 |
|---|---|---|
| `node:sqlite` 是 RC | API 可能调整 | 抽 `Db` 适配层（约 40 行）；Node 版本锁 24.x |
| TS 只能用可擦除语法 | 不能用 `enum` | 用 `const` 对象 + union；`tsconfig` 开 `erasableSyntaxOnly` 提前拦截 |
| SEA 不支持 Alpine / darwin-x64 | 这两个平台无二进制 | 只用 glibc Linux 与 Windows 产物；其他平台走源码 |
| `postject` 注入在 Windows 上 OOM | 生不出二进制，前端改动无法验证 | `build-sea.mjs` 里给 postject 加 `--liftoff-only`（见下） |
| 编译产物跑不起来 | 用户下载即失败 | CI 门禁：编译后启动并跑 E2E |
| 静态资源未内嵌 | 二进制启动但页面 404 | 发布前检查：洁净目录单独运行，首页必须 200 |
| 三路部署行为分叉 | 只有 Docker 能跑 | 配置项全集审计；CI 对三条路径跑同一套集成测试 |
| LLM 幻觉 | 摘要含原文没有的信息 | Prompt 硬约束 + 黄金测试集 + `{{cite}}` 强制溯源；UI 标注 |
| JSON 不合规 | 流水线大量失败 | 三级降级 + zod 自愈重试 + 死信列表 |
| 成本失控 | 账单爆炸 | 预算闸门自动降级；`ai_usage` 实时累计；首次导入限速 |
| SQLite 网络盘 | 锁异常 / 库损坏 | 数据目录须为本地块存储；`doctor` 检测告警；WAL + `busy_timeout` |
| **备份不可用** | 真需要时才发现坏了 | CI 强制「导出→新容器导入→条目数一致」往返测试 |
| **磁盘被正文吃光** | 一年后 2.5GB，NAS 告警 | gzip + `raw_html` 30 天 + `noise` 不存正文（§13.3）；`doctor` 监控正文占比 |
| **备份体积失控** | GFS 23 份 × 2.5GB = 57GB | 改为按体积保留、默认上限 10GB（§13.2） |
| 源反爬 / 失效 | 抓不到 | 条件请求、per-domain 限速、UA、退避、`status=broken` |
| SSRF | 内网探测 | 添加源/抓原文时禁内网与元数据 IP、禁非 http(s)、重定向逐跳校验 |
| 中文 2 字查询 | 搜不到 | FTS5 + 程序侧 bigram（`trigram` 实测查不到 2 字词）；语义召回兜底 |
| 未读数卡顿 | 角标每页算 195ms | `WHERE is_read=0` 部分索引，实测降到 0.9ms |
| 聚类漂移 | 标签越用越乱 | 受控分类法为主；无监督聚类只产「新主题建议」待确认 |
| Prompt 劣化 | 改一处坏一片 | 版本化 + 20~30 篇黄金测试集回归 |
| RSSHub 限流 / 需 key | 搜索不可用 | 支持自建实例 + accessKey；路由库本地缓存 7 天，搜索不打网络 |
| RSSHub 路由失效 | 订阅到死源 | 试订阅前抓一次预览；连续失败置 `broken` |
| 高亮锚定失效 | 换提取器后错位 | 三选择器 + 四级降级链；失败标 `orphaned` 并在侧栏列出 |
| MCP 工具过多 | LLM 选错 | 只做 6 个工具；返回 Markdown；强制时间过滤 |
| Huntly 插件改字段 | 兼容层静默失效 | HAR 契约测试；每次大版本重抓校验 |
| **文档与实现脱节** | 文档失去验收效力，项目变成"凭记忆开发" | 每次提交回写文档（附录 A.4）；连续两步不一致即视为文档失效（A.5） |
| **验收脚本被放宽** | 指标全绿但实际已坏 | 改阈值需单独提交 + 在文档写明理由（A.5） |
| **范围被"顺便"撑大** | 工期失控 | §1.2 的排除清单是需求的一部分；新增需求必须经需求方确认（A.1.1），实现者不能自行加行 |

---

## 二十二、M0 逐项清单（对应 §19.2 的 8 步）

§19.2 给的是「每步做什么 + 怎么验收」，本节给的是「每步具体要写哪些文件」。两步一一对应，**不要跳过任何一步** —— 0.1 与 0.2 定下的事，后面全部要依赖。

### 22.1 步骤 0.1 项目内工具链

```
[ ] .npmrc：cache=./.cache/npm（prefix 不能写，见 §4.3）
[ ] .gitignore：.toolchain/ .cache/ .tmp/ node_modules/ dist/ data/ *.log
[ ] scripts/lib/toolchain.sh + toolchain.ps1   # 版本判定、路径解析（唯一逻辑来源）
[ ] scripts/bootstrap.sh + bootstrap.ps1       # 下载 → 解压 → 校验 → 删压缩包
[ ] scripts/dev.sh + dev.ps1                   # 用 .toolchain/node 启动
[ ] scripts/build.sh + build.ps1               # 同上，生产构建
[ ] scripts/verify/m0-01-toolchain.mjs
```

### 22.2 步骤 0.2 表结构与迁移

```
[ ] npm init；装 hono @hono/node-server drizzle-orm@1.0.0-rc.5 drizzle-kit zod
      @mozilla/readability linkedom esbuild fflate @modelcontextprotocol/sdk
      postject（devDep）
[ ] src/server/db/schema.ts               # 全部 18 表，含 entries_fts 与高亮表
[ ] npx drizzle-kit generate → migrations/0001_init.sql
[ ] src/server/db/migrate.ts              # 按 schema_migrations 逐条执行
[ ] src/embed-static.ts                   # --loader:.sql=text 的导入清单
[ ] scripts/verify/m0-02-schema.mjs
```

**一次性建好全部表**（含 `highlights` / `rsshub_cache` / `backup_log` / `chat_*`），不要后续挤牙膏 —— 迁移文件的累积成本远低于改表。

### 22.3 步骤 0.3 数据库访问层

```
[ ] src/server/db/client.ts    # WAL + foreign_keys + busy_timeout + cache_size + mmap_size
[ ] src/server/db/adapter.ts   # ~40 行，唯一与驱动打交道的地方
[ ] 正文以 gzip BLOB 读写      # M0 就定，后改要全量重写
[ ] scripts/verify/m0-03-db.mjs
```

### 22.4 步骤 0.4 HTTP 骨架

```
[ ] src/index.ts               # 子命令 serve|worker|migrate|doctor|version|mcp|export|import
[ ] src/cli.ts
[ ] src/server/app.ts          # Hono 装配；自有 API 挂 /api/v1，插件兼容挂 /api
[ ] src/server/middleware/{auth,error,logger}.ts
[ ] GET /api/health
[ ] scripts/verify/m0-04-server.mjs
```

### 22.5 步骤 0.5 认证

```
[ ] cookie session（SameSite=Lax + Path=/）+ Bearer 双认
[ ] GET /api/auth/loginUserInfo       # 未登录返回 200 + null，不是 401
[ ] src/server/auth/require-user.ts   # 多人预留的唯一开关点
[ ] scripts/verify/m0-05-auth.mjs
```

### 22.6 步骤 0.6 Job runner

```
[ ] src/server/jobs/runner.ts   # claim（BEGIN IMMEDIATE）→ dispatch → 完成/失败/退避
[ ] src/server/jobs/queue.ts    # dedupe_key 幂等入队
[ ] 启动时重置超时 running → pending
[ ] scripts/verify/m0-06-jobs.mjs
```

### 22.7 步骤 0.7 检索层

```
[ ] entries_fts + 写入侧 bigram 切分
[ ] 查询侧 toMatch()（短语 + AND），见 §7.3
[ ] scripts/verify/m0-07-search.mjs    # 含「半导X体」不误命中「半导体」的反例
```

### 22.8 步骤 0.8 三路构建

**已完成**（`a042045` + 后续补强）：

```
[✓] Vite 前端骨架 → scripts/pack-client-zip.mjs
[✓] scripts/build-sea.mjs      # esbuild bundle + postject，支持 --target
[✓] sea-config.json 用 assets（不是 vfsArchive，见 §3.4）
[✓] 运行时 getAsset() + fflate 解压 → 静态服务
[✓] Dockerfile 多阶段（debian:bookworm-slim runtime，非 root）
[✓] scripts/verify/m0-08-deploy.mjs
[✓] scripts/verify/docker-path.mjs     # Dockerfile 逐条本地验证
[✓] cheng-rss doctor 输出完整自检
[ ] /api/page/save + /api/page/pageOperateResult（兼容层 A 起点，留给 M7）
```

**实施中确认的两个事实**（写回文档，避免以后重新踩）：

1. **SEA 的 main 必须打成 CJS**。用 ESM bundle 会直接报
   `Cannot use import statement outside a module` —— SEA 用
   `embedderRunCjs` 执行入口。CJS 下没有 `import.meta`，
   需要 banner 注入 shim 或改用 `__dirname`。
2. **跨平台产出必须有目标平台的 node 作为注入底本**。
   `build-sea.mjs` 默认用 `process.execPath`，从 Windows 造 linux 产物
   时会产出一个跑不起来的文件。已加 `--target` + `CHENG_RSS_SEA_BASE`：
   缺底本时**明确拒绝**而不是静默产出错误产物。

Docker 的验证边界：Dockerfile 结构、四条构建命令、linux ELF 产出
（含内嵌 SQL）都已本地实测；`docker build` 与容器内冒烟未在本机跑过
（无 docker），由 CI 的 `docker` job 补齐。

### 22.9 M0 总判据

四条，全部要过：

1. 同一个 `data/` 目录能在 **Windows 源码模式、Linux x64 二进制模式、x64 Docker 模式**之间互换启动，且 `doctor` 全绿。
2. **官方原版 Huntly 插件能连上并保存一个网页** —— 通过即说明 cookie session、端点形状、字段映射三个最容易错的地方同时对了。
3. 10 万条假数据下，时间线 / 检索 / 未读数三条性能红线达标（§5.6）。
4. **项目目录之外零写入** —— 在没装过 Node 的干净机器上，`git clone` + `bootstrap` + `build` 全程可用，`$HOME` 无新增（§4.5）。

**当前达成情况**：

| 判据 | 状态 | 证据 |
|---|---|---|
| ① 三路互换 | 源码 ↔ 二进制已验证；Docker 未验证 | `m0-08-deploy` 的「同一 data/ 可被源码模式接管」 |
| ② 插件连接 | 后端契约已验证；**真实插件未亲测** | `m0-05-auth` 25 条契约断言 |
| ③ 性能红线 | 已达标 | `m0-07-search` 四条红线 |
| ④ 零写入 | 已验证 | `m0-01-toolchain` + `m0-08-deploy` |

②的「真实插件保存网页」需要人工操作一次 Chrome + 官方插件，脚本无法替代。

### 22.9.1 步骤 0.9 界面（v1.1 新增）

原计划把 UI 打磨放在 M8（"打磨"阶段），M0 只要求"能跑"。**实测这是错的**：M0 结束时界面是两个互斥的简单页面，与 Huntly 的差距不是"打磨程度"而是"形态不同"，而三栏/列表密度/正文宽度这三件事都会**改变 DOM 结构**，留到 M8 意味着前面 M1~M7 的所有 UI 代码都要重写。

所以把「布局形态」提前到 M0 定，M8 只保留"细节打磨"。这是对 §19.2 的一处修订，理由与代价都记在这里。

落地中发现并修掉的三类问题（都是**行为断言抓不到、只有真实浏览器能抓**的）：

| 问题 | 表现 | 根因 |
|---|---|---|
| 列表一屏只有 4 条 | 单条 148px | tier 徽标单独占一行 |
| 正文只有 66 字符宽 | `max-width:72ch` 落在 15px 容器上 | `ch` 相对当前字号；且 `border-box` 吃掉 padding |
| 阅读页键盘全失效 | `j`/`k`/`s` 无反应 | 键盘处理器里 `if (openId) return` 提前返回 |

另有两个**验收脚本自身**的坑：

- 无头浏览器默认 `prefers-color-scheme: light`，不显式模拟就永远验不到"默认暗色"，截图全是浅色。
- 断言 72ch 若读 `getComputedStyle().maxWidth` 会得到解析后的 px（如 582px），与 `'72ch'` 比较永远不等；正确做法是用同字号渲染一个 72ch 探针量实际宽度再比。

### 22.10 M0 必须一起定的六件事（后补会返工）

| # | 决定 | 返工成本 |
|---|---|---|
| 1 | `entries.feed_id` 允许 NULL（网页捕获无 feed） | 中：改表 + 改所有查询 |
| 2 | 认证走 cookie session（插件是 `credentials: include`） | 高：认证层重写 |
| 3 | 插件端点响应体格式**逐端点不同**，不能统一 wrapper | 高：全部端点返工 |
| 4 | 阅读历史用 `last_read_at` 时间戳而非布尔值，`POST /read` 幂等 | 中：历史数据无法回溯排序 |
| 5 | 高亮位置存**三选择器**（quote/position/range） | **极高**：要重算全部历史高亮 |
| 6 | 正文以 **gzip BLOB** 入库，不是 TEXT | **极高**：要重写全部历史正文 |

---

## 附录 A、文档的变更控制

本文档既然是需求来源与验收标准，它的**修改方式**本身需要规则。否则它会退化成一份「谁会改谁就改」的笔记，重新失去效力。

### A.1 什么时候必须改文档

| 触发 | 必须做的动作 |
|---|---|
| 实现中发现设计不可行 | 先改对应章节 + 在 §19 补/改验收脚本，**再改代码** |
| 需求方新增/删除一项需求 | **先经需求方确认**（A.1.1），确认后才改 §1.1 表格；若影响工期，同步改 §19.9 |
| 工期或步骤拆分调整 | 改 §19 对应阶段表 + §19.9 汇总 |
| 弃用一个已写入的机制 | 不能只是删掉，要在 §21 风险表保留「为什么放弃」 |

#### A.1.1 新增需求必须经需求方确认

**任何需求的新增、删除、修改，都必须先得到需求方（项目所有者）的明确确认，才能写进 §1.1 的表格。**

不允许出现的行为：

| 行为 | 为什么禁止 |
|---|---|
| 实现者自行"发现"一个需求并直接加进表 | 需求来源必须是需求方，不是实现者的推测 |
| 把参考项目（Huntly / Feed2040 等）有的功能当作需求补进来 | 参考项目是参考，不是需求。**Huntly 有 ≠ 我们要有** |
| 在实现中顺手做了一项**功能**，事后补记一行"顺带实现" | 需求层要先确认再实现，补记不认。注意：实现层的内部细节不在此列（A.2.1） |
| 用一句「顺便也加上吧」就并入范围 | 没有确认动作的增项，工期与验收都不会被重新评估 |

**确认包含三件事，缺一不可**：

1. **明确表态** —— 需求方确认「要做」，而不是默认、不是没反对。模糊表述（"看看能不能"、"你觉得呢"）不算确认，需要先给出方案再请其定夺。
2. **写入 §1.1** —— 表格新增一行，填全「规格落点 / 实施步骤 / 验收脚本」三列。填不全说明这项需求还没想清楚，暂不纳入。
3. **重估影响** —— 明确说明它影响哪些既有步骤、增加多少工期、是否要改里程碑顺序。**不做这一步就等于悄悄膨胀范围**。

**提议格式**（实现者提需求时必须这样写，让需求方能一句话拍板）：

```
【需求提议】高亮支持导出为 Markdown
- 归属：§11 高亮系统（新增 11.5 小节）
- 实施步骤：4.5（M4 内，+2 天）
- 验收脚本：m4-05-export.mjs —— 导出文件含全部高亮，引用文本可回查
- 影响：M4 从 1~1.5 周变 1.5~2 周；不影响其他阶段
- 若不采纳：高亮仍可在 UI 查看，只是无法导出
```

需求方回一句「加」或「不加」即可，双方无歧义。

### A.2 什么不需要走确认流程

三类，都不必经过 A.1.1：

| 类型 | 例子 | 处理 |
|---|---|---|
| **实现层自由** | 变量名、函数拆分、模块内部组织、日志措辞、CSS 类名 | 直接做，不记录 |
| **技术事实纠错** | "drizzle 0.45 无该驱动"、"Node 24 的 SEA 没有 VFS" | 直接改，提交信息说明 |
| **规格层微调** | 补一个索引、调整缓存策略、把一个函数换成两个 | 先改文档对应章节，再改代码 |

前两类不必确认也不必记录。第三类要改文档但不需需求方点头 —— 因为它不改变"交付什么"，只改"怎么实现才可行"。

**判断标准一句话**：改的是**「要做什么」**还是**「怎么做可行」**。前者走 A.1.1 等确认，后者自主决定。

### A.2.1 文档沉默处的处理

文档不可能覆盖所有细节，这是必然的，不是缺陷。遇到没写的地方：

```
这个决定会被用户看到吗？
 ├─ 会 → 规格层，先写进对应章节（§5~§17），再实现
 └─ 不会
     ├─ 涉及历史数据格式 / 已发布 API / 数据库结构？
     │   └─ 会 → 规格层，写进文档（这类改起来贵，必须留依据）
     └─ 不会 → 实现层，直接做
         └─ 半年后可能有人问"为什么这么做"？ → 记进附录 B
```

一句话：**贵的、看得见的要写进文档；便宜的、内部的直接做，值得记的记附录 B。**


### A.3 版本号规则

```
v1.0  需求定稿，实现未开始
v1.x  实现推进，需求未变（仅在文档尾部追加「实施记录」不影响 v1.x）    ← 当前 v1.1
v2.0  需求范围变化（增删 §1.1 任一行）
```

**判断标准只有一条**：§1.1 的表格有没有变。变了就是 v2.0，并要求重新评估工期与验收脚本。

版本号由 A.1.1 的确认动作决定：**需求方确认的那一刻才升版本**。实现者不能自行把文档改成 v2.0。

### A.3.1 需求变更记录

每次 §1.1 变动都在这里留一行。**没有这行记录的需求变更，视为未确认** —— 这一栏是「用户点头了」的唯一凭据。

| 版本 | 日期 | 变更 | 需求方确认 |
|---|---|---|---|
| v1.0 | 2026-10-23 | 初始 12 项需求定稿 | ✅ 全量确认 |
| v1.1 | 2026-10-25 | **规格层修订，非需求变更**：§15 布局改三栏、72ch 实现细节、§19.2 新增步骤 0.9「界面」 | ✅ 需求方要求「界面至少和 Huntly 基本界面差不多」，已在对话中确认 |
| v1.2 | 2026-10-25 | **规格层修订 + 步骤拆分**：§15.7 新增移动端约束；§19.3 把 M1 从 6 步拆成 9 步（1.1~1.5 已完成） | ✅ 需求方要求「对移动端也进行优化」+「添加 RSS 订阅功能」，均已确认 |
| v1.3 | 2026-10-25 | **规格层修订**：§15.8 新增列表型页面质量约束；§19.3 新增步骤 1.6「订阅页界面」 | ✅ 需求方指出「订阅界面显示有问题」，修复后补验收 |
| v1.4 | 2026-10-26 | **规格层修订**：§15.9 新增长跑验证的进程卫生；§19.3 新增 1.7「订阅分组与编辑」、1.8「进程清理」 | ✅ 需求方要求「订阅的编辑和分组」+ 发现进程残留吃光内存 |
| v1.5 | 2026-10-26 | **规格层回退（下架而非新增需求）**：浏览器自动化改用 DSH 浏览器插件，§15.9 改写为「三层清理为何存在、为何下架」，删除 `m1-08-cleanup` 与两个截图脚本；§19.3 步骤由 12 步回到 11 步（原 1.9~1.12 前移为 1.8~1.11） | ✅ 需求方说明「使用了新的浏览器插件，原来的清理方式不再必要」 |
| v1.6 | 2026-10-26 | **需求层新增（走 A.1.1）**：§1.1 加第 13 行「订阅一键批量管理」；§15.10 新增批量模式交互与四个批量端点；§18 补 API；§19.3 插入 1.8「批量管理」并补 `m1-08-bulk`（步骤回到 12 步） | ✅ 需求方要求「添加一键管理订阅的功能」，已确认进需求表 |
| v1.7 | 2026-10-26 | **需求层新增（走 A.1.1）**：§1.1 加第 14 行「阅读页交互」（原文/源站双出口、正文链接不打断阅读、列表可新标签打开、已读可回退、阅读偏好三项）；§15.11 新增；§18 补 `/entries/unread` 与 `/entries/:id/progress`；§19.3 插入 1.9 并补 `m1-09-reader`，原 1.9~1.12 顺延为 1.10~1.13（M1 从 12 步到 13 步） | ✅ 需求方指出「rss 阅读器功能性太弱，比如跳转源网页、对应的链接不能点击」，选择「A + 两个提议全做」 |
| v1.8 | 2026-10-26 | **需求层新增（走 A.1.1）**：§1.1 加第 15 行「分组内查看订阅源」；§15.12「控件的形状尺度」（规格层，非需求）新增；§15.13 新增；§18 注明 `feedId` 与 `folderId` 可叠加；§19.3 插入 1.10「控件形状尺度」与 1.11「分组内查看订阅源」，原 1.10~1.13 顺延为 1.12~1.15（M1 从 13 步到 15 步） | ✅ 需求方指出「部分按钮的形状太突兀」+「分组不能查看分组内的不同订阅源信息，需要加上，记录该需求」 |
| v1.9 | 2026-10-26 | **需求层新增（走 A.1.1）**：§1.1 加第 16 行「收件箱阅读控制」（全部/未读分段 + 刷新 + 收藏双图标修正）与第 17 行「配置中心」（订阅/分组/账户收进配置弹窗、订阅页分组改下拉栏、参考 Huntly SettingModal）；§15.14、§15.15 新增；§19.3 插入 1.12、1.13，原 1.12~1.15 顺延为 1.14~1.17（M1 从 15 步到 17 步） | ✅ 需求方要求「收件箱需要可以选择全部和未读，还要添加刷新按钮，让已读可以刷新」+「收藏按钮点击后有两个收藏图标」+「分组添加下拉栏，添加配置功能。订阅管理等部分功能，放入配置中。具体可以参考 huntly，写入需求」 |
| v1.10 | 2026-10-27 | **规格层修订，非需求变更**：§7.5 补正文提取分级保留与触发阈值；§19.3 落地 1.14 | ✅ 需求方「开始落地实现」后按 §19 顺序执行 |
| v1.11 | 2026-10-27 | **规格层修订，非需求变更**：§6.2 补 `entry_vectors` 表；§7.4 补分桶规则 | ✅ 同上，1.15 落地时确定的细节 |
| v1.12 | 2026-10-27 | **规格层修订，非需求变更**：§10.6 补 RSSHub 三层缓存与 `fetchedAt` 取较早值的理由 | ✅ 同上，1.17 落地时确定的细节 |
| v1.13 | 2026-10-27 | **需求层新增（走 A.1.1）**：§1.1 加第 18 行「侧栏分组树」与第 19 行「三栏密度收敛」；§15.13 由「列表头部 chip」改写为「侧栏可展开分组树」；§15.16 新增三栏宽度与密度的实测依据与取舍；§19.3 插入 1.18、1.19（M1 从 17 步到 19 步）；**同日后半段再修订 §15.15：删除桌面侧栏「订阅源」整块，配置唯一入口改为齿轮，手机底部导航那一格改名「配置」，§19.3 的 1.13 判据补 ⓪ 与 ⑩** | ✅ 需求方要求「分组采样左侧下拉栏，不然分组内部订阅数量多会导致博客列表栏显示不全」+「左侧的工具栏和订阅的列表栏占用空间过大，可以适当缩小」，并在二选一中选定「A 侧栏可展开分组树」；随后要求「删除主页的订阅源按钮，全部放到配置里面」，并就手机入口与文档记法两次确认（选「改名『配置』+ 齿轮图标」与「按 §15.15 规格修订处理」）｜
| v1.14 | 2026-10-28 | **规格层修订，非需求变更**：§15.3 正文宽度 72ch → 默认 80ch（可调 64/80/96），并给出 1440/1920 下两侧留白的实测收敛表；阅读区上下留白与段间距同步收紧（标题上 34→24、meta 下 26→18、AI 卡下 30→22、段距 1.15→1.05em、文末 34+20→26+16）；§15.16 补「v1.14 补记：这一节留了尾巴」说明容器变宽 ≠ 正文用上宽度；§19.3 的 0.9 ③ 与 1.19 ②③ 判据改为「从 `--reader-width` 读期望值 + 断言两侧留白 40~90px」 | ✅ 需求方要求「主内容栏的空间空白太多，可以减少一点，合理布置排版」，并在三选一中选定「宽栏 + 收紧行距（推荐）」｜
| v1.15 | 2026-10-28 | **需求层新增（走 A.1.1）**：§1.1 加第 20 行「阅读区边缘与侧边目录」；§15.18 新增（正文列做成"纸"的视觉规格 + 目录的宽度阈值/空目录规则/跳转交互/从 DOM 读标题的理由）；§19.3 插入 1.20（M1 从 19 步到 20 步，30 个脚本），并在「顺序不能反」那段补 1.20 必须排在 1.19 之后的理由 | ✅ 需求方要求「显示界面加上边缘显示，同时可以加上侧边目录显示，利用侧边的空白」，并三次确认（边缘＝「正文列做成一张纸」、目录＝「只在宽屏出现」、空目录＝「没标题就不显示」），另确认「新增需求行 20 + 1.20」｜
| v1.16 | 2026-10-28 | **需求层新增（走 A.1.1）**：§1.1 加第 21 行「默认只看未读」；§15.19 新增（改默认值的理由、三处连带影响、不持久化的决定、与 §15.14 的关系）；§15.14 补 v1.16 修订说明「默认全部激活」已失效；§19.3 插入 1.21（M1 从 20 步到 21 步，31 个脚本）并补 1.21 单独成步的理由；1.12 那一行的标题注明「v1.16 默认值改未读」 | ✅ 需求方要求「记得默认进去查看的都是未读数据，只有点击全部才会显示全部数据」，并两次确认（侧栏「未读」一起亮、新增需求行 21 + 1.21）｜
| v2.0 | 2026-10-30 | **需求层新增（走 A.1.1），四项**：§1.1 加第 24 行「AI key 可在 Web 界面填写」（存 `data/secrets.json` 600、不进库不进备份；未配置时**同一条只记一次**，不逐条刷屏）、第 25 行「未分组源平铺在侧栏分组区块」、第 26 行「单篇总结按钮 + 总结提示词可编辑」（按提示词指纹缓存）、第 27 行「资源与性能可验收」；新增 §5.7（空闲红线六条 + 优化任务清单 P1~P8）、§8.8（key 三个落点的对比与选择、掩码规则、`POST /settings/ai/test`、"没配 key"为什么不能每篇报一次、为什么不是"没 key 就不排队"）、§8.9（单篇总结与 2.2 摘要的分工、为什么可以开放提示词、指纹缓存而非覆盖、模板占位符、为什么复用简报的 Markdown 渲染器）、§15.26（为什么平铺而不造伪分组）、§15.27（总结按钮的五种状态、为什么在正文之上）；§8.1 的「`apiKey` 永远不进 settings」保留但加注修订方向；§15.13 表格「未分组」一行由"侧栏仍无入口"改为"有入口"；§19.2 加 0.10、§19.3 加 1.26、§19.4 加 2.6/2.7（共 +4 步，M0 9→10、M1 25→26、M2 5→7）；§19.7 反查表加四行；§19.8 并行关系补两条；§19.9 工期重算（M2 1~1.5→1.5~2 周，总工期 +0.5~1 周） | ✅ 需求方原话「没有 api key，在日志里会一直报错，这个报错太多了；API 不能在 web 界面中输入吗；未分组的直接在组的地方显示，没有分组就意味着在最外面直接看；对于单个文章，提供总结按钮，并可以编辑总结提示词；注意软件的性能和资源占用，可以在计划中列出性能优化任务」，并就三处实现选择明确答复「存 data/secrets.json」「平铺与分组行同级」「加按钮+提示词可编辑」 |
| v1.17 | 2026-10-28 | **需求层新增（走 A.1.1）**：§1.1 加第 22 行「未读清零后的落点」与第 23 行「按分组/按单个订阅清零未读」；§15.20 新增（点选 0 未读范围直接进全部、空态文案四档、按钮拆成「看全部」与「看全库条目」、三处角标同步）；§15.21 新增（只写 `is_read` 不写阅读历史、不提供"清全库"、幂等与越界边界）；§15.22 新增（标题行拆两段、统一 22px、几何阈值 1.0/1.5px 的来源与"旧实现下必须红"的自证方法）；§15.23 新增（瞬时失败不置 broken 的事故复盘、修判据不改数据所以要 retry-broken、不做自动复活的理由）；§7.5 补「pending 与 jobs 会脱钩」的兜底设计（backfill 定时器、判据、200/轮、幂等）；§19.3 插入 1.22~1.25（M1 从 21 步到 25 步，34 个脚本）并补四条各自单独成步的理由与排序依据 | ✅ 需求方一次给出四条反馈并要求「加，按 A.1.1 走完整流程」，另就「未读清零」的范围明确选择「只做分组与单源两档」、就失效订阅选择「瞬时失败永不置 broken」｜
| v1.18 | 2026-10-28 | **需求层第 22 行改写（走 A.1.1）**：从「0 未读就切到该范围的『全部』」改成「分段控件不动 + 列表内分割线补出该范围的已读」；§15.20 保留 v1.17 的错误方案作为复盘（两条现象及根因 `if (base === 'inbox') return 'inbox'` 把视图状态当成范围的属性），规则改成"每次点选范围都回默认视图"；§15.24 新增（分割线的六个设计决定与各自反例、尾段取数的五个准入条件、标题条数为什么要换变量、为什么尾段翻页不能复用 `load`、`EntryRow` 抽出来是为了行距一致而不是复用、后端新增 `view=read` 与 `history` 的区别）；§15.25 记录 m1-11 的前置因规则推翻而失效、修在 helper 里；§1.1 第 22 行与 §19.3 的 1.22 行同步改写；`m1-22` 从 47 条扩到 **60 条**断言 | ✅ 需求方原话「从长知识的无未读，切换到其他分组（有未读）还是在全部里面，这个每次点击需要判断一下……是指在列表栏中分割线，补充上全部的列表，可以参考 huntly 实现」；并就两处实现选择明确答复「只在 0 未读时补已读」与「切范围就重置」｜
| v1.19 | 2026-10-29 | **规格层修订，非需求变更**：§8.6 新增（为何不引 openai SDK、结构化输出的四级降级链、三类重试各自的边界、失败分类表、计费口径与「未知模型按 default 计」的理由）；§19.4 的 2.1/2.2 判据按落地结果扩写 | ✅ M2 按 §19.4 顺序执行 |
| v2.1 | 2026-11-03 | **需求层新增（走 A.1.1）+ 界面重设计**：§1.1 加第 28 行「分组与源的顺序可调」；新增 §15.28（两个入口、500ms/8px 的长按判定与它的来历、四个阶段的悬浮反馈、落点线与整行高亮为何不能合并、toast 只在跨组时出现、每次落位即提交、两个接口的整表提交语义与"未列出的顺延在后"、迁移 0007 的 `feeds.sort`、五个必须同步 `sort` 的写路径、四个排序键必须前后端一致、21 条边界条件、实现时踩的两个坑、三个自主决定）；**§15.26 的排序行由"固定排在所有分组之后"改为"排在最前"**（需求方本轮明确要求，属于推翻旧结论）；§19.2 加第 28 行、§19.3 加 1.27（55 条断言）、§19.7 加一行、文件头与 §19.10 的脚本数与断言数从 52/2088 更新为 53/2152。**并修 `m1-15-dedupe` 的日期腐化**：夹具写死 `pubDate` 为 Oct 2026 + 20~28 日，向量判重只看近 14 天，日期走到 11 月 3 日时原件正好掉出候选窗 51 分钟，三条断言开始红 —— 该失败在任何历史提交上都可复现，不是任何一次改动的责任，改为相对当前时间生成 | ✅ 需求方原话「我希望可以在分组栏长按，去调整分组顺序等」，追加四条「未分组源行也要参与排序和进入、拖出分组」「进入和脱出分组需要有提示」「长按可以拖动之后需要有特效提示，例如悬浮或高亮等，按照常规做法来」「配置功能中添加手动调整的方式，如上下箭头等，不用长按功能」；并就两处实现选择明确答复「保持两层：分组内排源、分组间排序」与「分组和组内源都能用箭头调」，随后改口「未分组放在最前面」 |
| v2.2 | 2026-11-04 | **缺陷修复 + 规格层新增（非需求变更，§1.1 不动）**：**① 简报主链四个缺陷**（PLAN §9.6）：`loadMembers` 查不存在的 `e.content_text`/`e.feed_content_text`（正文其实在 `entry_contents.html` 的 gzip BLOB 里）→ 有内容时必然抛异常；`saveDigest` 的 INSERT 漏写 `day_key` → 恒 NULL，调度器每分钟重跑全套模型调用、UI 永远 `pending`、`uq_digest_day` 对 NULL 失效导致同一天多份；`runDigest` 的「不抛异常」契约没兑现（异常发生在 `recordAttempt` 之前 → 退避机制完全不存在，线上 17 行 attempt 全是「没配 key」，跑主链的那些次一行都没落）；新增迁移 0008 把历史 NULL 按本地日回填。**新增 `m3-06-digest-chain`（25 条）** —— 既有 3.1~3.5 的断言全是纯函数或"在调模型之前就返回"的路径，主链上一次都没被跑过，这是验收的覆盖面缺口而不是断言写少了。**② AI 配置页分层折叠**（§15.29，需求方原话「AI配置界面太繁琐」）：四张卡全展开约 1400px、6 输入框 8 按钮，在 900px 弹窗里滚三屏；按访问频率分四层（概览常显 / Key+预算常显 / 模型名与地址收起 / 提示词收起），用原生 `<details>`。**新增 `m2-08-ai-settings`（19 条）**。**③ 数据清洗与省 token 方案**（§9.7，需求方要求"列入之后的修改计划"，**本节是计划未实现**）：实测单篇分析平均输入 1195 / 输出 976 tokens、379 次调用全部失败白烧 701,448 tokens；列 P1~P6 六项措施与各自的验收判据。**④ 文档数字漂移**：1.27 的断言数 55 → 57（v2.1 当时写的是修前的数），脚本数与断言总数 53/2152 → 55/2030（实测），README 验收表补 `m0-02` 13→15、`m1-13` 50→52、`m0-10` 31→39 三处旧值并新增 m2-08 / m3-06 两行 | ✅ 需求方原话「简报功能异常、AI配置界面太繁琐；AI简报的token消耗太多，将数据清洗和节省token的方案列入之后的修改计划」，并明确「接下来的计划先不推进，完善当前的任务。修改文档、完善代码」 |
| v2.3 | 2026-11-04 | **项目改名为 cheng-rss**（仓库、包名、二进制、docker 服务、cookie、localStorage、环境变量前缀、User-Agent、OPML 导出文件名），**不做向后兼容**：`ai-rss` → `cheng-rss`（247 处 / 71 文件）、`AI_RSS_*` → `CHENG_RSS_*`（70 处）、`ai_rss_sid` → `cheng_rss_sid`（22 文件）、`ai-rss.reader-prefs.v1` →`cheng-rss.reader-prefs.v1`、二进制 `ai-rss-<platform>` → `cheng-rss-<platform>`。**数据库文件名与 `secrets.json` 刻意不改**（仍是 `data/app.db`），所以升级不需要迁移数据、不用重填 AI key —— 改名的影响被限制在"标识"层面，不碰"状态"。代价写进 README 的「从 ai-rss 升级」一节：已登录会话掉线、阅读偏好回默认、环境变量失效、启动脚本路径失效、docker compose 会当成新服务。**为什么不做兼容读取**：需求方明确要求彻底改名。兼容层要在 cookie 上读两个名字、localStorage 上查两个 key、数据库上探两个文件名、环境变量上读两个前缀 —— 四处兼容代码会长期存在，而换来的是"旧实例升级时少点两下"。在只有单一部署者的当前阶段，一次性断掉更干净。**可推翻条件**：一旦有外部用户报升级问题，就按 README 那五条做一次性迁移脚本。 | ✅ 需求方原话「各类文件名和项目名，都改成cheng-rss」；并就兼容性明确答复「彻底改名，不做兼容」 |
| v1.20 | 2026-10-29 | **规格层修订，非需求变更**：§8.7 新增（日门降级/月门停止两道门、本地日历边界、`0`=不限额、闸门问在第一个请求之前、embedding 不降级、AI 配置三层合并与「空值不打回默认」的坑、闸门做成注入回调 CallGuard、`ai_usage` 记的是调用不是条目）；§19.7 反查表第 3 行补 2.4/2.5；§19.4 补状态与断言数、明确黄金测试集需真人做 | ✅ 2.3~2.5 落地时确定 |
| v1.21 | 2026-10-29 | **规格层修订，非需求变更**：§9.4 新增（聚类与去重是两个问题阈值必然不同、hash 与语义向量两套阈值、为什么不用单链接与 k-means、向量来源整体切换、heat 是乘不是加、单来源 conflicts 强制清空、conflicts 来源必须真实且至少两方、引用安全为何强于事后校验、抹裸 URL、简报重跑 id 不变、聚类整窗重算）；§19.5 补状态与 3.1~3.3 断言数、明确误聚率需真人判 | ✅ 3.1~3.3 落地时确定 |
| v1.24 | 2026-10-30 | **规格层修订 + 补一步**：① **补 3.5 简报页**（§19.5b 之后新增）—— 3.1~3.4 的产物完整，但**前端没有简报页**，侧栏还标着「待接入」，等于"生成了没人看得见"。这一步不新增需求，只是把 §15.4 已批准的设计落地。修掉的既有断点：`renderCitations` 在落库前已把 `{{cite:cl_x}}` 换成 `[1]`，而 `GET /digests/:id` 一直用正则反查 —— 永匹配不到，clusters 恒空、脚注点了没反应。新增 0005 迁移存 `cites`/`worth_reading` 快照列。② §15.7 移动端 tab **5 → 6**（简报成为一等入口），并说明 390px 下 6 格每格约 65px 仍过 44px 下限，真正的约束是高度不是宽度 | ✅ 3.5 落地时确定 |
| v1.23 | 2026-10-29 | **规格层修订，非需求变更**：§11.1b 新增（服务端只做 position/quote 两级、range 是浏览器侧表示且回写必然失效、position 一级必须校验 quote、失配标 orphaned 保留行且可自动清零、客户端必须复刻纯文本映射且规则逐条等价、块级分隔符换行不算 bug 而不补分隔符才是）；§11.2 补接口实现约束（服务端算锚点、note 用 in 判断而非 COALESCE、insight 同步返回且失败仍 200）；§11.4 加状态列并说明两项推后到 M5 的理由、4.4 的三条约束；§19.5b 新增 M4 判据表（146 条断言）并把原 19.6 的 M4 判据做对照说明（③ 降级为 orphaned 是有意的规格收窄）；§19.6 改为 M5~M8；§19.7 反查表第 5 行标记完成 | ✅ M4 落地时确定 |
| v1.22 | 2026-10-29 | **规格层修订，非需求变更**：§9.5 新增（三种否决各有持久痕迹、为什么只看 digests 行会让它一天重试 1440 次、period_start 兼当"覆盖窗口"与"哪一天"会让改时间产生第二份简报、day_key 必须按本地日算、调度器只入队不生成、digest handler 的失败策略与 embed 相反、坏配置不能拖垮整个扫描、路由顺序 /status 在 /:id 之前）；§19.5 补 3.4 判据与断言数、反查表第 4 行标记完成 | ✅ 3.4 落地时确定 |

填写规则：

- **只记"加/删/改需求"**，不记实现进度（进度看 §19 的脚本状态）。
- 「需求方确认」列只能填 ✅ 或 ⏳，**不能留空** —— 留空等于未走流程，那一行需求应被撤下。
- 一次确认涉及多项时，每项各占一行，便于将来追溯是哪一项让工期变了。

### A.4 每次实现提交的对应关系

一个提交对应文档里的一处改动，提交信息要能指回去：

```
feat(0.2): 建表与迁移内嵌
docs: §6.2 补 entry_contents 索引

m0-02-schema: 4/4 PASS
```

**提交信息里带不上验收结果，说明这一步还没做完。** 这是最轻量的强制手段：让「文档 §19 的脚本通过」成为提交的一部分，而不是事后补的一张清单。

### A.5 什么时候本文档失效

两种情况，任一发生则文档不再能当验收标准：

1. **规格层脱离实现** —— 连续两个步骤的代码与文档写明的机制不一致且未修正（注意：实现层差异不算，那是正常的）。
2. **验收脚本被改成"能过"而不是"修好"** —— 脚本只应因实现变好而变绿，不应因断言放宽而变绿。改动断言阈值必须同时在文档里写明理由。

第 2 条比第 1 条更隐蔽：它会让所有指标看起来正常，直到真出问题。因此**修改 `scripts/verify/` 下的阈值需要单独一次提交，并在提交信息里说明为什么原阈值不适用**。

---

## 附录 B、实现决策记录

记录**文档未规定、但影响可逆成本较高**的实现选择。目的不是留痕审批，是防止半年后有人推翻一个其实有理由的决定。

**只记这类**：文档沉默、用户不可见、但改起来不算便宜的决定。

不记的：纯风格选择、一次性代码、能一眼看懂的决定。

| 步骤 | 决定 | 理由 | 可推翻条件 |
|---|---|---|---|
| 0.9 | 三栏布局而非两栏 | 阅读时列表常驻，"读完挑下一篇"是最高频动作；跳页式切换把它变成两次点击 | 若窄屏/移动端成为主要场景，回到两栏（那时列表本来就放不下） |
| 0.9 | 不引 Tailwind/shadcn，手写 776 行 CSS + 13 个内联 SVG 图标 | 全站只用 8 个组件，组件库带来的配置与依赖成本超过手写成本 | 组件数超过 20 个时切回 shadcn（`§15.6` 已写明切换点） |
| 0.9 | 用本机 Edge 无头 + 裸 CDP 做 UI 验收，不装 playwright | 零下载（Edge 就是 Chromium，系统自带）；playwright 要拉 300MB Chromium | 需要跨浏览器（Safari/Firefox）回归时换成 playwright |
| 1.7 | ~~三层进程清理（pid 登记 + 启动扫残留 + 标记兜底）~~ **已被插件方案取代** | 前提是"脚本自己起浏览器、自己攒残留"；浏览器插件接管后脚本侧没有可泄漏的进程，因此 `cleanup.mjs` / `m1-08-cleanup` / 两个截图脚本全删，只留 40 行 `scripts/lib/proc.mjs` | 若哪天又出现脚本自起浏览器的需求（如 CI 里跑布局断言），需要把兜底层加回来 |
| 0.9 | 验收脚本里注入 cookie 而非走表单登录 | UI 验收只关心 UI；登录流程已由 `m0-05-auth` 的 25 条断言覆盖 | 若出现"登录后 UI 状态错乱"类 bug，改为真实表单登录 |
| 0.3 | `unpackText` 用 2 字节 gzip 魔数识别旧格式，同时保留 0x00/0x01 标记 | 早期数据是裸 gzip；魔数判定是确定性的，比"试 gunzip 失败当明文"可靠 | 若无历史裸 gzip 数据，可删掉魔数分支 |
| 0.8 | `build-sea.mjs` 每次都重打 `client.zip`（原来"存在就跳过"） | zip 只 77KB，重打比维护依赖关系便宜；跳过曾导致"构建全绿但二进制里是旧 UI" | 前端构建时间变长到秒级时可加 mtime 判断 |
| 0.5 | `health.needsSetup` 由服务端返回，与 `POST /auth/setup` 的门禁同源 | 前端曾用 `(stats?.entries ?? 0) === 0 && false` 判据，恒为 false，永远进不了初始化页 | 若日后允许多用户自助注册，这个字段语义会变 |
| — | （示例）`entries_fts` 用 external content 表而非 contentless | 需要支持按 rowid 回查原文做高亮对齐 | 若 FTS 体积成为问题，可改 contentless 并接受无法回查 |

填写规则：

- **每行都要有"可推翻条件"**。写不出来，说明这个决定其实不可逆，应该升级到规格层写进正文。
- 发现某个记录已失效（后来的实现换掉了它），不要删，改成 ~~删除线~~ 并注明被哪一步取代。
- 这张表**不参与验收**。它是参考材料，verifying 脚本不读它。


