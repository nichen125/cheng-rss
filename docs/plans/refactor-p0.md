# 重构计划 · P0 批次

本文件是并行改造的临时计划：四个分支各自闭环，互不阻塞，按合并顺序回 `main`。
评审结论的来源是 `main@dc89080` 的代码实测，所有行号以此版本为准。

## 分支与合并约定

| 分支 | worktree | 范围 |
| --- | --- | --- |
| `fix/entry-list-race` | `.worktrees/fix-entry-list-race` | 列表请求竞态、旧闭包 effect |
| `fix/ui-dialog-button` | `.worktrees/fix-ui-dialog-button` | 原生 confirm 替换、按钮/弹窗体系、行内交互语义 |
| `chore/remove-dead-drizzle` | `.worktrees/chore-remove-drizzle` | 删除死依赖 drizzle-orm / drizzle-kit |
| `test/real-test-runner` | `.worktrees/test-real-runner` | 修 `npm test` 假绿，补真实单测 |

合并顺序：`chore/remove-dead-drizzle` → `test/real-test-runner` → `fix/entry-list-race` → `fix/ui-dialog-button`。
前两个只碰后端与测试基础设施，后两个都改 `src/client/App.tsx`，放最后按序解决冲突。

每个分支的要求：

- 一个分支内按主题拆 2–4 个提交，提交信息用现有 Conventional Commits 风格（`fix(client): ...` / `chore(deps): ...` / `test(server): ...`），正文说清「为什么」。
- 提交前必须自检：`npm run typecheck:all` 通过、`npm test` 通过、`npm run build:client` 与 `npm run build:server` 通过。注意 `npm test` 在 `test/real-test-runner` 合并前是空跑（0 用例仍 exit 0），别把它当证据。
- 不新增运行时依赖。不删除既有注释。不改 `docs/` 之外的文档结构。
- 不碰 `scripts/verify/*.mjs`，除非该脚本的断言因你的改动必然失败——那时改断言并在提交正文说明。

## 1. `fix/entry-list-race`

**问题**：`src/client/App.tsx:359-386` 的 `load()` 在 `await api.listEntries(...)` 返回后无条件 `setItems/setTotal/setCursor`。快速切换视图或连续输入搜索词时，先发的请求后返回，会把旧结果写进新视图，且 `cursor` 被旧响应的 `nextCursor` 覆盖，后续「加载更多」从错误位置续读。全客户端 `AbortController` 命中数为 0。

**改动**：

1. `src/client/api.ts`：给列表类接口加可选 `signal?: AbortSignal`，透传给 `fetch`。至少覆盖 `listEntries`、`listFolders`、`listFeeds`、`searchEntries`（以实际导出名为准）。
2. `src/client/App.tsx` `load()`：用「请求序号 + AbortController」双保险——每次发起自增 `seq`，返回后只在 `seq` 仍是最新时落地状态；`AbortError` 静默忽略，不写 state、不 setLoading。
3. 消除 `src/client/App.tsx:387` 的旧闭包：`useEffect` 依赖不能只写 `[view, debounced, scope]` 而让 `load` 捕获旧 `cursor`。改成 effect 内重新构造请求，或把 `load` 包进 `useCallback` 并把 effect 依赖写全。同时删掉那行失效的 `/* eslint-disable-next-line */`（仓库没有 eslint，它只是把问题藏起来）。
4. 同类问题 `src/client/useArrange.ts:157` 一并处理（拖动排列的加载 effect 同样缺依赖）。

**验收**：抽出纯逻辑（如 `src/client/lib/latest.ts` 的序号守卫）并配 `node --test` 单测，覆盖「旧响应后到必须被丢弃」；手工验证连续切三次视图 + 快速输入搜索词，列表不串、`cursor` 正确。

## 2. `fix/ui-dialog-button`

**问题**：4 处原生 `window.confirm`（`src/client/App.tsx:1105`、`src/client/settings/FeedsSection.tsx:170`、`:333`、`src/client/settings/FoldersSection.tsx:90`）在桌面端样式突兀、移动端与 PWA 下不可控，且无法表达「删除订阅」这类不可逆操作的语义。按钮样式散落三份 CSS，`.btn` 基类在 `src/client/styles.css:174`、变体却在 `src/client/feeds.css:100,281,287`；`.icon-btn` 在 `src/client/styles.css:214` 与 `src/client/mobile.css:306` 各定义一次。`.sum-skeleton` 在 `src/client/styles.css:1758` 与 `src/client/feeds.css:1840` 存在互相覆盖的两套定义，后者胜出，前者的 `padding` 与宽度阶梯完全失效。

**改动**：

