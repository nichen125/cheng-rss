# 重构交付报告（2026-11）

范围：架构评审里列出的 P0 三项 + P1 七项中已完成的六项 + 两处前端界面修正。
基线 `63ffad0` → 当前 `main`：**47 个提交 / 33 个文件 / +3345 -1927**。

所有改动都在 `--no-ff` 合并的独立分支上完成，每个分支合并前都过了同一道闸：
`npm run typecheck:all`（server / client / tests 三份配置）→ `node scripts/run-tests.mjs` →
`node scripts/build-client.mjs`。

---

## 一、P0 三项

### 1. 列表加载竞态（`fix/entry-list-race`）

问题：`load()` 在 `await api.listEntries(...)` 之后无条件 `setItems/setCursor`，切视图或连打
搜索词时，先发的慢响应会覆盖后发的快响应 —— 表现为列表内容与视角不符、分页游标串台。

做法是两道互相补充的保险，注释里写明了为什么不能只留一道：

- `src/client/lib/latest.ts`：`createLatest()` 给每次请求编号，只有最新一次可以提交结果。
  **拦的是晚到的响应**（请求已经回来了，但已经不是当前视角）。
- `AbortSignal`：`src/client/api.ts` 的 `listEntries`/`listHistory`/`searchRsshub`/`listDigests`/
  `listFeeds` 接受 `signal`，切换时主动中止在途请求。**拦的是还在飞的请求**。
- `cursorRef` 镜像 `cursor`：`load` 依赖 `cursor` 却不在 effect 依赖里，原来用的是旧闭包。

### 2. Drizzle 去留（`chore/remove-dead-drizzle`，结论：删）

`drizzle-orm` 是全仓零引用的依赖：`db.select|insert|update|delete` 0 处、`schema.ts`(333 行)
无人 import、`openDb()` 返回的 `orm` 字段 0 引用。真实的 DDL 一直是手写 SQL 加 esbuild
注入的字符串常量，所以 `schema.ts` 与 `migrations/*.sql` 是两份互相不知道对方存在的真相。

删除后 `openDb()` 只返回原生 `DatabaseSync`，锁文件 -232 行。`scripts/verify/m0-03-db.mjs`
的断言从"ORM 绑定同一连接"改成"关闭后用只读连接另开仍能读到 1 万条" —— 换了个更硬的判据。
`docs/architecture.md` 记录了为什么不用 ORM（FTS5 虚拟表、部分索引的 WHERE、以及全仓零引用）。

### 3. `npm test` 假绿（`test/real-test-runner`）

原来 `node --test tests/**/*.test.ts` 在零测试文件时输出 `tests 0 / pass 0` 并 **exit 0** ——
CI 永远是绿的。现在 `scripts/run-tests.mjs` 自己枚举文件，**一个都没有就 exit 1**。

同时补了第一批量单测（URL 去重、余弦相似度、排列算法、最新请求守卫、入站校验、digest 退避、
AI 调用重试），并把 CI 加上单测步骤。当前 **90 个用例**。

---

## 二、P1 已完成项

### 4. 入站校验（`feat/http-validation`）

新增 `src/server/http/validate.ts`（`readBody(schema)` + 中文错误文案 + 最多报 3 条 + 去重），
把 7 个路由文件里 **35 处 `c.req.json() as {...}`** 清零。

几个必须保住的语义（迁移时逐条核对过，因为 zod 的默认行为容易把它们悄悄改掉）：

- `auth` 的 schema 全部 `.optional()` 且不给默认值 —— 给了默认值，"缺字段"会从 401 变成 400。
- `writeSettings` 用 `undefined` 表示"这个字段别动"，传 `null` 会 500，所以 rsshub 的 body 只能 optional。
- `POST /feeds` 显式 `body.fetchInterval == null ? undefined : Number(...)`，否则字符串 `'7200'` 会被写进 INTEGER 列。
- `PATCH /highlights/:id` 的 `'color' in body` 语义，靠"不给 optional 键补值"保持。

### 5. DTO 共享化 + 端点契约（`refactor/shared-contracts`、`refactor/contracts-*`）

响应类型从 `src/client/api.ts`(886→616 行) 搬到 `src/shared/dto.ts`(379 行)，服务端与客户端
现在引用同一份定义。随后给 **8 个只读端点**加了返回类型标注：

`GET /entries`、`GET /entries/:id`、`GET /entries/history`、`GET /feeds`、`GET /folders`、
`GET /highlights`、`GET /digests`、`GET /digests/:id`。

标注当场抓出四类真问题，全部是"以前没有任何东西能发现"的：

