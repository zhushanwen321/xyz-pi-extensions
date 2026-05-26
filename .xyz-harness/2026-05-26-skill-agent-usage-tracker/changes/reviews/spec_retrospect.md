---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect

## 1. Phase Execution Review

### Summary

完成了 Skill & Agent Usage Tracker 的 spec 设计。核心决策：采用 Extension（数据采集）+ Skill（分析展示）的分离架构，共享 `~/.pi/agent/usage-stats.json` 数据文件。经过 2 轮 spec review 解决了时序风险和并发竞争两个 MUST FIX 问题。

### Problems Encountered

1. **Skill 调用定义模糊**：Pi 中 skill 的"调用"不是显式的 tool call，而是 AI 读取 SKILL.md 文件。经过 3 轮提问才与用户对齐了"全文加载到 session = 一次调用"的定义。初始假设不足，浪费了一些提问轮次。

2. **并发竞争**被 review subagent 正确指出：`read-modify-write` 非原子操作，多 session 可能互相覆盖。修复方案：写入前重读最新文件内容 + Node.js 单线程保证。跨进程限制作为已知 trade-off 文档化。

3. **Gate 脚本 must_fix 字段语义不匹配**：review v2 的 YAML 中 `must_fix: 2` 表示"历史累计发现 2 条"，但 gate 脚本期望 `must_fix: 0` 表示"当前 open 为 0"。手动修复了字段值。

### What Would You Do Differently

- 在 Quick Overview 阶段就应该深入看 Pi 的 Extension API 事件类型（`tool_call`、`tool_result`、`before_agent_start` 的时序关系），而不是在提问过程中逐步发现。这会减少"时序风险"类问题。
- 方案选择阶段可以更早引入并发讨论，而不是等到 review 才发现。

### Key Risks for Later Phases

- **FR-3 时序保证依赖 Pi 运行时行为**：`before_agent_start` 一定在 `tool_call` 之前的假设需要实现阶段验证。如果实际行为不符，需要 fallback 方案。
- **Skill 路径解析**：`read` tool 的 `path` 参数可能传入相对路径，需要 `resolve` 后再匹配。Plan 阶段需明确处理。
- **`usage-analyzer` skill 的分析质量**：完全依赖 LLM 推理，没有硬编码分析逻辑。dev 阶段需要实际测试 skill 被加载后的分析效果。

## 2. Harness Usability Review

### Flow Friction

提问阶段偏长（6 轮对话才完成所有确认）。主要因为 skill 调用机制在 Pi 中不够直观，需要先理解 system prompt 中的 skill 发现机制、再区分"加载 description"和"加载全文"。这不是 harness 的问题，是领域复杂度导致的必要探索。

### Gate Quality

Gate 脚本的 `must_fix` 字段语义设计有歧义：累计发现数 vs 当前 open 数。review subagent 产出的 YAML 用"累计数"语义，gate 脚本检查"期望为 0"。需要统一：gate 应检查 `must_fix_resolved === must_fix` 或 review 产出直接用 open 数。这是一个 harness 层面的改进点。

### Prompt Clarity

Brainstorming skill 的流程清晰，Step 2-4 的渐进提问有效。但 Step 1（Quick Overview）对"需要深入到什么程度"没有明确指导。我在 API 类型定义上花了较多 token 阅读，部分信息对 spec 阶段并非必要（如 `ToolRenderContext` 等渲染相关类型）。

### Automation Gaps

Gate 脚本路径需要手动查找（不在项目内，在另一个 workspace 中）。可以考虑在 CLAUDE.md 或 harness 配置中记录 gate 脚本的固定路径。

### Time Sinks

- Pi Extension API 类型定义文件很大（1173 行），读取了完整内容但只用到 `ExtensionEvent` 联合类型和几个事件接口。可以在 Quick Overview 阶段用 grep 精准定位而非全量读取。
