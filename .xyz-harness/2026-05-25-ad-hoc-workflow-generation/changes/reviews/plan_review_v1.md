---
verdict: fail
must_fix: 1
reviewer: plan-review-expert
date: 2026-05-26
---

# Plan Review — Ad-hoc Workflow Generation

## Summary

整体计划质量较高，Spec-Plan 映射全面，Task 粒度合理，E2E 测试覆盖完整。但存在一个必须修复的编排错误：G2 和 G3 在 Wave 2 中被标记为并行，但两者都修改 `commands.ts`，会导致 subagent 并行冲突。

---

## 1. Spec-Plan 一致性

| Spec 指标 | AC/FR | 对应 Task | 状态 |
|-----------|-------|-----------|------|
| AC1 | 自然语言生成临时 workflow | Task 2 (路由) + Task 3 (generate) | ✅ |
| AC2 | 匹配已有 workflow 让用户选择 | Task 2 (路由) | ✅ |
| AC3 | 临时 workflow 写入 .tmp | Task 3 (generate) | ✅ |
| AC4 | `/workflow save` 移动 | Task 2 (save) | ✅ |
| AC5 | `/workflow save --as` | Task 2 (save) | ✅ |
| AC6 | 执行前展示路径等待确认 | Task 2 + Task 3 | ✅ |
| AC7 | 拒绝无 meta 脚本 | Task 3 | ✅ |
| AC8 | 保存不影响运行中 Worker | Task 2 | ✅ |
| AC9 | 名称冲突拒绝 | Task 3 | ✅ |
| AC10 | .tmp 目录自动创建 | Task 3 | ✅ |
| FR4.5 | 同名去重优先级 | Task 1 | ✅ |
| FR6.3 | 运行中拒绝删除 | Task 4 | ✅ |

**发现 1 — FR4.2 未显式提及（信息性）**：FR4.2 规定 "Session 结束时不自动删除临时 workflow"，这是一个行为约束。当前代码没有 session_end 自动清理机制，所以隐式满足。但 plan 应在 Task 2 或 Task 3 中加一句备注确认现有代码无自动清理逻辑，避免未来改动引入自动清理。

**发现 2 — FR6 面板操作的 `r`/`s`/`d` 快捷键（信息性）**：spec FR6.2 描述了 Run/Save/Delete 操作，plan Task 4 中将其映射为 `r`/`s`/`d` 键绑定。但 `registerShortcut` 在 widget.ts 中已用于全局快捷键（ctrl+shift+p/x/r），而面板内操作可能需要不同的注册方式（panel interaction vs global shortcut）。这个实现细节需在实现时确认。

---

## 2. Task 粒度

| # | Task | 修改文件数 | 评估 |
|---|------|-----------|------|
| 1 | config-loader + state | 2 | ✅ 单一职责，范围清晰 |
| 2 | commands | 1 | ✅ 但职责略多（save 子命令 + 路由增强），可接受 |
| 3 | index | 1 | ✅ 单一职责，范围清晰 |
| 4 | widget | 2 (widget.ts + commands.ts) | ⚠️ 见下方 CRITICAL 问题 |

Task 2 和 Task 3 的粒度合理。Task 4 需要修改 2 个文件（widget.ts + commands.ts 提取共用函数），这个跨文件依赖是合理的。

**发现 3 — Task 2 和 Task 4 修改同一文件（信息性）**：Task 2 修改 commands.ts（新增 save 子命令 + 路由增强），Task 4 也修改 commands.ts（提取 save 共用函数）。这不一定是问题，取决于编排方式，参见下方 CRITICAL 问题。

---

## 3. Execution Groups 分组

| Group | Tasks | 依赖 | 评估 |
|-------|-------|------|------|
| G1 | Task 1 | 无 | ✅ 基础设施，正确 |
| G2 | Task 2, Task 3 | G1 | ⚠️ 内部串行标记但方向未指定 |
| G3 | Task 4 | G1 | ❌ 与 G2 有文件冲突 |

G1 作为基础设施层，G2/G3 依赖 G1，这个分层正确。

---

## 4. Wave 编排

| Wave | Groups | 评估 |
|------|--------|------|
| Wave 1 | G1 | ✅ 正确 |
| Wave 2 | G2, G3 | ❌ 冲突问题 |

**CRITICAL — G2 (Task 2) 和 G3 (Task 4) 并行修改 commands.ts**

```
Wave 2:
  G2: Task 2 → 修改 commands.ts (save 子命令 + 路由增强)
  G3: Task 4 → 修改 commands.ts (提取 saveWorkflow 共用函数)
```

两个 subagent 同时编辑 `commands.ts` 必然产生 merge 冲突。具体冲突点：

- Task 2 在 `commands.ts` 中添加 `case "save":` 分支和 default handler 的 workflow 列表拼接
- Task 4 在 `commands.ts` 中将 save 逻辑提取为独立函数 `saveWorkflow()`