1. 新增 `src/client/components/ConfirmDialog.tsx`（或 `src/client/ui/` 下，跟随现有目录习惯）：Promise 化的 `useConfirm()`，复用已有 `.modal-backdrop` / `.modal` 体系（样式见 `src/client/feeds.css:310`，用法参考 `src/client/settings/FeedsSection.tsx:722`）。必须支持：`role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`、打开时焦点入第一个按钮、Tab 焦点环、Esc 取消、遮罩点击取消（危险操作可要求显式点击）、关闭后焦点回到触发元素。
2. 4 处 `window.confirm` 全部换掉，危险操作（删除订阅 / 删除分组）用 `variant="danger"`，按钮文案保持中文原样。
3. 按钮体系收口：`.btn` 的基类与 `.btn-primary` / `.btn-ghost` / `.btn-danger` / `.btn-sm` 变体集中到一处（`styles.css` 保留基类 + 变体，`feeds.css` 里只留布局相关），补全 `:hover` / `:active` / `:focus-visible` / `:disabled` / `[aria-busy="true"]`（加载态）五态，`:focus-visible` 用现有描边色，不引入新色值。
4. 删掉 `.sum-skeleton` 的重复定义，保留 `src/client/feeds.css:1840` 那套（它是当前实际生效的），把 `src/client/styles.css:1758` 的块删除并确认骨架屏外观不变。
5. `EntryRow`（`src/client/App.tsx:2686`）目前是 `div[role="button"]` + `tabIndex` + `onKeyDown`，行内又嵌收藏/新标签按钮——交互元素嵌套，屏幕阅读器会读出两个可点区域。改成行主体 `<a href={entry.url}>`（键盘 Enter 天然可用、可中键新标签打开），右侧操作改成并列 `<button aria-label>`，行点击的 `onKeyDown` 手写逻辑随之删除。

**验收**：`npx tsc --noEmit` + `npm test`；用 `npm run dev` 起服务，逐一点击 4 个原 confirm 入口确认弹窗行为（含 Esc、遮罩、焦点归还）；键盘 Tab 走一遍列表页确认焦点可见；`git grep -n "window.confirm"` 结果为空。

## 3. `chore/remove-dead-drizzle`

**问题**：`package.json` 依赖 `drizzle-orm@1.0.0-rc.5` 与 `drizzle-kit`，但全仓 `db.select|insert|update|delete` 命中 0 次；`src/server/db/schema.ts`（333 行）被 0 个文件 import；`src/server/db/client.ts:44` 的 `orm` 字段与 `:104` 的 `drizzle({ client: db })` 无任何调用方。真实 DDL 由 `src/server/db/migrations/*.sql` 与 `src/server/db/migration-sql.ts`（`__SQL_0001_INIT__` 等 esbuild 注入常量）承担 —— 也就是说 schema 有两份真相，且被使用的那份与 Drizzle 无关。

**改动**：

1. 删 `src/server/db/schema.ts`，删 `OpenDb` 类型里的 `orm` 字段与 `drizzle()` 调用，清掉随之失效的 import 与注释。
2. `package.json` 移除 `drizzle-orm`、`drizzle-kit` 及对应脚本（若有 `db:generate` / `db:push` 之类）。
3. 全仓清理引用：`grep -rn "drizzle\|from 'drizzle" src/ scripts/ docs/ *.md`，把文档里描述「用 Drizzle 定义 schema」的段落改成现状（schema 真相在 `migrations/*.sql`）。
4. `scripts/verify/m0-02-schema.mjs`、`m0-03-db.mjs` 等 10 个含 `drizzle`/`orm` 字样的脚本：若断言依赖该字段则改断言，不要直接删脚本。
5. 同步 `package-lock.json`：用 `npm install --package-lock-only --ignore-scripts` 只改锁文件，**不要**跑 `npm install` / `npm uninstall` —— 各 worktree 的 `node_modules` 是指向主仓库的 junction（共享），装包会污染其他人的环境。最后确认 `npx tsc --noEmit` 与 `npm run build:server` 通过。

**验收**：`git grep -n "drizzle"` 仅剩迁移历史说明（如果有意保留）；服务能正常起（`npm run start -- --help` 或等价冒烟）。

## 4. `test/real-test-runner`

**问题**：`npm test` 是 `node --test --experimental-strip-types tests/**/*.test.ts`，但 `tests/` 下只有 `fixtures/`，0 个 `*.test.ts`。Node 在没有任何测试文件时输出 `tests 0 / pass 0` 并 **exit 0** —— CI 长期假绿。

**改动**：

1. 新增 `scripts/run-tests.mjs`：先枚举 `tests/**/*.test.ts`，**数量为 0 时 exit 1 并打印明确提示**；否则把这些文件路径显式交给 `node --test --experimental-strip-types`（不经 shell glob，规避 Windows 下 `**` 不展开）。`package.json` 的 `test` 指向它。
2. 补真实单测，优先选零依赖纯函数（读完实现再写断言，不要照抄实现）：
   - `src/client/digest/md-parse.ts`：标题层级、行内代码、列表、链接的最基本行为
   - `src/server/search/bigram.ts`：分词/相似度的边界（空串、全角、大小写）
   - `src/server/dedupe/url.ts`：同一文章不同 tracking 参数应判定为重复
   - `src/server/dedupe/cosine.ts`：向量相同/正交/零向量的结果
   - `src/client/arrange.ts`：拖拽重排后的顺序与持久化数据形状
   目标 4–6 个文件、20–40 个断言即可，**不追求覆盖率数字**。
3. `.github/workflows/ci.yml` 确认调用了 `npm test`；若没有则加上，并让 job 在测试为空时失败（脚本已保证）。
4. 在 `docs/development.md` 补一小节：如何跑单测、如何加新测试文件、为什么测试目录不允许为空。

**验收**：`npm test` 有非零用例数且 exit 0；临时把 `tests/` 挪走再跑必须 exit 1，然后挪回。

