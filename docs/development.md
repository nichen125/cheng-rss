# 开发

## 环境准备

Node 24（`>=24 <25`）。**所有依赖与工具链装在项目目录内**，不污染系统：

```bash
./scripts/bootstrap.sh      # 下载项目内 Node 24 到 .toolchain/（约 34MB，仅一次）
./scripts/build.sh          # 构建前端 + 服务端
./scripts/dev.sh            # 启动开发服务器
```

Windows 用对应的 `.ps1`。

`bootstrap` 之后也可以直接用项目内 Node：

```bash
./.toolchain/node/bin/node --experimental-strip-types src/index.ts serve --data ./data
```

## 为什么用 `--experimental-strip-types` 直接跑 `.ts`

Node 24 的 type stripping 让 `import ... from './x.ts'` 直接可用，**不需要 tsc 编译步骤**。
好处是开发时改一行代码不用等构建，坏处是：

- 不能有 `enum`、`namespace`、参数属性（这些需要真正的编译）
- 类型错误不会被捕获，所以 `typecheck` 是**独立的必跑项**

项目里所有 `.ts` 都遵守这条约束（用 `const` 对象代替 `enum`）。

## 目录约定

```
src/server/     后端（Hono + SQLite）
src/client/     前端（React 19）
scripts/        构建、验收、工具
scripts/verify/ 验收脚本（57 个）
tests/fixtures/ 测试夹具（HTML 快照、AI 响应样本）
docs/           主题文档（配置/架构/设计/开发）
docs/方案/      顶层设计方案（跨模块的方向与约束）
.toolchain/     项目内的 Node（git 忽略）
.tmp/           临时文件（git 忽略，见下）
dist/           构建产物：交付物 + client/（运行时）；中间产物在 dist/.cache/
```

方案文档的门槛见 PLAN §17.1：**只有跨模块的顶层方案进 `docs/方案/`**，单个功能的
实施细节直接落进 PLAN 的对应章节。未定稿的草稿放 `.tmp/`，**不要放 `docs/`** ——
那里默认被引用、被信任、被 `check-tables.mjs` 扫描，混进一份"待批准"的文档，
读者无法从路径判断它算不算数。

## 临时文件：一律留在项目内

**不要写系统临时目录。** 用 `.tmp/`：

```js
import { useProjectTmp } from '../lib/tmp.mjs';
useProjectTmp();              // 设定 TMPDIR/TEMP/TMP 三个变量
// 之后 os.tmpdir() 就指向 .tmp/verify/
```

`scripts/verify/harness.mjs` 在模块顶层已调用它，所以**所有验收脚本自动生效**。
验证跑完会清空 `.tmp/verify/`，手动清用 `node scripts/clean-tmp.mjs`。

原因是一次全量验收会在 `%TEMP%` 留 26 个临时目录、约 629KB，
跑几十次之后系统盘会莫名其妙少几百 MB，而没人知道是谁留下的。

## 验收机制

这是这个项目最值得说的一部分。

### 与普通单测的区别

|            | 普通单测     | 本项目的验收                                 |
| ---------- | ------------ | -------------------------------------------- |
| 跑在什么上 | mock / 内存  | **真 SQLite + 真无头浏览器**                 |
| 断言什么   | 函数的返回值 | **产物**（库里的行、DOM 的状态、文件的内容） |
| 失败含义   | 实现错了     | 实现错了**或**需求没被满足                   |

一个具体例子——"简报能生成"这条需求：

```js
// ❌ 无意义的断言：函数有返回值不代表简报生成了
check('能生成', () => ok(result !== undefined));

// ✅ 本项目的方式：查产物
const row = db.prepare('SELECT day_key FROM digests WHERE user_id = ?').get(uid);
check('落库时写了 day_key', () => ok(row.day_key !== null));
check('生成后 digestDue 说今天已生成', () => ok(!digestDue(db, uid, cfg, now).due));
```

第二组断言才抓得住真实缺陷。**v2.2 修的四个简报缺陷全都在"函数有返回值"这一层骗过了
既有断言**：`runDigest` 抛异常被 handler 吞成一句话，而没有任何断言去查
"库里到底有没有那一行"。

### 写新断言的规矩

1. **先让它是红的。** 新断言必须先跑一次确认失败，否则它可能测的是不存在的东西
2. **断言产物，不是实现。** 不要写"代码里有这个字段"，要写"库里有这个值"
3. **反向验证一次。** 实现正确时是绿的，把它改坏时是红的 —— 两个方向都要确认

第 3 条抓到过一个真实的假绿：配置页折叠的验收里，用 `offsetParent !== null`
判断"元素是否可见"。但关闭的 `<details>` 里，`offsetParent` **不为 null**、
`getBoundingClientRect()` 还返回真实高度（Chrome 用 `content-visibility` 实现折叠，
不是 `display:none`）。改成 `checkVisibility()` 并在反向验证中确认：
把 `<details>` 改成默认 `open`，新断言红、旧断言仍绿。