两个改动都涉及 `commands.ts` 中 `registerWorkflowCommands` 函数内部及附近区域，冲突不可调和。

**修复方案**（任选其一）：

1. **推荐**: G3 依赖 G2（G1 → G2 → G3 串行 Wave），G2 完成 commands.ts 修改后 G3 再提取共用函数
2. **替代**: 将 Task 4 的 `commands.ts` 修改合并到 Task 2 中（在 G2 内部串行中完成），G3 只修改 `widget.ts`
3. **替代**: G3 → G2（先提取共用函数再用），这样 G2 实现 save 子命令时可以直接调用已提取的函数

方案 1 最符合直觉——先实现功能再提取共用。

---

## 5. Placeholder / TBD / 未定义逻辑

- ❌ 未发现 TBD/TODO/placeholder
- 所有实现要点都给出了具体的方法名、字段名和路径

---

## 6. G2 内部串行方向未指定

Plan 在 G2 执行流中标记 "内部串行"，但未说明 Task 2 → Task 3 还是 Task 3 → Task 2。

- Task 2 需要 `scanWorkflows` 返回 `source`/`path`（由 Task 1 提供但 Task 1 已完成）
- Task 3 也需要 `scanWorkflows`（由 Task 1 提供）
- Task 2 和 Task 3 修改的是不同文件（commands.ts vs index.ts），**可以并行**

建议：G2 内部 Task 2 和 Task 3 可以并行执行，因为两者无依赖且修改不同文件。这能缩短 Wave 2 的总时间。

---

## 7. E2E Test Plan 覆盖

| Test Scenario | 覆盖的 AC/FR | 状态 |
|---------------|-------------|------|
| TS1 | AC1 | ✅ |
| TS2 | AC2 | ✅ |
| TS3 | AC4, AC5 | ✅ |
| TS4 | AC7 | ✅ |
| TS5 | AC9 | ✅ |
| TS6 | AC10 | ✅ |
| TS7 | AC8 | ✅ |
| TS8 | AC3, FR5.1 | ✅ |
| TS9 | FR4.5 | ✅ |
| TS10 | FR6.3 | ✅ |

所有 AC 和 FR 均已覆盖。

**发现 4 — AC6 的执行前确认交互（信息性）**：AC6 要求 "AI 展示脚本路径后自然停顿等待用户确认"，这是 AI 行为层，不适合自动化测试。E2E 测试没有包含这个也合理，标注为手动验证场景即可。当前 document 已在 Test Environment 中说明 "手动验证为主"，可以接受。

**发现 5 — TS7 的运行中构造（建议性）**：TS7 测试保存不影响运行中 Worker，但没有说明如何构造 "running" 状态。建议补充：可以通过调用 `workflow-run` 启动一个长时间运行的 workflow（如 sleep 30s 的测试脚本），然后在 running 状态执行 `/workflow save`。最小测试脚本可添加到 Test Environment 部分。

---

## 8. 实现细节问题

| # | 问题 | 严重度 | 说明 |
|---|------|--------|------|
| P1 | Task 3 meta 验证过于简单 | medium | "验证 script 包含 `const meta =` 或 `export const meta =`"——字符串包含检查容易被注释中的 `const meta =` 绕过。建议改为 `new Function(script)` 成功后 `eval` 出 meta 对象再检查结构，或使用正则匹配非注释位置的 `const meta =`。但这是实现细节，可在 dev 阶段优化。 |
| P2 | default handler 的消息格式不含 `.tmp/` 路径前缀 | low | Plan 说消息格式 "`[saved] name — description`"，但没有包含 `.tmp/` 路径前缀。Tmp workflow 需要显示 `[tmp] name — description (.pi/workflows/.tmp/name.js)` 来支持 AC6 的路径展示？不过路径已经在 `workflow-generate` 返回中展示了，这里只是为了列表匹配，path 信息不是必须的。 |
| P3 | save 命令的 `--as` 参数解析未说明 | low | Task 2 说解析 `--as <new-name>`，但没有说明具体的 parts 遍历方式。可复现 `parseRunArgs` 的模式，但 `save` 子命令的参数格式与 `run` 不同。 |

---

## 结论

**verdict: fail**

**must_fix: 1 项**

| # | 问题 | 影响 | 建议修复 |
|---|------|------|---------|
| 1 | G2 和 G3 在 Wave 2 中并行修改 commands.ts | 文件冲突，subagent 修改会互相覆盖 | 使 G3 依赖 G2（串行），或将 commands.ts 的共用函数提取合并到 Task 2 |

**建议关注（非 blocking）**:

- G2 内部 Task 2 和 Task 3 可以并行（修改不同文件），无需串行
- Task 3 的 meta 验证应使用 `eval` 对象检查而非字符串包含
- E2E TS7 应补充如何构造 running 状态的说明
- FR4.2 建议在 Task 2（或某个合适位置）加备注确认无自动清理逻辑
