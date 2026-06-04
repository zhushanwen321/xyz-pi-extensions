# Workflow Extension — 已确认问题清单

> 来源：session `1572d5.jsonl`（2026-06-03，llm-simple-router workspace）
> 分析日期：2026-06-03

## 问题总览

| # | 问题 | 严重度 | 影响 | 状态 |
|---|------|--------|------|------|
| 1 | meta-extraction Worker 中 `agent()`/`$ARGS` 等引用导致 ReferenceError | P0 | 含运行时全局变量引用的脚本全部标记 `available: false` | ✅ 已修复 |
| 2 | 顶层 `await` 在 CJS `import()` 中是 SyntaxError | P0 | 使用顶层 `await` 的脚本全部标记 `available: false` | ✅ 已修复 |
| 3 | CJS 脚本需要 `module.exports = { meta }` 但文档未写明 | P1 | AI 生成的脚本缺少 `module.exports` 导致 meta 提取返回空 | ✅ 已修复 |
| 4 | `process.cwd()` 在 bare+worktree 结构中指向 worktree 而非 workspace root | P1 | 脚本放在 workspace root 的 `.pi/workflows/` 下不被发现 | ✅ 已修复 |
| 5 | AgentPool spawn `pi --mode json` 子进程卡住（无超时、无输出） | P2 | workflow 执行时 agent call 永远 pending | ✅ 已修复 |

---

## 问题 1：meta-extraction ReferenceError（已修复）

**现象**：AI 写了包含 `agent()` 调用的 workflow 脚本放到 `.pi/workflows/`，`workflow-run` 返回 "not found or unavailable"。

**根因**：`config-loader.ts` 的 `extractMetaViaWorker()` 使用 Worker `import()` 加载脚本。在 import 之前，脚本中的 `agent()`、`$ARGS`、`$WORKSPACE` 等全局变量尚未被注入（这些只在 `buildWorkerScript()` 构建的实际执行 Worker 中注入），导致 `ReferenceError`。

**修复**：在 meta-extraction Worker 代码中注入 8 行 stub globals：
```javascript
globalThis.agent = () => {};
globalThis.pipeline = () => {};
globalThis.parallel = () => {};
globalThis.phase = () => {};
globalThis.log = () => {};
globalThis.$ARGS = {};
globalThis.$WORKSPACE = "/tmp/fake";
globalThis.$BUDGET = { usedTokens: 0, usedCost: 0 };
```

**修复文件**：`config-loader.ts`
**修复提交**：feat-remake-workflows 分支

---

## 问题 2：顶层 `await` 在 CJS 中是 SyntaxError（✅ 已修复）

**现象**：修复问题 1 后，使用顶层 `await agent(...)` 的脚本仍然标记 `available: false`。

**根因**：`extractMetaViaWorker()` 使用 `import()` 加载 `.js` 文件。Node.js 将 `.js` 文件视为 CJS 模块（除非 package.json 有 `"type": "module"`）。CJS 不支持顶层 `await`。这是一个 **parse-time** SyntaxError，发生在代码执行之前，所以 stub globals 无法解决这个问题。

**修复**：将 `extractMetaViaWorker()`（Worker + `import()`）替换为 `extractMetaViaRegex()`（`readFile` + 正则匹配 + `new Function` 解析对象字面量）。不再执行用户代码，只提取 `const meta = { ... }` 或 `export const meta = { ... }` 声明。彻底绕开 CJS/ESM/顶层 await 的问题。

**修复文件**：`config-loader.ts`
**修复提交**：feat-remake-workflows 分支

---

## 问题 3：CJS `module.exports` 要求（✅ 已修复）

**现象**：`import()` 加载 CJS 脚本时 `mod.meta` 为 `undefined`，因为脚本使用 `const meta = {...}` 声明而不是 `module.exports = { meta }`。

**根因**：CJS 的 `import()` 加载后，只有 `module.exports` 上的属性可以通过 `mod.xxx` 访问。脚本顶层的 `const meta` 是模块内局部变量。

**修复**：同问题 2，改用正则提取后，不再依赖 `module.exports`。`const meta = { ... }` 格式直接被正则匹配。

**修复文件**：`config-loader.ts`
**修复提交**：feat-remake-workflows 分支

---

## 问题 4：`process.cwd()` 在 bare+worktree 中指向 worktree（✅ 已修复）

**现象**：脚本放在 workspace root 的 `.pi/workflows/` 下不被发现。

**根因**：bare+worktree 结构中，Pi 主进程的 cwd 是某个 worktree 子目录，不是 workspace root。`resolve(".pi/workflows")` 解析到错误的路径。

**修复**：添加 `findWorkspaceRoot()` 函数，从 cwd 向上查找 `.bare/`、`.git/` 或 `.pi/` 标记目录来确定 workspace root。`loadWorkflows()` 使用 `findWorkspaceRoot()` 替代 `process.cwd()`。

**修复文件**：`config-loader.ts`
**修复提交**：feat-remake-workflows 分支

---

## 问题 5：AgentPool spawn 子进程卡住（✅ 已修复）

**现象**：workflow 启动成功（runId 返回），但 agent call 永远 pending（3 分钟无响应），最终被 abort。

**根因**：`runPiProcess()` 中 spawn 的子进程没有超时保护。如果 pi 进程挂起，Promise 永远不 resolve。

**修复**：在 `runPiProcess()` 中添加 120 秒进程级超时。超时后发送 `SIGKILL`，返回 `exitCode: 1`。

**修复文件**：`agent-pool.ts`
**修复提交**：feat-remake-workflows 分支

---

## 修复结果

所有 5 个问题均已修复，140 个单元测试全部通过。

## Session 复现路径

问题在以下时间线中出现：

1. **09:07** — AI 写了 `merge-worktree.js` 到 `.pi/workflows/`
2. **09:08** — `workflow-run merge-worktree` → "not found"（问题 1）
3. **09:09** — 用 `workflow-generate` → name conflict，再试 `workflow-run` → 仍然 "not found"
4. **13:07** — AI 重读源码，发现 meta 提取崩溃
5. **13:10** — 手动修改脚本（包裹 async、加 `module.exports`）后 meta 提取成功，但 `workflow-run` 仍失败（问题 4：cwd）
6. **13:13** — 复制到 `main/.pi/workflows/`，`workflow-run` 成功
7. **13:14** — AgentPool 卡住 3 分钟，abort（问题 5）
8. **13:15** — 放弃 workflow，回到手动 bash 执行 merge stages
