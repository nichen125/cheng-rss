# AI RSS

自托管的 RSS 阅读与 AI 分析工具。阅读体验对齐 Huntly，并在此之上提供自动化的
分类分级、每日简报、跨篇聚合。支持二进制 / 源码 / Docker 三种部署，一个数据目录
即可备份迁移。

> **当前状态：M0 完成**（骨架 + 三路部署 + 认证 + 队列 + 检索 + 首版 UI）。
> 按 [PLAN.md](PLAN.md) 的 38 个步骤，已完成前 8 步。订阅抓取、AI 分析、简报
> 在 M1~M3 落地。

---

## 快速开始

### 方式 A：源码运行（开发推荐）

需要先有 Node 24。**所有依赖与工具链都装在项目目录内**，不污染系统。

```bash
git clone <repo> && cd ai-rss

# Linux / macOS
./scripts/bootstrap.sh      # 下载项目内 Node 24（约 34MB，只需一次）
./scripts/build.sh          # 构建前端 + 服务端
./.toolchain/node/bin/node --experimental-strip-types src/index.ts serve --data ./data

# Windows PowerShell
.\scripts\bootstrap.ps1
.\scripts\build.ps1
.\.toolchain\node\node.exe --experimental-strip-types src\index.ts serve --data .\data
```

打开 http://127.0.0.1:3000 ，首次访问会引导创建管理员账号。

### 方式 B：单文件二进制

```bash
./scripts/build.sh --sea               # 产出 dist/ai-rss-<platform>-<arch>[.exe]
./dist/ai-rss-linux-x64 serve --data ./data --port 3000
```

二进制内嵌了全部前端资源，**不需要旁边的 dist 目录**，复制单个文件即可运行。

### 方式 C：Docker

```bash
docker compose up -d
# 或
docker build -t ai-rss . && docker run -d -p 3000:3000 -v ./data:/app/data ai-rss
```

---

## 数据目录

```
data/
├─ app.db          # 全部结构化数据（SQLite）
├─ config.json     # 配置（API key 从环境变量读，不写这里）
├─ files/          # 图片等附件（M1 起使用）
└─ backups/        # 自动快照（M6 起使用）
```

**只有 `data/` 需要备份**，其余全部可重建。用 `VACUUM INTO` 而非 `cp app.db`
（WAL 模式下直接复制会得到损坏副本）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` / `--data` | `./data` | 数据目录 |
| `PORT` / `--port` | `3000` | 监听端口 |
| `HOST` / `--host` | `127.0.0.1` | 监听地址，Docker 里用 `0.0.0.0` |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `AI_API_KEY` | — | 模型 key（M2 起使用） |
| `AI_RSS_HTTPS=1` | — | 走 https 时设，才会给 cookie 加 `Secure` |
| `WORKER_INLINE=false` | — | 把 job runner 拆成独立进程 |

---

## 子命令

```bash
ai-rss serve      # 启动服务（含内联 job runner）
ai-rss migrate    # 建库 / 升级 schema
ai-rss doctor     # 自检：目录、schema、WAL、完整性、备份、正文占比
ai-rss version
ai-rss worker     # 只跑队列（配合 WORKER_INLINE=false）
ai-rss mcp        # MCP over stdio（M5）
ai-rss export     # 导出（M6）
ai-rss import     # 导入（M6）
```

---

## 添加订阅

启动后打开 UI → 侧栏「订阅」→「+ 添加订阅」，贴任何地址都行：

| 你贴的 | 会发生什么 |
|---|---|
| 完整 feed URL（`https://x.com/feed.xml`） | 直接订阅 |
| 网站首页（`https://sspai.com`） | 从页面 `<link rel="alternate">` 找订阅地址 |
| 裸域名（`sspai.com`） | 补 `https://` 再按首页处理 |
| 一段带 URL 的文字 | 抠出第一个 URL |
| 找不到 `<link>` 的站点 | 探测 `/feed` `/rss` `/atom.xml` 等 14 个常见路径 |

发现到**多个** feed 时会让用户选，不替他挑。订阅前会先真抓一次 ——
拉不到内容的源不会进列表，所以"订阅成功但空的"不会发生。

也可以导入别的阅读器导出的 OPML（文件夹层级会保留），或导出自己的订阅。

### 抓取行为

| 行为 | 值 | 说明 |
|---|---|---|
| 默认间隔 | 30 分钟 | 添加后可改，最小 5 分钟 |
| 条件请求 | ETag / Last-Modified | 304 时不重复入库，也不消耗解析 |
| 失败退避 | 间隔 × (1 + 失败数×2)，最多 7 倍 | 成功一次即复位 |
| 置 `broken` | 连续 3 次失败，或 404/410 | 不再自动重试，UI 标「失效」 |
| 取消订阅 | 未读条目删除；**已读/已收藏保留** | 历史记录不该因为退订而消失 |

正文在入库前过白名单清洗（`feeds/sanitize.ts`），读出来时再洗一次 ——
feed 是外部输入，`<script>`、`onerror`、`javascript:` 都必须拦掉。

