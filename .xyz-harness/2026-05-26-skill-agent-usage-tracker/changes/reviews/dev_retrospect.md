---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect

## 1. Phase Execution Review

### Summary

实现了 usage-tracker extension（3 个文件，~150 行 TS）和 usage-analyzer skill（1 个 SKILL.md）。经过 5 步专项审查，发现并修复了 3 条 MUST FIX（BLR 2 条 + Standards 1 条），全部在 v2 审查中通过。代码零 lint error。

### Problems Encountered

1. **BLR MUST_FIX-1（initialized 未提前设置）**：`before_agent_start` 中当 `skills` 非数组时直接 return，不设置 `initialized = true`，导致后续所有 tool_call（包括 agent 计数）被永久跳过。这是 spec FR-3 的边界场景——"没有 skills 的 session"——plan 中没有明确覆盖。修复：将 `initialized = true` 提前到 skills 检查之前。

2. **BLR MUST_FIX-2（resolve(undefined) 崩溃）**：`event.input` 的 `path` 字段理论上不可能缺失（Pi 的 read tool schema 保证），但 `ToolCallEvent` 联合类型中 `CustomToolCallEvent.input` 是 `Record<string, unknown>`，没有编译时类型安全。运行时如果 input 意外缺失 path 字段，`resolve(undefined)` 会抛 TypeError。修复：增加 `typeof rawPath !== "string"` 运行时守卫。

3. **Standards MUST_FIX（静默 catch）**：`incrementAndPersist` 的 catch 块只有 `console.error`，违反 CLAUDE.md 的 `no-silent-catch` 规则。修复：函数返回 `boolean`，让调用方感知写入结果。同时顺带修复了 import 顺序（Node 内置 → npm → 项目内部）和魔法数字（`2` → `JSON_INDENT`）。

4. **项目既有类型错误**：`npx tsc --noEmit` 产出大量错误（goal/todo/subagent/workflow 全部报错），全部是既有问题（缺少 `@types/node`、paths 映射在 CI 环境外不可用等）。usage-tracker 的错误模式与既有扩展完全一致，无新引入问题。

### What Would You Do Differently

- 编码时应该更严格地处理 `before_agent_start` 的边界：即使 spec 说了 "skills 一定存在"，也应该假设它可能不存在。BLR 审查正确指出了这个问题。
- `event.input` 的类型安全应该在编写时就加守卫，而不是等审查指出。Pi 的 `ToolCallEvent` 联合类型设计意味着 custom tool 的 input 是 `Record<string, unknown>`，不能信任字段存在。

### Key Risks for Later Phases

- **E2E 验证依赖 Pi 运行时**：Extension 只能在 Pi 进程内测试。Phase 4 的 E2E 测试需要手动在 Pi session 中触发 skill 读取和 agent 调用，无法自动化。
- **read-before-write 无文件锁**：跨 Pi 进程的极端并发仍可能丢失计数。spec 已文档化为已知限制，Phase 4 无需修复。

## 2. Harness Usability Review

### Flow Friction

五步专项审查流程对这种 ~150 行的简单 extension 偏重。4 个并行审查 + 1 个串行审查，其中 Taste Review 和 Robustness Review 对这么小的代码量产出都是 "pass, 0 issues"。对于 L1 复杂度的项目，可以考虑简化审查流程（如只跑 BLR + Standards 两步）。

### Gate Quality

Phase 3 gate 有 19 个检查项，非常全面。但有些检查项对 L1 项目过重（如 `rust_taste_review` 跳过检查）。Gate 脚本对 L1/L2 没有区分处理，统一要求 5 步审查。

### Prompt Clarity

dev skill 的 "简单路径 vs 复杂路径" 判断清晰（<4 tasks 纯后端 = 简单路径）。五步专项审查的 subagent 构造指导也比较明确。但各 reviewer skill 分布在不同 workspace（`xyz-harness-engineering-workspace` vs `~/.pi/agent/skills/`），需要手动查找路径。

### Automation Gaps

无自动测试框架。Pi extension 在进程内运行，没有独立的 test runner。所有测试都是 typecheck + lint + 手动验证。这是项目本身的特点，不是 harness 的缺口。

### Time Sinks

- 并行 dispatch 4 个审查 subagent 后，需要逐个读取结果、解析 MUST FIX、修复代码、再 dispatch v2 审查。整个审查-修复循环消耗了大部分时间。对于 ~150 行代码，审查的 ROI 偏低。
