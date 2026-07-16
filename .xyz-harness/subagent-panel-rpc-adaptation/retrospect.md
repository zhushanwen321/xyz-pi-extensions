# Retrospect — subagent-panel-rpc-adaptation

## 做了什么
给 pi-subagent-workflow 扩展的 `/subagents` 和 `/workflows` command handler 加 RPC 分支，让 xyz-agent GUI 能通过 `client.prompt("/subagents cancel <id>")` 等程序化触发生命周期操作，不经 LLM。

## 做对了什么

1. **纯函数提取**：把 action 字符串解析（cancel/pause/resume/abort + id）提取成 `parseSubagentRpcCommand` / `parseWorkflowRpcCommand` 纯函数，返回判别联合。handler 变薄分发，解析逻辑独立单测。比 adaptation 文档原版（内联解析）可测性好得多。
2. **守卫修复**：headless 守卫从 `!ctx.hasUI` 收紧为 `ctx.mode !== "tui"`，顺带修复了原 bug——RPC 模式 hasUI=true 导致穿透到 `ctx.ui.custom()` 返回 undefined 命令静默消失。
3. **探索充分**：dev 前用 3 个并行 subagent 核查了 `ctx.mode` 类型、`service.cancel` 签名、lifecycle 函数签名 + LauncherDeps 继承关系。所有技术假设落地前已验证，实现阶段零意外。

## 做错了什么 / 可改进

1. **handler RPC 分支无单测**：plan 里用 E1(typecheck)+E2(lint) 覆盖 handler 分支，这是可接受的工程权衡（逻辑已下沉到被测纯函数），但 review 也指出 service=null 时的 RPC 分支跳过路径没有直接测试。当前风险低（service 检查在 RPC 分支前），但如果后续改 handler 结构可能漏掉。
2. **类型体操初版太丑**：第一版 `LIFECYCLE_VERBS` 的 `has()` 调用用了 `typeof LIFECYCLE_VERBS extends Set<infer V> ? V : never` 条件类型，过度复杂。重构为独立 `isLifecycleVerb` 类型守卫后干净了。第一版就不该写那么复杂。

## 流程观察

CW lite 流程对这个 2 文件改动的小任务略重——review 阶段的 5 维度对抗审查产出质量高，但 retrospect 对这种"设计文档已定稿、代码就是照着实现"的任务增量有限。不过 review 发现的 service=null 测试缺口确实有价值，说明 review 阶段对任何规模都不是浪费。

## 后续
- xyz-agent 侧需要确认操作失败时 notify 通道的 UI 反馈（扩展侧只 notify warning，前端能否展示是 xyz-agent 的事）
- adaptation 文档可补一句"操作失败的 UI 反馈由 xyz-agent 侧负责"