---

## 兼容 Huntly 浏览器插件

在官方 Huntly 插件的设置里把服务器地址改成 `http://<你的地址>:3000`，即可用：
连接、保存网页、查看已保存角标、收藏。

不需要改插件代码。已实现的核心端点：

```
GET  /api/auth/loginUserInfo     未登录返回 200 + null（不是 401）
POST /api/auth/login             返回裸用户对象 + Set-Cookie
GET  /api/auth/checkUserExist
```

其余端点（归档、稍后读、集合、黑名单）在 M7 补完。

> 注意：这是逆向出的兼容层，无官方契约。Huntly 改字段就会断，需要靠 HAR 契约
> 测试发现（M7）。

---

## 开发

```bash
# 前端热重载（另开一个终端跑后端）
./.toolchain/node/bin/node node_modules/vite/bin/vite.js

# 类型检查
./.toolchain/node/npx tsc --noEmit

# 跑某一步的验收
./.toolchain/node/node scripts/verify/m0-02-schema.mjs
```

### 验收机制

每一步都有对应的验收脚本，只做断言不做修复。**一键跑全部**：

```bash
node scripts/verify-all.mjs
```

输出汇总：

```
验收汇总  16 个脚本，耗时 47s
  PASS  docker-path.mjs            3.8s
  PASS  m0-01-toolchain.mjs        1.3s
  ...
  PASS  m0-09-ui.mjs               11.1s
  PASS  m1-01-feed-parse.mjs       0.4s
  ...
  PASS  m1-05-mobile.mjs           9.3s
  PASS  m1-06-feeds-ui.mjs         7.0s
全部通过 16/16
```

单独跑某一步：

```bash
node scripts/verify/m0-02-schema.mjs
node scripts/verify/m0-07-search.mjs     # 含 10 万条性能红线
node scripts/verify/m0-09-ui.mjs         # 真实浏览器验布局（需 Chromium 系浏览器）
```

| 脚本 | 断言数 | 验什么 |
|---|---|---|
| `m0-01-toolchain` | 11 | 项目内 Node、npm 缓存位置、gitignore 真生效 |
| `m0-02-schema` | 13 | 19 张表、迁移幂等、FTS 可用、关键列 |
| `m0-03-db` | 14 | PRAGMA、1 万条写入、并发写、gzip 往返（含旧裸 gzip 兼容） |
| `m0-04-server` | 23 | 子命令、health/needsSetup、401/404 契约、鉴权优先级、详情正文可读 |
| `m0-05-auth` | 25 | cookie 属性、`loginUserInfo` 返回 200+null、改密失效 |
| `m0-06-jobs` | 14 | 认领原子性（跨进程）、幂等、退避、死信、僵死恢复 |
| `m0-07-search` | 22 | bigram 切分、索引更新、10 万条四条性能红线 |
| `m0-08-deploy` | 18 | 二进制内嵌资源、内嵌前端非陈旧、三路互换、插件端点 |
| `m0-09-ui` | 25 | 三栏布局、列表密度、72ch 实测、默认暗色、键盘、窄屏 |
| `m1-01-feed-parse` | 34 | RSS2.0 / Atom / RDF 解析、content:encoded 优先、坏日期钳制 |
| `m1-02-opml` | 16 | 文件夹层级、导出导入往返、属性大小写容错 |
| `m1-03-sanitize` | 30 | XSS 白名单：script/iframe/svg/onerror/javascript: 全拦 |
| `m1-04-feeds` | 47 | 订阅/发现/条件请求 304/404 置 broken/删订阅保留已读/清洗落库 |
| `m1-05-mobile` | 28 | 底部 tab bar、触摸目标 44px、字号 16px、安全区、横屏 |
| `m1-06-feeds-ui` | 25 | 30+ 源行高一致、长标题截断、操作不越界、头部吸顶、手机操作可点 |
| `docker-path` | 12 | Dockerfile 结构 + 真产出 linux ELF |

**写新断言前先跑一次确认它会红** —— 永远绿的断言没有价值。

#### 关于 `m0-09-ui` 的浏览器依赖

它用本机 Edge/Chrome 的**无头模式 + 裸 CDP** 验布局，不下载 playwright。
找不到 Chromium 系浏览器时整节 SKIP（退出 0）并打印说明 —— 环境缺失不算失败，
但 SKIP 会在汇总里看得见，不会静默通过。

为什么需要它：其余脚本全是行为断言（状态码、字节数、耗时），一个布局错乱、
正文只有 66 字符宽、或者点开条目就跳页的界面能让 9/9 全绿。

#### 关于 `docker-path` 的产物验证

它需要一份 **linux 版 node** 作为 SEA 的注入底本（约 25MB），用来验证
Dockerfile 里 `build-sea` 那一步真能产出能跑的 ELF。首次运行：

```bash
node scripts/fetch-linux-node.mjs      # 一次，之后走 .tmp/linuxnode 缓存
node scripts/verify-all.mjs            # 这时 docker-path 是 12/12
```

