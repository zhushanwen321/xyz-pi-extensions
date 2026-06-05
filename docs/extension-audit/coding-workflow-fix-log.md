# coding-workflow 审查问题修复日志

> 修复人: Pi 代码修复工程师
> 修复日期: 2026-06-05
> 审查报告: `docs/extension-audit/coding-workflow.md`

## 修复概览

| 类别 | 总数 | 已修复 | 跳过 |
|------|------|--------|------|
| P0   | 2    | 2      | 0    |
| P1   | 7    | 6      | 1    |
| P2   | 6    | 0      | 6 (不修复) |

---

## P0 修复（全部完成）

### ✅ P0-1: `package.json` 缺少 `license` 字段

**文件**: `extensions/coding-workflow/package.json`

**变更**: 在 `keywords` 后添加 `"license": "MIT"`

```diff
+ "license": "MIT",
```

**影响**: 消除 `npm publish` 警告，满足 §1.2 必需字段要求。

---

### ✅ P0-2: 第三方包名与 `package.json` 声明不一致

**文件**: `extensions/coding-workflow/package.json`

**变更**: 将 `peerDependencies` 和 `peerDependenciesMeta` 中的 `@earendil-works/pi-tui` / `@earendil-works/pi-ai` 修改为 `@mariozechner/pi-tui` / `@mariozechner/pi-ai`，与源码 import 语句一致（方案 B）。

```diff
- "@earendil-works/pi-tui": "*",
- "@earendil-works/pi-ai": "*",
+ "@mariozechner/pi-tui": "*",
+ "@mariozechner/pi-ai": "*",
```

**影响**: 消除运行时 `ERR_MODULE_NOT_FOUND` 风险。源码 import 使用 `@mariozechner/*`，现在 peerDeps 声明与之匹配。

---

## P1 修复（6/7 完成）

### ✅ P1-1: `runGateScript` 异步操作不接收 `AbortSignal`

**文件**: `lib/gate-runner.ts`, `lib/tool-handlers.ts`

**变更**:
1. `runGateScript` 新增可选参数 `signal?: AbortSignal`
2. 若 `signal.aborted` 在调用时已为 true，立即返回失败
3. 监听 `signal` 的 `abort` 事件，触发 SIGTERM → SIGKILL 渐进终止
4. `executeGateTool` 调用方透传 `signal`

**影响**: 用户中断（Esc / Ctrl+C）时，`python3 gate-check.py` 子进程可被正确取消，不再残留孤儿进程。

---

### ✅ P1-2: `session_tree` 未注册，旧分支 pending 状态泄漏

**文件**: `index.ts`

**变更**: 在工厂函数中新增 `session_tree` 事件处理器：
- 遍历 `activeSubprocesses` 发送 SIGTERM 杀掉残留子进程
- 清空 `activeSubprocesses` 数组
- 重置 `gateInProgress`、`gateRetryCount`、`pendingInit` 为默认值
- 持久化并更新 widget

**影响**: 分支切换时不再有残留的子进程和 in-flight 状态。

---

### ✅ P1-3: `executeInitTool` 中 skill 注入失败时的措辞调整

**文件**: `lib/tool-handlers.ts`

**变更**: 将错误分支的 resultText 从 `Phase 1 skill injection failed — it will be re-injected via before_agent_start` 改为 `Phase 1 skill injection deferred to before_agent_start on the next turn.`

**影响**: 采用方案 B（宽松策略），将 skill 注入视为 best-effort 操作，措辞不再暗示"失败"。init 工具本身成功完成（目录创建、状态初始化），skill 注入延迟到 `before_agent_start` 是设计上的降级策略，不应标记为错误。

---

### ✅ P1-4: Stale Context 防护缺失

**文件**: `lib/helpers.ts`, `lib/tool-handlers.ts`

**变更**:
1. 在 `helpers.ts` 新增 `isStaleContextError(error: Error): boolean`，基于 error.message 中的关键字（`aborted`、`context canceled`、`stale context`）判断
2. 在 `executePhaseStartTool` 的 `onError` 回调中，优先检查 stale context：
   - 若为 stale context error → 重置状态到 DEFAULT_STATE、持久化、通知用户 "Workflow aborted: stale context after compact."
   - 否则继续执行原有的回退逻辑

**影响**: 防止 compact 失败后的 stale context 导致状态错乱。

---

### ✅ P1-5: `gateRetryCount` 未持久化

**文件**: `index.ts`

**变更**:
1. `persistState` 中新增 `gateRetryCount` 和 `compactRetryCount` 字段写入
2. `reconstructState` 中将 `gateRetryCount` 从强制归零改为 `data.gateRetryCount ?? 0`（向后兼容）

**影响**: `MAX_GATE_RETRIES` 上限在 Pi 重启后不再被绕过。

---

### ✅ P1-7: `executePhaseStartTool.onError` 中 `compactRetryCount` 漂移

**文件**: `lib/tool-handlers.ts`

**变更**: 在 `onError` 回调中，`state.currentPhase -= 1` 后新增 `state.compactRetryCount -= 1`（带下限保护 `if < 0 then 0`）

**影响**: compact 失败时重试计数与 phase 一同回退，避免计数只增不减导致过早触及上限。

---

## P1 跳过（1 项）

### ⏭️ P1-6: 跨文件类型未集中到 `types.ts`

**跳过原因**:
- 需要创建新文件 `lib/types.ts`（~80 行），并修改 6 个文件的 import 语句
- 属于较大规模的结构性重构，引入 import 路径变动可能带来编译/运行时风险
- 当前类型分散不影响运行时行为，仅影响维护性
- 建议在下一个 minor 版本中作为专项重构处理

---

## P2 问题（不修复，按原则）

| 编号 | 问题 | 说明 |
|------|------|------|
| P2-1 | `lib/tool-handlers.ts` 超过 500 行 | 风格问题，不影响功能 |
| P2-2 | 多个函数超过 80 行 | 风格问题，不影响功能 |
| P2-3 | Import 顺序违反 Monorepo 约定 | 风格问题，不影响功能 |
| P2-4 | `keywords` 过于单薄 | 发现性优化，不影响功能 |
| P2-5 | 命名导出 vs 默认导出 | 规范建议，不影响功能 |
| P2-6 | `executeGateTool` 内重复 `isError` 返回结构 | 可维护性优化，不影响功能 |

---

## 变更统计

| 文件 | 新增行 | 修改行 | 说明 |
|------|--------|--------|------|
| `package.json` | 3 | 4 | P0-1 + P0-2 |
| `index.ts` | 17 | 2 | P1-2 + P1-5 |
| `lib/gate-runner.ts` | 17 | 0 | P1-1 |
| `lib/helpers.ts` | 10 | 0 | P1-4 |
| `lib/tool-handlers.ts` | 12 | 2 | P1-1 + P1-3 + P1-4 + P1-7 |
| **合计** | **59** | **8** | — |
