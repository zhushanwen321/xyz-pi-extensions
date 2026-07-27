---
"@zhushanwen/pi-subagent-workflow": minor
---

> **版本口径**：本包处于 0.x 阶段。按 SemVer §6「0.x 可能在任何次版本引入破坏性变更」，minor bump 允许含 breaking。下方标注的 **Breaking** 是改动性质说明，不对应 major bump。

重构 subagent-workflow tool 面，提升弱模型调用正确率：

**Breaking** — `workflow` tool 删除 `retry-node` / `skip-node` 两个 action（7 → 5 action：run/status/pause/resume/abort）。这两个 action 语义尴尬（retry-node 重跑失败节点但不改脚本输出；skip-node 注入零 usage 占位结果），删除后 `node-ops.ts` 整文件移除。共享基础设施 `executeAgentCall` / `postBudgetUpdate` 仍由主路径使用，无死代码。`callId` schema 字段随之移除。

**Feat** — subagent ID 从纯 UUID 改为 `sa-<uuid>` 前缀格式，与 workflow runId 的 `wf-` 前缀风格统一。前缀是视觉辅助（所有消费方零格式校验，不进入程序逻辑判别），帮助 LLM/人眼通过 ID 区分 subagent 与 workflow。`shortId` 显示层加 `sa-` 感知分支保持信息量。向后兼容：旧纯 UUID ID 可正常反序列化。

**Refactor** — `subagent` tool 的 `startParam` 13 字段（task/slug/agent/model/thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/fork/worktree/cwd）从嵌套 envelope 拍平到顶层 schema。解决 flat JSON Schema 无法表达条件必填导致弱模型（GLM/DeepSeek）把 task/slug 平铺到顶层的痛点。删除 `hasFlattenedStartFields` runtime guard（拍平后语义反转）+ `hasStartParam` helper。`listParam` / `cancelParam` 保留嵌套（字段少，保留隔离）。`description` TDD 重写（432 词），正例改平铺。service 层契约（`ExecuteOptions`）不变，改动收敛在 tool 层。

不新增统一管理 tool（保持 3 tool：subagent / workflow / workflow-script）。