**没有这份 node 时，`docker-path` 会报 FAIL 而不是假装通过** ——
"没验证"和"验证通过"是两件事。离线环境可显式接受跳过：

```bash
node scripts/verify-all.mjs --allow-skip-docker-artifact
```

此时会明确提示"这不等于构建路径已验证"。

### 跨平台构建

SEA 的注入底本必须是目标平台的 node 可执行体。所以：

```bash
# 在 Windows 上造 Windows 产物（默认）
node scripts/build-sea.mjs

# 在 Windows 上造 Linux 产物：需要一份 linux 的 node
AI_RSS_SEA_BASE=./vendor/node-linux-x64 \
  node scripts/build-sea.mjs --target linux-x64

# 不提供底本时会明确拒绝，而不是产出一个跑不起来的文件
node scripts/build-sea.mjs --target linux-x64
# ✗ 不能从 win32-x64 造 linux-x64 的二进制。
```

Docker 构建天然满足这一点（容器里跑的就是 linux node），所以 `Dockerfile` 里
直接写 `--target linux-x64`。

---

## 技术选型要点

| 选择 | 原因 |
|---|---|
| Node 24 LTS（非 Bun） | `node:sqlite` 内置、SEA 单二进制、LTS 承诺 |
| `node:sqlite` + Drizzle `1.0.0-rc.5` | 无原生插件；**0.45.x 没有 `node-sqlite` 驱动** |
| Hono（非 Next.js） | 纯 Request→Response，可打成单文件 |
| FTS5 + 程序侧 bigram | `trigram` 查不到 2 字中文（实测返回 0 条） |
| 正文 gzip BLOB | 实测压缩 2.6×，占全库体积 84% 的部分必须压 |
| SEA + `assets` + fflate | Node 24 的 SEA **没有** `vfsArchive`（Node 26 才有） |

详细依据见 [PLAN.md](PLAN.md) 第三章。

---

## 已知限制

- **SEA 不支持 Alpine（musl）**：Docker 用 `debian:bookworm-slim`
- **不发布 macOS 二进制**：SEA 官方只测 arm64
- **Docker 镜像未在真机上构建过**：开发机没装 docker。Dockerfile 的每条指令已
  本地逐条验证（`scripts/verify/docker-path.mjs`），并且**真的产出了能内嵌资源的
  linux-x64 ELF**，但 `docker build` 本身没跑过。首次在有 docker 的机器上构建时
  请留意：若失败，最可能的原因是 `package-lock.json` 与容器内 npm 版本差异。
- **订阅已可用**：RSS 2.0 / Atom / RDF、OPML 导入导出、自动发现地址、定时抓取、条件请求
- **AI 分析仍待 M2**：「AI 摘要」卡片目前只在演示数据里出现，真实抓取的条目没有分析结果
- **正文提取是简化版**：feed 自带全文就直接清洗入库；只有摘要时**不会**去抓原网页跑 Readability，
  这项在 M1 后续步骤补齐（`m1-06-extract`）
- **去重只有 URL 与标题指纹两层**，向量余弦判重在 M1 后续步骤（`m1-07-dedupe`）
- 侧栏的「简报」标灰注明"待接入"，点了不会有反应（不是 bug，是明确标注的未实现）

### 想先看界面上手

订阅功能已可用，最直接的方式是启动后贴一个真实 feed 地址。想先看效果也可以灌演示数据：

```bash
# 先启动一次让库建好，完成初始化
./ai-rss serve --data ./data

# 另一个终端灌 4 条演示数据（四种 tier 各一条，带正文与 AI 卡片）
node scripts/seed-demo.mjs --data ./data
```

重复执行会覆盖同一批，不累积。想截图留档：

```bash
# 桌面（1440×960）：登录页、列表、阅读页、搜索、浅色主题、窄屏
node scripts/shot-ui.mjs --base http://127.0.0.1:3000

# 移动端（iPhone 14 Pro 逻辑尺寸 + 真实安全区）：列表、阅读、订阅页、横屏
node scripts/shot-mobile.mjs --base http://127.0.0.1:3000
```

两者都输出到 `.tmp/shots*/`，用本机 Edge/Chrome 的无头模式，不下载 playwright。

### Docker 验证到哪一步了

| 环节 | 状态 |
|---|---|
| Dockerfile 语法与结构（多阶段、非 alpine、非 root、缓存挂载） | ✅ 脚本断言 |
| 构建阶段的四条命令能跑通 | ✅ 本地实跑 |
| 产出 linux-x64 ELF 且内嵌迁移 SQL | ✅ 实跑（`AI_RSS_SEA_BASE` 指 linux node） |
| `docker build` 真的构建出镜像 | ❌ 未验证（无 docker） |
| 容器内首页 200 + `/api/health` | ❌ 未验证（CI 里有这两步） |

`.github/workflows/ci.yml` 的 `docker` job 会在有 docker 的 runner 上补上最后两项。

---

## 许可

（待定）