### 跑验收

```bash
./scripts/verify-all.mjs                 # 全部（57 个脚本、2171 条断言，约 22 分钟）
./scripts/verify-all.mjs m3              # 只跑名字匹配的（支持 glob，如 m0-0[5-8]）
./scripts/verify-all.mjs --no-docker-path  # 跳过需要 docker 的那 1 个
./scripts/verify-all.mjs --keep-tmp      # 留着 .tmp/verify 便于排查失败

# 单个
./.toolchain/node/node.exe scripts/verify/m3-06-digest-chain.mjs
```

输出是逐条 PASS/FAIL 加最后一行汇总。**FAIL 会打印期望值与实际值**，
而不是只报"断言失败"。

### 命名

`m<里程碑>-<序号>-<主题>.mjs`，例如 `m3-06-digest-chain.mjs`。
数字是执行顺序，同里程碑内按依赖排。

### 断言计数会漂移

每个脚本末尾 `summary('m3-06-digest-chain')` 打印 `N/M PASS`。
文件头注释里标注的条数与实际可能不一致（改了脚本忘了改注释）。

**README 与 PLAN 里的总数以 `verify-all` 的实测输出为准**，不要手算。
v2.2 之前文档里写的 55/2152 与实际 57/1986 对不上，就是这么来的。

## 前端开发

```bash
./scripts/dev.sh          # Vite dev server + 后端（热更新）
```

前端**没有路由库**，一个 `useReducer` 管视图状态。也没用状态库（Redux/Zustand）——
状态规模还没到需要它们的程度，加了只是多一层间接。

样式是**手写 CSS**，不是 Tailwind。原因：设计规格里有大量非工具类的描述
（"冲突用左侧细色条而不是红色 alert"），手写比配置 Tailwind 主题更直接。

## 后端开发

### 加一个 API

1. 在 `src/server/routes/*.ts` 加路由
2. 在 `src/server/app.ts` 挂上
3. 写进 `PLAN.md` 的对应章节（**先改文档**）
4. 加验收脚本

### 加一个迁移

三处都要改，少一处会静默失败（开发时能跑通，打 SEA 之后才炸）：

```
① src/server/db/migrations/000N_name.sql        新文件
② src/server/db/migrate.ts                      MIGRATIONS[] 加一项
③ src/server/db/migration-sql.ts                declare const + case 分支
```

第 3 步是 esbuild 把 SQL 打成字符串常量用的（`__SQL_000N_NAME__`）。

### 加一个 AI 提示词

在 `src/server/ai/prompt.ts`（提示词常量）与 `src/server/ai/schema.ts`（zod 约束）。**必须**：
- 用 zod schema 约束输出
- 写清"只输出 JSON，不要围栏"
- 在 `ai_usage` 里记 `purpose`（便于按用途统计成本）

## 调试

```bash
# 环境自检
./cheng-rss doctor --json

# 看一个用户的任务队列
sqlite3 data/app.db "SELECT kind, status, COUNT(*) FROM jobs GROUP BY kind, status"

# 看 AI 失败的原因分布
sqlite3 data/app.db "SELECT substr(error,1,40), COUNT(*) FROM ai_usage
  WHERE ok=0 GROUP BY 1 ORDER BY 2 DESC"

# 看最近一次简报为什么没生成
sqlite3 data/app.db "SELECT * FROM digest_skips ORDER BY created_at DESC LIMIT 5"
sqlite3 data/app.db "SELECT * FROM digest_attempts WHERE ok=0 ORDER BY created_at DESC LIMIT 5"
```

## 提交规范

```
<type>(<scope>): <主题>

<正文：为什么，而不是改了什么>
```

`type`：`feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `style`

**正文写"为什么"**。改动内容看 diff 就知道，但"为什么必须这样改"、
"试过什么别的方案"、"踩了什么坑"只有作者知道。这些信息在三个月后最值钱。

## 文档优先

`PLAN.md` 是这个项目的规格来源。**规格层的改动要先写进 PLAN，再改代码**：

```
需求层（§1.1 需求表）
    ↓
规格层（各章的"为什么"与"边界条件"）
    ↓
实现层（代码）
    ↓
验收层（§19 的映射表：需求 → 步骤 → 脚本）
```

直接改代码而不改文档，会让 PLAN 逐渐失真 —— 而 PLAN 失真之后，下一个改动就
只能靠猜。这是这个项目反复强调"先改文档"的实际理由，不是为了流程好看。

## 检查清单

提交前：

```bash
npm run typecheck:all        # 必须干净
./scripts/verify-all.mjs     # 必须全绿
node scripts/check-no-residue.mjs   # 确认没有临时文件残留
```
