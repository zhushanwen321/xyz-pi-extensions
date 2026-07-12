# Retrospect: GUI Protocol Rollout

**Topic**: cw-2026-07-12-gui-protocol-rollout
**Date**: 2026-07-12
**Status**: tested → closeout

## 目标回顾

三个扩展（subagent-workflow / todo / goal）统一接入 `@xyz-agent/extension-protocol@0.2.0` 的 `__gui__` 渲染协议。

## 完成情况

### W1: subagent-workflow（迁移 + 类型契约修正）

- 删除本地 stub `gui-adapter.ts`，import 改为 npm 包
- 修正类型契约：3 个协议不存在的自定义 type → 通用原语
  - `task-list` → `list-tree`
  - `workflow-runs` → `list-tree`
  - `subagent-trace` → `card(stats-line)`
- `isGuiCapable` 语义统一：`ctx.hasUI === false` → `ctx.mode === 'rpc'`
- 新增 `gui-mappers.ts`：`mapRunStatus` / `mapRunIcon` / `toGuiCtx` 共享 helper
- 补齐 `workflow-script` tool 的 `__gui__` 输出（唯一未接入的 tool）
- 32 个 GUI 测试用例（含 mapRunStatus/mapRunIcon/isGuiCapable/buildGuiComponent/buildWorkflowGui）

**关键发现**：协议包的 `GuiContext` 带 `ui.custom` 字段，与 Pi SDK 的 `ExtensionContext.ui.custom` 泛型签名不兼容（TS2345）。沿用 ask-user 的 `toGuiCtx()` 模式解决。

### W2: todo（删除遗留 + 新增）

- 删除废弃的 `_render` 字段和 `buildRender()` 函数（CLAUDE.md 标记待清理）
- 新增 `buildGui(todos)` → `list-tree`，4 态映射（pending→dot, in_progress→circle/running, completed→check/done, cancelled→cross/failed）
- 3 个测试用例

### W3: goal（新增）

- 新增 `buildGoalGui(state)`：有 budget → `card(progress-bar + stats-line)`，无 budget → `stats-line`
- severity 阈值复用 `constants.ts` 的 `BUDGET_RATIO_HIGH/LOW`（0.9/0.7）
- card variant：blocked→danger, complete→success, else default
- 8 个测试用例

## 验证结果

| 包 | typecheck | test | lint |
|---|---|---|---|
| subagent-workflow | 0 error | 814 passed | 0 error, 0 new warning |
| todo | 0 error | 70 passed | 0 error, 0 new warning |
| goal | 0 error | 278 passed | 0 error, 0 new warning |

**总计**：1162 tests passed，0 type errors，0 new lint warnings。

## 经验教训

### 做得好的

1. **前置调查充分**：plan mode 阶段派 5 个 Explore subagent 调查了前端实现现状 + 三个扩展 + 其余扩展，发现了「前端只实现 ansi-text」这个决定性约束，避免了盲目输出无人消费的 `__gui__` 类型。
2. **类型映射决策前置**：在写 plan 前用 AskUserQuestion 确认了类型映射策略（通用原语 vs custom）和 isGuiCapable 语义，消除了最大的歧义点。
3. **Wave 拆分合理**：三个扩展互相独立（dependsOn 全空），3 个 subagent 并行执行，主 agent 统一 commit 避免了 git index 竞争。
4. **常量复用**：goal 的 magic numbers 发现 constants.ts 已有等价常量，直接复用而非重复定义。

### 做得不好的

1. **W1 subagent 没写测试**：plan 设计了 U1-U4 四个测试用例，但 W1 subagent 只做了代码改动没补测试。dev gate 不检查测试覆盖（只检查 commit 真实性），导致这个问题到 test 阶段才暴露。需要额外补一个 subagent 修测试，增加了一个 commit 周期。
2. **CW testCase 的 expected.text 匹配机制**：CW 做精确字符串匹配，actual.text 必须逐字符等于 expected.text。第一次提交时用了「语义等价但不完全相同」的文本，导致 9/10 case fail。第二次逐字符对齐后才通过。这说明 plan 的 expected.text 要写成「最终提交时会用的确切文本」，不能写描述性文本。
3. **并行 subagent 看到中间态**：W2 subagent 报告 subagent-workflow typecheck 不过（`mapRunStatus` 未定义），实际是 W1 subagent 还在运行中的中间态。并行执行时 subagent 间无隔离机制，需要主 agent 做最终验证。

## 后续跟进

- **前端组件实现**：当前前端只实现 `ansi-text`，三个扩展输出的 `list-tree` / `card` / `stats-line` / `progress-bar` 全部 fallback 到 JSON 文本。需要 xyz-agent 侧实现这些 Vue 组件才能真正消费 `__gui__` 数据。
- **changeset**：三个包有功能变更，需要创建 changeset 记录版本变更。
- **pre-existing lint warnings**：todo `migrateTodo` 的 `as unknown as T` 双断言和 goal `renderResult` 的 unsafe cast 是既有代码的 warning，不在本次范围。