1. **详情端点漏返回 3 个字段**（`faviconUrl`/`thumbnailUrl`/`wordCount`）。SQL 是 `SELECT e.*`，
   三个列早就在手里，只是没拼进响应。
2. **`HighlightItem.color` 类型过严**：DTO 写的是三值枚举，而 `highlights.color` 在库里只是一列
   `TEXT`（无 CHECK），"只能是 yellow/green/blue"仅由写入路径 `pickColor` 在自己那条路上把关。
   类型比现实严，读的时候就会写出永远不会发生的分支。
3. **`FeedItem.folderId/folderName` 被强制成必填**：实际只有两个端点会补分组名，其余历史上就不带。
4. **数据库驱动返回的 `unknown` 被裸塞进响应**（history / digests / highlights 到处都有），
   以前 DTO 只是"贴纸"，现在编译器会拦。

### 6. `cmdServe` 五套定时器（`refactor/server-timers`）

`src/cli.ts` 里五段同构的 `try/catch + setTimeout().unref?.() + setInterval().unref?.()`
收成一个 `src/server/util/timers.ts` 的 `scheduleTask({name, everyMs, run, firstRunDelayMs?, failMessage?})`。

一个必须知道的细节：**日志限速的键就是日志原文**，所以 `name + " 失败"` 多出来的空格会让它变成
另一个键、把限速失效 —— 四条中文日志因此显式传 `failMessage`。

顺带修掉一个真泄漏：shutdown 原来只清 3 个 handle，`analyzeBackfill` 与 `sweepDigests` 从未被清。

### 7. 超长函数（`refactor/ai-split`、`refactor/digest-split`）

- `AiClient.chat` **206 → 62 行**：抽出 `chatOnce`（只报告"这一次发生了什么"，不睡不重试不动计数器）
  与 `settleUsage`（五条出口都要记一笔，记账公式只能有一处）。
- `AiClient.chatJson`：把降级决策收成纯函数 `nextFormatOn` + `isAnswerMiss`。
- `runDigestInner` **281 → 48 行**：按文件里已有的 `// ──` 分界拆成 `collectWindow`(33) /
  `summarizeClusters`(141) / `composeBody`(99)。

拆 `chat` 那次的验证方式值得记下来：把重构前后并排跑同一批剧本，比对**请求体序列 / 睡眠序列 /
记账序列 / 返回结果（JSON 全等，含对象键顺序）**，`chat` 14/14、`chatJson` 19/19 一致。
它抓到了自己的一个错误：`settleUsage` 最初写 `{...u, costUsd}`，让 `costUsd` 排到末尾、键顺序变了。

### 8. 前端界面（`fix/ui-dialog-button`、`fix/ui-buttons-row`、`fix/entry-row-semantics`、`feat/error-boundary`）

- **四处 `window.confirm` 换成自绘确认弹窗**（`src/client/components/ConfirmDialog.tsx`）：
  Promise 化、串行排队（并发调用不会互相覆盖导致某个 await 永挂）、`aria-modal` + `aria-labelledby`、
  打开时把焦点放到确认按钮、Esc 在捕获阶段拦掉（否则会连坐关掉设置弹窗）、锁 body 滚动并复原。
  实测：危险变体的确认按钮颜色 `rgb(194,65,12)` 与 `var(--must)` 完全一致；点取消未读数不变，
  点确认后库里 4 条真的变成已读。
- **按钮基类收口**（`src/client/styles.css:252-272`）：`.btn.tiny`/`.btn.danger` 从 `feeds.css` 搬过来，
  补上 `:active` / `:disabled`(opacity .45) / `[aria-busy='true']`(opacity .6 + cursor progress) 五态，
  全部只用既有 CSS 变量。收口时误删了 `.btn.tiny.icon-arrow:disabled{opacity:.32}`，单独补回并注明理由。
- **删掉被覆盖的 `.sum-skeleton` 死定义**：两套定义打架（padding 2px vs 14px），后者胜，留一份。
- **`EntryRow` 语义改造**：外层 `div[role=button][tabIndex]` 内嵌真链接和按钮是交互元素嵌套。
  改成"容器 + 标题真链接"，焦点环移到 `.entry-title:focus-visible`。同时补了 `.entry-title` 上裸 Enter 的
  处理（全局快捷键的 Enter 只认 `items[0]`，焦点在第 3 行会开错，而且它会掐掉链接的原生激活）。
- **`ErrorBoundary`**：阅读区与根部各包一层，避免局部渲染异常打白屏。根部没有 `onReset` 时
  `location.reload()`，因为 `view`/`scope`/`openId` 只活在 state 里，不写 URL、不落盘。

---

## 三、顺手修掉的三个真 bug

