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

每一步都有对应的验收脚本，只做断言不做修复：

```bash
node scripts/verify/m0-01-toolchain.mjs    # 11 项
node scripts/verify/m0-02-schema.mjs       # 13 项
node scripts/verify/m0-03-db.mjs           # 13 项
node scripts/verify/m0-04-server.mjs       # 18 项
node scripts/verify/m0-05-auth.mjs         # 25 项
node scripts/verify/m0-06-jobs.mjs         # 14 项
node scripts/verify/m0-07-search.mjs       # 22 项
node scripts/verify/m0-08-deploy.mjs       # 17 项
```

**写新断言前先跑一次确认它会红** —— 永远绿的断言没有价值。

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
- **Docker 镜像未在本机验证**：当前开发环境没有 docker，Dockerfile 已提供但
  需在有 docker 的机器上跑一遍
- M0 只做了读取链路，**订阅抓取与 AI 分析在 M1/M2**

---

## 许可

（待定）
