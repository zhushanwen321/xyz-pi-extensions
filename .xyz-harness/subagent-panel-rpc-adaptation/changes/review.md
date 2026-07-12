# Code Review — subagent-panel-rpc-adaptation

## 审查范围
- commits: `171f073b6`（W1: command-actions 纯函数 + 单测）、`2003e64a1`（W2: handler RPC 分支 + changeset）
- 审查方式：subagent 对抗性 review + 主 agent plan 覆盖核对

## 发现的问题

无 must_fix / should_fix。1 个 nit（非本 commit 引入）。

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 代码规范 | `// 直接按 runId / 前缀匹配打开` 缩进 1 空格（pre-existing context line，非本次 diff） | nit | commands.ts:105 |

5 维度核对结论：
1. **业务逻辑正确性**：RPC 分支正确解析 action 并分发；cancel boolean 返回值双分支处理；lifecycle try/catch 完整覆盖 throw 场景；TUI 路径未被破坏（守卫从 hasUI 改为 mode）；headless 兜底与改前一致。
2. **类型安全**：两个 switch 判别联合 exhaustive（tsc 通过）；无 any/as 滥用；`isLifecycleVerb` 类型守卫正确；`LauncherDeps extends LifecycleDeps` 协变安全。
3. **边界条件**：空串/纯空白/多空格/未知 action 全返回 noop（有测试）；missing-id 返回带 verb 的提示；service=null 在 RPC 分支前被拦。
4. **测试覆盖**：17 个单测覆盖正常路径 + missing-id + noop 边界，无 happy-path-only；handler 分支靠 E1/E2 typecheck+lint 覆盖（plan 预期）。
5. **代码规范**：ctx.mode === "rpc" 模式、注释密度、import 顺序、changeset 格式全部对齐项目约定。

## plan 覆盖核对
- [x] W1 changes[0]: 新增 command-actions.ts，导出 parseSubagentRpcCommand / parseWorkflowRpcCommand 纯函数 + 判别联合类型 — 已落地
- [x] W1 changes[1]: 新增 command-actions.test.ts，17 个 vitest 单测覆盖正常/missing-id/noop 边界 — 已落地
- [x] W2 changes[0]: subagents.ts 加 ctx.mode==='rpc' 分支调 service.cancel；hasUI 守卫改 mode 守卫；TUI 路径不变 — 已落地
- [x] W2 changes[1]: commands.ts 加 ctx.mode==='rpc' 分支调 pause/resume/abort（try/catch）；hasUI 改 mode；TUI 不变；lifecycle import 复用 — 已落地
- [x] W2 changes[2]: .changeset/subagent-workflow-rpc-lifecycle.md，minor 类型 — 已落地

## 结论
- must_fix 数量：0
- 可选后续改进（非阻塞）：为 handler RPC 分支补 service=null 回归测试