这几个都不是重构目标，是重构过程中被测试或标注揭出来的：

1. **`chat` 最后一轮空内容换投递，被报成"请求未发出"且标可重试** —— 已经发了 3 次、最后一次是
   明确的空内容，却让上层认为值得再跑一遍（每条都花钱）。修法：换投递前先看还有没有次数。
2. **`chat`/`chatJson` 会改调用方传入的 `opts.maxTokens`**（重试时 `*= 2`）。现在两个调用点都是内联
   字面量所以没炸，但复用同一个 `opts` 就会一路翻倍。修法：预算取局部变量。
3. **digest 退避把成功也算成失败**：`digestDue` 的注释写"今天失败过"，SQL 却没有 `AND ok = 0`，
   而成功路径也往 `digest_attempts` 写一行。目前被"今天已有简报就先返回"挡着，一旦那天的
   `digests` 行不存在（重建/清理过），"已尝试 3 次仍失败"就会在全都成功的日子上误触发。
   修了退避判定这一处；`digestStatus` 故意不改 —— 它的语义本来就是"今天试过几次"（含成功）。

---

## 四、没做的两件事（有具体理由，不是遗漏）

### 1. `Main` 进一步拆分（`src/client/App.tsx` 1898 行，`Main` 仍是整块）

已经搬走了 `Reader`(546 行)、`PrefsPanel`、`EmptyState`/`HistoryMeta`、导航常量（2961 → 1898 行）。
剩下的部分不是"随手抽几个组件"能解决的：侧栏那棵分组树（约 1189–1500 行）同时依赖
拖拽状态、每源菜单、排序规则与 `scope`，抽出去要传 20+ 个 props；更合理的做法是先抽
`useEntries` / `useFeedTree` / `useReader` 三个 hook 把状态与视图分开，再按 hook 的边界切组件。
这一步需要能目视验证（否则改坏侧栏很难发现），适合单独一轮做。

### 2. 订阅数据源统一（同一份 feeds/folders 有两份副本）

现状：`Main` 自己拉一份（`App.tsx:537` 的 `listFolders`、`:552` 的 `listFeeds`），配置弹窗里的
`FeedsProvider` 又拉一份，靠 `reloadTick` 与 `onChanged` 手工对戳。

正确做法是把数据层提到模块级 store（`useSyncExternalStore`），`Main` 与 `FeedsProvider` 都读它。
**为什么没做**：`Main` 里有三处本地乐观更新直接 `setFeeds`/`setFolders`
（`App.tsx:486` 读后改未读数、`:491`、`:1103` 改分组名），把数据搬进 store 必须同时把这三处
改成 store 的 patch 接口，否则乐观更新会丢。这是一次需要仔细验证的行为改动，不适合和
"最后一个收尾批次"混在一起。

---

## 五、验证记录

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型（server/client/tests） | `npm run typecheck:all` | 0 error |
| 单测 | `node scripts/run-tests.mjs` | 90 pass / 0 fail |
| 前端构建 | `node scripts/build-client.mjs` | 0（vite 产物 3 文件） |
| 服务端构建 | `node scripts/build-server.mjs` | 0 |
| 端点冒烟（临时库 + 真 HTTP） | 见下方清单 | 全部 200；非法请求体 400 |
| 界面（真浏览器 / CDP） | 确认弹窗、按钮五态、危险变体 | 见第二节第 8 条 |

冒烟覆盖：`/api/v1/entries`、`/entries/history`、`/feeds`、`/folders`、`/highlights`、`/digests`
全部 200 且形状与 DTO 一致；`POST /entries/read` 传 `{"ids":"not-an-array"}` 返回
`400 {"code":"BAD_REQUEST","message":"字段 ids 需要 array"}`；传 `{"ids":[]}` 返回 400 ——
后者是**既有设计**（handler 里显式 `if (ids.length === 0) throw badRequest('需要 ids')`），不是回归。

## 六、仍然已知、未处理

- `PLAN.md` 仍描述 Drizzle。按约定它是历史计划文档，不改；现状以 `docs/architecture.md` 为准。
- `src/server/digest/run.ts` 有一个死 import `clearWindowClusters`（只在注释里被提到）。删它无风险，
  但不在任何一次改动的边界内。
- `summarizeClusters` 里 `clusters.slice(0, 12)` 把 12 写死，第 13 簇起被静默丢弃，而 `entryCount`
  仍是整窗条目数 —— 两个计数描述的不是同一批对象。属于既有口径问题，需要产品判断。
- digest 模块的测试只覆盖了 `digestDue` 的退避判定；`runDigest` 的阶段顺序与落库差别没有回归网。
