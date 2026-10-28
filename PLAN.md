# AI RSS 阅读分析器 —— 需求与实现方案

> 一个自托管的在线 RSS 处理工具：阅读体验对齐 Huntly，并在此之上提供自动化的 AI 整理分析（分类分级、每日简报、跨篇聚合）。
>
> 支持二进制 / 源码 / Docker 三种部署，单个数据目录即可备份迁移。
>
> 版本 **v1.13**｜状态：M0 完成，M1 全部 19 步完成（29 个验收脚本全绿）；v1.13 追加 1.18 侧栏分组树与 1.19 三栏密度｜22 章

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
| Linux x64 (glibc) | `ai-rss-linux-x64` | 云服务器、x86 NAS、Docker |
| Windows x64 | `ai-rss-windows-x64.exe` | 桌面本机 |

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
./ai-rss-linux-x64 serve --data ./data --port 3000
```

**五个必须做到的工程点**（缺一条「二进制部署」就是名义上的）：

1. **前端静态资源内嵌**。Vite 产物打成 zip → `sea-config.json` 的 `"assets"` → 运行时 `getAsset()` + `fflate` 内存解压（§3.4）。**不能**假设发布时旁边有 `public/` 目录，也**不能**用 `vfsArchive`（Node 24 不支持）。
2. **迁移 SQL 内嵌**。esbuild `--loader:.sql=text` 把迁移文件打成字符串，运行时按 `schema_migrations` 表逐条执行。
3. **提示词模板内嵌**（`packages/prompts/*.md`，同样用 text loader）。
4. **数据目录显式外置**：`--data`，默认 `./data`。二进制本身无状态。
5. **子命令自检**：`ai-rss version` / `doctor` / `migrate` / `serve` / `worker` / `mcp` / `export` / `import`。

### 4.2 源码部署（开发 / 定制）

目标是**装完不污染系统**：Node 运行时、npm 缓存、依赖、构建产物、数据库全在项目目录内，删除目录即彻底卸载。

```bash
# Linux / macOS
git clone … && cd ai-rss
./scripts/bootstrap.sh          # 下载项目内 Node 24 + 初始化本地缓存（只需一次）
./scripts/dev.sh                # = ./.toolchain/node/bin/node …（热重载）
./scripts/build.sh              # 生产构建
./scripts/build.sh --sea        # 产出本机平台二进制

# Windows（PowerShell，无需 git-bash / WSL）
git clone …; cd ai-rss
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
ai-rss/
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
const VER = process.env.AI_RSS_NODE_VERSION ?? "v24.13.0";
const plat = `${process.platform === "win32" ? "win" : "linux"}-x64`;
const url = `https://nodejs.org/dist/${VER}/node-${VER}-${plat}.${process.platform === "win32" ? "zip" : "tar.xz"}`;

// 2. 下载到 .tmp/ → 解压到 .toolchain/node/（解压后即删压缩包，省 36MB）
// 3. 校验：运行 .toolchain/node/bin/node -v，必须等于 VER，否则删除重下
// 4. 之后所有脚本都用这个 node 启动，不再读 PATH
```

**版本固定但可覆盖**：默认锁定 `v24.13.0`（与 CI 一致），需要试新 patch 时设 `AI_RSS_NODE_VERSION`。`engines` 只写 `>=24 <25`，次要版本升级不必改代码。

**为什么不干脆用二进制部署**：源码部署的价值是「能改代码」。但它不该附带「必须先装好系统 Node」。把运行时也纳入项目目录后，两者可以并存 —— 同一份 `data/`，`./scripts/dev.sh` 与 `./ai-rss-linux-x64 serve` 随时互换。

**代价**：项目目录多约 300MB（Node 104MB + npm 缓存 200MB）。这些都在 `.gitignore` 里，删项目即清空，不残留。

### 4.4 Docker 部署

```yaml
services:
  ai-rss:
    image: ghcr.io/you/ai-rss:latest
    ports: ["3000:3000"]
    environment:
      TZ: Asia/Shanghai
      AI_BASE_URL: https://api.deepseek.com/v1
      AI_API_KEY: ${AI_API_KEY}
    volumes: ["./data:/app/data"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/app/ai-rss", "doctor", "--quiet"]
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
  --platform linux/amd64 -t ai-rss:local .
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
./ai-rss doctor --json | jq -r '.paths[]' | grep -v "^$PWD" && echo "存在项目外路径"

# 3. 删除项目目录后无残留
rm -rf /tmp/ai-rss-copy && cp -r . /tmp/ai-rss-copy && rm -rf /tmp/ai-rss-copy && echo OK
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

单进程内 `setInterval(50ms)` 轮询，按 kind 分并发：fetch 5 / extract 4 / analyze 2 / embed 4 / cluster·digest 1。`WORKER_INLINE=false` 时以 `ai-rss worker` 独立进程启动。

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

---

## 八、AI 分析（分类分级）

### 8.1 模型配置

```jsonc
// settings.ai_config
{
  "provider": "openai-compatible",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "AI_API_KEY",
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

### 11.2 API

```
GET    /entries/:id/highlights
POST   /highlights            {entry_id, quote..., color?, note?}
PATCH  /highlights/:id        {note?, color?}
DELETE /highlights/:id
GET    /highlights?cursor=&entryId=&tag=       全局列表
POST   /highlights/:id/insight                 AI 解读这段（流式）
```

### 11.3 UI 交互

- **选中即出工具条**：划词后在选区上方浮出 3~4 个图标（高亮 / 批注 / AI 解读），不弹侧栏、不跳页。
- **三种色即可**：默认黄、可选绿/蓝。不做调色盘 —— 选择过载会让人不用。
- **侧栏聚合**：列出本文所有高亮，点击滚动定位。
- **键盘**：选中后 `h` 高亮、`n` 加批注。

### 11.4 与 AI 的联动

高亮是用户**主动**表达「这段重要」的信号，比隐式阅读行为更强：

| 用途 | 做法 |
|---|---|
| 修正 importance | 把近期高亮作为 few-shot 示例注入 L3 prompt |
| 单条解读 | `POST /highlights/:id/insight`，结合上下文流式解释 |
| 简报素材 | 日报独立小节「你今天标记的要点」 |
| 高亮聚类 | 高亮向量入库，「你反复标记的主题」反哺分类权重 |
| RAG 提权 | 问答检索时含高亮的段落提权 |

---

## 十二、MCP 服务器

### 12.1 为什么做

个人 RSS 库天然适合 MCP：它是每天的信息输入，接进 Claude / Cursor 后能做「帮我总结本周关于芯片的报道」「我最近标记的高亮有什么共同点」。

### 12.2 实现

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "ai-rss", version: "1.0.0" });

server.tool("search_entries", { query: z.string(), since: z.string().optional(), limit: z.number().default(10) },
  async ({ query, since, limit }) => ({ content: [{ type: "text", text: await searchEntries(query, since, limit) }] }));
```

**双传输**：

| 传输 | 用途 | 配置 |
|---|---|---|
| **stdio** | Claude Desktop / Cursor 本地接入 | `command: "./ai-rss", args: ["mcp"]` |
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
./ai-rss export --out ./export-20261023.tar.zst
#  含 app.db（已 VACUUM）+ files/ + manifest.json（版本、schema 版本、条目数）

# 新机器导入（任意部署方式）
./ai-rss import ./export-20261023.tar.zst
#  校验 schema 版本 → 必要时迁移 → 恢复 files → 重建索引
```

导入时若包内 schema 版本更新（降级），**明确拒绝并提示**，不半途损坏。

### 13.5 内容导出

```bash
./ai-rss export --format markdown   # 每人一个 .md + 图片目录 + index.json
./ai-rss export --format jsonl
./ai-rss export --format opml       # 仅订阅源
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

- **正文最大宽度 72 字符** —— 可读性硬指标，宽屏铺满会明显降低阅读速度。
- **AI 摘要卡默认展开但可折叠** —— 既想快速判断也想读原文。
- **高亮工具条随选区浮动** —— 不常驻、不遮挡。

**72ch 的两个实现陷阱**（M0 实测）：

1. `ch` 是**相对当前元素字号**的单位。若 `max-width:72ch` 加在 15px 的容器上、而正文是 16.5px，实际只有约 66 个正文字符宽 —— 少 8%。
2. 默认 `box-sizing: border-box` 下，`padding: 34px 28px` 会吃掉 72ch 里的 56px。必须给阅读容器设 `content-box`，让 72ch 约束的是文字列宽。

验收脚本用「同字号渲染一个 72ch 探针再比宽度」来断言，而不是读 `getComputedStyle().maxWidth` —— 后者在 `ch` 单位下返回解析后的 px，看着是 582px 但报"等于 72ch"会假绿。

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
| 左侧栏 218px | 底部 tab bar（5 项） | 390px 宽下侧栏吃掉 56% 的宽度 |
| 三栏并排 | 列表 / 阅读互斥，点开是浮层 | 三栏在 390px 下每栏不到 130px，不可读 |
| hover 出操作 | 操作常驻 | 触摸没有 hover，藏起来就等于不存在 |

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
| 未分组 | 侧栏仍无入口；代码按 `folderId=none` 通用处理，将来加入时无需改渲染 |

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

**不做的三件事**（写下来是为了下次不重开讨论）：

1. **不给正文放宽 72ch**。留白是 72ch 的必然结果，不是浪费；放宽到 80ch 会明显降低阅读速度（§15.3）。
2. **不做侧栏折叠按钮**。折叠后分组树消失，而分组树正是 v1.13 的核心；为多 196px 而牺牲一个功能入口，是拿功能换数字。
3. **不把列表栏做成可拖拽**。可拖拽宽度需要持久化位置 + 重置入口 + 边界夹取，三项加起来比"窄 32px"的收益大得多。真到需要时按 A.1.1 提需求。

**窄屏阈值必须跟着下限走**：列表栏 368px + 侧栏 196px = 564px，加上阅读区的最小可用宽（72ch ≈ 594px）
共需 1158px —— 所以 `<1200px` 时把阅读区收窄到 100% 并允许列表栏吃掉多余宽度，
否则 1180px 的笔记本上会出现"正文被压到 60ch 以下"。这条由 `m1-19-density` 在 1180px 与 1440px 两个视口断言。

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
  AI_RSS_NODE_VERSION: v24.13.0

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
          VER="${{ env.AI_RSS_NODE_VERSION }}"
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
            --out dist/ai-rss-${{ matrix.target }}
      - name: 冒烟测试（linux）
        if: matrix.target == 'linux-x64'
        run: |
          chmod +x dist/ai-rss-linux-x64
          ./dist/ai-rss-linux-x64 version
          ./dist/ai-rss-linux-x64 migrate --data .tmp/t
          ./dist/ai-rss-linux-x64 serve --data .tmp/t --port 3111 &
          sleep 3
          curl -fsS localhost:3111/api/health
          curl -fsS localhost:3111/ | grep -q 'id="root"'   # 静态资源内嵌校验
          ./dist/ai-rss-linux-x64 doctor --data .tmp/t
      - uses: actions/upload-artifact@v4
        with: { name: bin-${{ matrix.target }}, path: "dist/ai-rss-${{ matrix.target }}*" }

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
COPY --from=build /app/dist/ai-rss-linux-x64 /app/ai-rss
ENV DATA_DIR=/app/data PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD ["/app/ai-rss", "doctor", "--quiet"]
ENTRYPOINT ["/app/ai-rss"]
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

```
ai-rss/
├─ .toolchain/node/               # 项目内 Node 24 + npm（bootstrap 下载，gitignored）
├─ .cache/{npm,docker}/           # npm 与 docker 构建缓存（gitignored）
├─ .tmp/                          # 构建临时目录（gitignored）
├─ .npmrc                         # cache=./.cache/npm（prefix 不能写，见 §4.3）
├─ scripts/
│  ├─ bootstrap.mjs               # 下载并解压 .toolchain/node
│  ├─ dev.sh  build.sh            # 统一用 .toolchain/node/bin/node 启动
│  ├─ build-server.mjs            # esbuild → dist/server.js
│  ├─ build-sea.mjs               # bundle + postject/--build-sea
│  ├─ pack-client-zip.mjs         # dist/client → dist/client.zip
│  ├─ lib/proc.mjs                # killTree / onExit（验收脚本的子进程收尾）
│  └─ verify/                     # 每步一个验收脚本 + harness.mjs
├─ src/
│  ├─ index.ts                    # 单一入口：serve|worker|migrate|doctor|version|mcp|export|import
│  ├─ cli.ts                      # 子命令实现
│  ├─ server/
│  │  ├─ app.ts                   # Hono 装配
│  │  ├─ routes/{feeds,entries,categories,clusters,digests,search,chat,settings,stats,highlights,rsshub,page}.ts
│  │  ├─ rsshub/{library,index}.ts  # 路由模板 / 三层缓存 + 搜索 + 试订阅
│  │  ├─ middleware/{auth,error,logger}.ts
│  │  ├─ db/{schema.ts,client.ts,migrate.ts,adapter.ts}   # adapter = 可换驱动的那层
│  │  ├─ db/migrations/*.sql
│  │  ├─ services/{feed,entry,digest,search,stats,highlight,rsshub,backup}.ts
│  │  ├─ ai/{client,schemas,analyze,embed,cluster,digest,rag,vector}.ts
│  │  ├─ mcp/server.ts
│  │  ├─ extract/{article,run}.ts  # 正文提取（Readability）与落库
│  │  ├─ dedupe/{url,cosine,index,types}.ts  # URL 规范化 / 向量 / 三层判重
│  │  ├─ entries/history.ts       # 阅读历史的时间分桶与分组
│  │  ├─ jobs/{runner,handlers,queue}.ts
│  │  ├─ auth/require-user.ts     # 多人预留的唯一开关点
│  │  └─ compat/huntly/           # 插件兼容层（§14）
│  ├─ embed-static.ts             # 静态资源/迁移/提示词的导入清单
│  └─ client/                     # React SPA
│     ├─ routes/{inbox,digest,highlights,feeds,settings,search}/
│     ├─ components/{reader,highlight,rsshub-search}/
│     └─ lib/api.ts
├─ packages/prompts/*.md          # 带 version 头
├─ Dockerfile
├─ docker-compose.yml
├─ .github/workflows/{ci,release,nightly}.yml
└─ data/                          # 唯一状态：app.db, files/, config.json, backups/
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

每一步配一个 `verify` 脚本（`scripts/verify/<step>.mjs`），也可用 `ai-rss verify <step>` 调起。它**只做断言、不做修复**，输出：

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

### 19.2 M0：骨架（5~6 天，拆成 9 步）

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
| 0.9 | 界面（v1.1 新增） | 三栏布局、`icons.tsx`、`styles.css` | `m0-09-ui.mjs` | ① 三栏并存且不重叠 ② 列表项 70~130px、一屏 8~10 条 ③ 正文列宽 = 72ch（实测）④ 默认暗色 ⑤ 空态有引导 ⑥ `/` `Esc` `j` 键盘可用 ⑦ 窄屏阅读区浮层化 |

**M0 门禁**：`scripts/verify-all.mjs` 依次跑完 10 项（0.1~0.9 + `docker-path`）、全绿才进 M1。任何一项红都不能跳过 —— 这些是地基，跳过会在 M2 以后以「奇怪 bug」的形式回来。

判据是**累积**的：跑到 0.5 时，0.1~0.5 五项过了就算这一步完成，0.6~0.9 仍应报红（它们还没实现）。这正是「先失败再通过」的意义：**每次新增一步，只应让对应的那项从红转绿，其余项状态不变**。如果 0.6 实现完 0.3 反而红了，说明引入了回归。

**0.9 的定位**：它是唯一一项**用真实浏览器验"看起来对不对"**的验收。为什么必须有它：0.1~0.8 全是行为断言（状态码、字节数、耗时），一个布局错乱、正文只有 66 字符宽、或者点开条目就跳页的界面能让 9/9 全绿。这正是实际情况 —— 补上 0.9 之后立刻抓到两个真问题（列表 148px 一屏只 4 条、72ch 实测 582px）。

没有 Chromium 系浏览器的机器上 0.9 整节 SKIP（退出 0），不算失败 —— 环境缺失不是实现问题。但它 SKIP 时必须在汇总里看得见，不能静默通过。

### 19.3 M1：阅读 + RSSHub（3.5~4 周，17 步）

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
| 1.12 | 收件箱阅读控制（v1.9） | `m1-12-inbox-view.mjs` | ① 标题行右侧有「全部/未读」分段控件，点「未读」后列表只剩未读 ② 点「全部」回到全量且**已读条目仍在**（只是变灰）③ 刷新按钮点击后重新请求且保留 view/分组/源/搜索 ④ 刷新期间列表条数不归零（`items.length` 不出现中途 0）⑤ 侧栏「未读」与分段控件同一份状态（点一处另一处同步，不会两处高亮不同）⑥ 已收藏行只有一颗星（`star-mark` 已删除，星星就是那个可点按钮）⑦ 375px 视口下标题行无横向溢出 |
| 1.13 | 配置中心（v1.9，v1.13 删除侧栏入口） | `m1-13-settings.mjs` | ⓪ 侧栏 `.nav-section` 里不再有「订阅源」标题、不再有任何含「订阅」的按钮，配置入口只剩齿轮 1 个（v1.13：需求「删除主页的订阅源按钮」）① 侧栏齿轮打开配置弹窗并停在订阅分类（不再切独立页）② 六个分类都在，M2/M3/M6 三个标「待接入」且点开有 ≥3 条清单 ③ 分类切换不重挂：**先在添加面板写入半截 URL**，切走再切回值还在 ④ 遮罩挡住背后点击（`elementFromPoint` 落在弹窗内）⑤ `Esc` 能关且 DOM 真的移除；重开不记住上次分类（关窗前先切到分组做前置）⑥ 分组筛选：`folders>=3` 用 `<select>`、`<=2` 用 chip，删一个组掉到 2 时自动换回 chip ⑦ 下拉选「未分组」只显示 `folderId` 为 null 的源，选回「全部」5 个源都回来 ⑧ 分组页能改名、删组有确认框且说明"订阅退回未分组"，删完订阅页源数不变、未分组 +1 ⑨ 关闭弹窗后侧栏分组列表同步（改名生效、删掉的消失）⑩ 手机上弹窗铺满视口、分类栏横向可滚、分类项 ≥36px、无横向溢出；底部导航最后一格是「配置」且能打开弹窗 |
| 1.14 | 正文提取（Readability 兜底） | `m1-14-extract.mjs` | ① 5 个真实站点（离线夹具）提出正文 ≥ 参照容器 60%，且不含 `script`/`onerror` ② 提取失败（404 / 非 HTML）回退 feed 内 HTML，**条目仍在且不卡 pending** ③ 触发条件生效：feed 正文 ≥ 500 字时**一次网络请求都不发**，且**不排进 extract 队列** ④ 提出内容不到 `max(500, feed×1.2)` 时不替换（认错节点时保留可读内容）⑤ 落库字段齐：`extracted_by`/`stage`/`stage_error`/`word_count` ⑥ 没有 `<body>` 的页面不抛异常且能提出正文 ⑦ 重复入队不重复抓、不覆盖已有结果 ⑧ 20 条短摘要并发提取全部 `extracted`，成功率 100% |
| 1.15 | 去重（向量层） | `m1-15-dedupe.mjs` | ① 同 URL 不同 utm 参数判重（含 fbclid/gclid/spm/ref/share_*，且 `?p=`/`?id=` 等语义参数保留、不同文章不被误合并）② 余弦 >0.95 判重：逐字相同 + 四种转载变体（标题加站名 / 加版权声明 / 加导语 / 改开头一句）全部命中，不同事件余弦 <0.3 ③ 混入 20 条重复后重复率 <1%（3000 条基数）④ 三层短路：URL 命中不再算向量、不重复写库 ⑤ 重复条目不进时间线、`duplicate_of` 指回原件、`includeDuplicates=1` 可查 ⑥ 向量维度 256 / 字节 = dim×4 / model=`local-hash-v1`，坏 BLOB 不抛 ⑦ 提取到全文后向量随之更新（否则摘要型源永远漏判）⑧ 超短正文不写向量 |
| 1.16 | 列表/阅读/历史 API | `m1-16-ui-api.mjs` | ① 游标分页不重复不漏（250 条含 120 条**同一毫秒**，按 id 打破平局；游标只按第一个下划线切，否则 `e_1a2b…` 被截成 `'e'`，同毫秒整批跳过）② `POST /read` 两次 → `read_count=2`，且 `first_read_at` 不被覆盖、`last_read_at` 前进；标未读不清阅读历史 ③ 历史按**本地日历日**分四桶（今天/昨天/本周/更早），边界值 00:00:00 与 23:59:59 逐个断言；跨月跨年不误判；`groupByDay` 跳过空桶 ④ `total` 用不含游标的条件算（翻页时不缩小）⑤ 界面：分组标题渲染且有粘性、行内时间是 `readAt` 而非 `publishedAt`（数据里两者刻意差 5 天）、`read_count>1` 才有 ×N 角标 ⑥ 畸形游标/负数 limit 不 500、超大 limit 夹到 100 |
| 1.17 | RSSHub 搜索 | `m1-17-rsshub.mjs` | ① 关键词搜到路由：中文按 namespace 中文名（「哔哩哔哩」）、英文按 namespace（zhihu）、按路径（hotlist）都能命中；搜不到返回空数组而非 500 ② URL 反查命中且命名空间与域名匹配（不是把整段 URL 当关键词搜）、未知域名返回空 ③ 试订阅预览 ≥1 条且 ≤5 条、内容带路径指纹（证明请求真的发到了拼出的地址）、返回完整可订阅地址、404 路径给明确错误 ④ 断网后关键词与 URL 反查都仍可用，且结果与联网**完全一致**（缓存被真的用上）；缓存 7 天后标 `stale` 但仍可搜；两个上游一半过期也报 stale（`fetchedAt` 取较早那个）⑤ 闭环：预览地址能直接订阅成功、落库 URL 一致 ⑥ 界面：面板挂在「添加订阅」里、关键词列出候选、选中后按模板生成参数输入框（`:uid` → uid 输入框、用 example 预填）、**没预览不出现「订阅这个地址」**、预览后出现条目+订阅+外链 |
| 1.18 | 侧栏分组树（v1.13） | `m1-18-sidebar-tree.mjs` | ① 侧栏每个分组行可展开，展开后列出组内全部源并显示各自未读数 ② 组内 11 个源时列表头部**没有任何筛选行**（chip 行已删除），列表一屏条数与无分组时相同 ③ 点组内某个源 → 列表只剩该源条目、标题为「组名 · 源名」、只有该子行高亮 ④ 再点同一子行 → 回整组，组行高亮 ⑤ 点另一个组 → 前一个组收起、新组自动展开、源筛选清空 ⑥ 组内 1 个源仍可展开；组内 0 个源不渲染子节点 ⑦ 点固定视图（收件箱/未读/收藏/历史）→ 分组与源筛选清空且树全部收起 ⑧ 源被移出组 → 自动退回整组且分组保留（沿用 1.11 ⑥）⑨ 源筛选 + 搜索叠加生效 ⑩ 树自身滚动，不把侧栏撑破（700px 高的视口下收件箱仍可点到） |
| 1.19 | 三栏密度收敛（v1.13） | `m1-19-density.mjs` | ① 1440px 下侧栏 196px、列表 368px、阅读区 ≥870px（三个数各自断言，不是"变小了"）② 阅读区正文仍是 72ch（收窄基座不许动正文宽度）③ 1180px 下正文列宽 ≥ 594px（不被压到 72ch 以下）④ 组内有源时列表头部高度与无分组时**完全相等**（chip 行不占位）⑤ 侧栏最长分组名能完整显示或走省略号，不压在角标上 ⑥ 1440×960 下首屏条目数 ≥ 9 ⑦ 手机上 `--sidebar-w` 仍是 0、底部 tab bar 仍在（收窄不许把移动端规则带歪） |

**已完成**：1.1~1.19（含 0.9 三栏 UI、移动端、订阅分组与编辑、一键批量管理、
阅读页交互、控件形状尺度、分组内查看订阅源、收件箱阅读控制、配置中心、正文提取、
去重、列表/阅读/历史 API、RSSHub 搜索、侧栏分组树、三栏密度收敛）。**M1 全部步骤完成**。

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


**M1 门禁**：`m1` 全绿 + **50 个真实源连跑 3 天无崩溃**（脚本跑不了，必须真跑）。

**1.1~1.4 拆分的理由**：原计划把"feed CRUD + OPML"放成一步（1.1）。落地时发现解析、OPML、清洗、抓取四件事各自有独立的失败模式，混在一步里任何一个红都定位不到根因。拆开后每一步都能单独跑、单独红、单独修。

### 19.4 M2：AI 分析（1~1.5 周，5 步）

| # | 步骤 | 自验证 | 通过判据 |
|---|---|---|---|
| 2.1 | AI 客户端 + 结构化输出 | `m2-01-ai-client.mjs` | ① mock 返回裸文本/围栏 JSON/合法 JSON 三种都能解析 ② zod 失败自动重试一次 ③ 二次失败进死信不阻塞队列 |
| 2.2 | 单篇分析流水线 | `m2-02-analyze.mjs` | ① 20 篇真实文章全产出摘要 ② 缺字段 → `stage=failed` 且 `stage_error` 可读 ③ 重跑不重复计费 |
| 2.3 | 受控分类 + tier | `m2-03-classify.mjs` | ① slug 不在列表 → 判 `other` ② tier 边界正确（39/40/69/70/89/90） |
| 2.4 | Embedding | `m2-04-embed.mjs` | ① 维度 = 配置值 ② BLOB 字节 = dim×4 ③ 1000 条余弦 < 20ms |
| 2.5 | 成本审计 + 预算闸门 | `m2-05-budget.mjs` | ① 每次调用都有 `ai_usage` 记录 ② 设 `dailyUsd=0.001` 超限后降 `fast_only` ③ 再超则停止且 UI 可见 |

**M2 门禁**：`m2` 全绿 + **黄金测试集 20~30 篇，摘要准确率 ≥85%、分类 ≥80%**（人工标注一次作为回归基线）。

### 19.5 M3：每日简报（1.5 周，4 步）

| # | 步骤 | 自验证 | 通过判据 |
|---|---|---|---|
| 3.1 | 聚类 | `m3-01-cluster.mjs` | ① 100 条同事件样本聚成 ≤3 簇 ② 不同事件不误聚 ③ 100 条 < 1s |
| 3.2 | 簇级归纳 | `m3-02-cluster-summary.mjs` | ① 输出含 `consensus`/`conflicts` ② 单来源簇标注「单一来源」③ 输入 3 篇时 `conflicts` 为空而非编造 |
| 3.3 | 简报生成 | `m3-03-digest.mjs` | ① `{{cite:id}}` 全被替换为真实链接 ② **无一处 URL 是模型编造**（逐条校验存在于库中）③ 同窗重跑不重复 |
| 3.4 | 定时推送 | `m3-04-schedule.mjs` | ① 改时间到 08:00 触发一次 ② 失败重试且不重复推 ③ 无新内容不发空简报 |

**M3 门禁**：`m3` 全绿 + **连跑 3 天，人工评估误聚 < 10%**。

### 19.6 M4~M8

| 阶段 | 关键步骤 | 自验证判据 |
|---|---|---|
| **M4 高亮**（1~1.5 周） | 三选择器存储 → 锚定恢复 → 降级链 → UI 工具条 | ① 改提取器后旧高亮仍能定位 ② 破坏 `position` 靠 `quote` 找回 ③ 再破坏 `quote` 靠 `range` 找回 ④ 全失败标 `orphaned` 且列表可见（**不静默丢**） |
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
| 3 AI 分类分级 | 2.1 / 2.2 / 2.3 | `m2-01` `m2-02` `m2-03` | `verify/m2` |
| 4 每日简报 | 3.1 / 3.2 / 3.3 / 3.4 | `m3-01`~`m3-04` | `verify/m3` |
| 5 高亮 | M4（4 步） | `m4-01`~`m4-04` | `verify/m4` |
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
| 约束：三路部署 | 0.8 | `m0-08` | `verify/m0` |
| 约束：环境隔离 | 0.1 / 0.8 | `m0-01` `m0-08` | `verify/m0` |
| 约束：多人预留 | 0.5 | `m0-05` | `verify/m0` |

**十项需求里，只有第 10 项（插件兼容）的最终验收不完全靠脚本** —— 它必须用官方原版插件真人操作一次。这是本文档唯一承认「脚本无法覆盖」的地方，因此在门禁里单列，不混进 `verify` 的自动判定。

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

### 19.9 工期汇总

| 阶段 | 步数 | 工期 | 累计 |
|---|---|---|---|
| M0 | 9 | 5~6 天 | 5~6 天 |
| M1 | 17 | 3.5~4 周 | 4.5~5 周 || M2 | 5 | 1~1.5 周 | 5.5~6.5 周 |
| M3 | 4 | 1.5 周 | 7~8 周 |
| M4 高亮 | 4 | 1~1.5 周 | 8~9.5 周 |
| M5 检索+MCP | 3 | 1~1.5 周 | 9~11 周 |
| M6 备份 | 3 | 1 周 | 10~12 周 |
| M7 插件 | 2 | 1~1.5 周 | 11~13.5 周 |
| M8 打磨 | 3 | 1 周 | **12~14.5 周** |
| **合计** | **50 步** | | |

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
[✓] ai-rss doctor 输出完整自检
[ ] /api/page/save + /api/page/pageOperateResult（兼容层 A 起点，留给 M7）
```

**实施中确认的两个事实**（写回文档，避免以后重新踩）：

1. **SEA 的 main 必须打成 CJS**。用 ESM bundle 会直接报
   `Cannot use import statement outside a module` —— SEA 用
   `embedderRunCjs` 执行入口。CJS 下没有 `import.meta`，
   需要 banner 注入 shim 或改用 `__dirname`。
2. **跨平台产出必须有目标平台的 node 作为注入底本**。
   `build-sea.mjs` 默认用 `process.execPath`，从 Windows 造 linux 产物
   时会产出一个跑不起来的文件。已加 `--target` + `AI_RSS_SEA_BASE`：
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


