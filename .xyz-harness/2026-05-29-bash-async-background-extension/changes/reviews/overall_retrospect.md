---
phase: pr
verdict: pass
---

# Overall Retrospect — bash-async-background-extension

## 1. Overall Phase Execution Review

### Summary

bash-async 扩展从需求到 PR 历经 5 个 phase，共 ~60 turns，产出 7 个源文件（~1000 行 TS）、17 个集成测试、5 轮专项代码审查、1 个 ADR。最终 PR #12 通过 CI lint check，gate PASS。

| Phase | Turns | Key Output | Gate |
|-------|-------|------------|------|
| 1 (Spec) | ~12 | spec.md (17 AC), ADR-010 | PASS (v2, v1 had 5 MUST FIX) |
| 2 (Plan) | ~8 | plan.md (5 tasks), e2e-test-plan.md (13 scenarios) | PASS |
| 3 (Dev) | ~21 | bash-async/ (7 files, ~1000 lines), 5-step review | PASS (after 3 rounds fixing 7 MUST FIX) |
| 4 (Test) | ~11 | 17/17 integration tests pass, unpipe bug fix | PASS |
| 5 (PR) | ~8 | PR #12, CI pass | PASS |

### Cross-Phase Themes

#### 1. API Discovery 是贯穿始终的摩擦点

- Phase 1：spec v1 选错 API（BashOperations.exec → child_process.spawn 重写）
- Phase 2：plan 阶段才发现 `getShellConfig` 已导出，Task 2 改为复用
- Phase 3：编码时才确认 `truncateTail`/`DEFAULT_MAX_LINES` 可导出，`getShellEnv`/`getBinDir` 不可导出
- Phase 5：无需 API 发现

**根因**：Pi 没有公开的 API 文档，每次需要 `grep` 源码确认导出状态。5 个 phase 中有 3 个因此返工。

**建议**：在 Phase 1 开始时做一次完整的 API export scan（`grep "export" packages/coding-agent/src/index.ts`），产出一份可用函数/类型清单。后续 phase 直接引用。

#### 2. Stream Lifecycle 是最大的技术风险

`stdout → pipe(writeStream) + on("data", capture)` 这个双消费者模型在 3 个 phase 中引发问题：

- Phase 3 Round 2：`removeAllListeners("data")` 破坏了 pipe listener（MUST FIX）
- Phase 4 TC-12：`writeStream.destroy()` 未先 unpipe，触发 ERR_STREAM_DESTROYED

**根因**：Node.js stream 的 listener 管理在代码审查中容易被忽略——pipe() 内部注册匿名 listener，removeAllListeners 会误删。

**教训**：涉及 stream 的代码应在 plan 阶段画出 listener lifecycle diagram，而非依赖 review 发现。

#### 3. "简单路径"决策正确

plan 有 5 个 task（达到 subagent-driven 阈值），但选择了主 agent 直接执行。理由：全部后端、紧密顺序依赖、总代码量 ~550 行。事后验证：

- 避免了 5 次 subagent cold start（每次 ~30s + context 传递开销）
- 编码中发现的跨 task 问题（如 spawnCommand 接口变更影响 3 个调用点）可以即时修复
- 3 轮 review 迭代中，主 agent 对代码上下文的完整记忆加速了修复

**建议**：subagent-driven 阈值应加入"总代码量"维度。当前仅看 task 数量，对紧密耦合的后端任务不公平。

### Problems by Phase

| Phase | Top Problem | Root Cause | Resolution |
|-------|-------------|-----------|------------|
| Spec | API 选型错误 | 未预先扫描 Pi exports | 全面重写 FR-1 |
| Plan | getShellConfig 误判为不可用 | 复用 spec 的错误假设 | 改为直接复用 |
| Dev | removeAllListeners 破坏 pipe | 修复内存泄漏时引入回归 | removeCapture() 精确移除 |
| Dev | YAML must_fix 语义不一致 | reviewer 理解为"原始数量" | 改字段为 must_fix_resolved |
| Test | ERR_STREAM_DESTROYED | writeStream.destroy 未先 unpipe | unpipe + destroy |
| PR | 无显著问题 | — | — |

### What Would You Do Differently Overall

1. **Phase 1 前加一步 "API Export Scan"**：30 秒的 `grep` 能避免 Phase 1 的 API 选型错误和 Phase 2 的 getShellConfig 返工。

2. **Phase 2 plan 中增加 "Stream Listener Lifecycle" 章节**：画出 stdout 的 listener 注册/移除时序图，明确 pipe listener vs capture listener 的生命周期差异。

3. **Phase 3 编码前加 "Resource Management Checklist"**：error handler → exit handler → stream cleanup → listener removal。这 4 项覆盖了 Round 1 的 4/6 MUST FIX。

4. **Phase 4 测试应覆盖 ENOENT 场景**：当前 template 的 TC-12 虽然存在，但如果 Phase 3 的 review 能运行 ENOENT 集成测试，unpipe bug 就不会泄露到 Phase 4。

### Key Risks (Post-Merge)

1. **未经 Pi 运行时验证**：所有代码通过 tsc + eslint + 集成测试，但未在实际 Pi 会话中运行。`registerTool("bash", ...)` 覆盖内置工具的行为、`renderCall`/`renderResult` 的渲染、`session_start` 闭包重建——这些都需要 Pi 运行时验证。

2. **Windows 兼容性**：`killProcessGroup` 有 Windows 分支（taskkill），但 `detach: true` 在 Windows 上被禁用，且 `getShellConfig` 的 Windows 路径逻辑未测试。

3. **多 session 状态隔离**：`jobs.ts` 的 job map 在 `session_start` 闭包中创建，理论上是 session-scoped 的，但未在多 session 环境中验证。

## 2. Harness Usability Review (Overall)

### Flow Friction

整体流程流畅度随 phase 推进而提升：

- **Phase 1-2（设计）**：摩擦较大——brainstorming skill 的"one question at a time"在技术性需求中略显死板，writing-plans skill 的 Interface Contracts 对 L1 项目偏重
- **Phase 3（编码）**：流畅——主 agent 直接编码，五步审查并行执行，review 迭代高效
- **Phase 4（测试）**：流畅——TC template schema 清晰，test_execution.json 格式明确，gate 一次 PASS
- **Phase 5（PR）**：流畅——CI 预检 → PR 创建 → CI 等待 → evidence 编写，8 turns 完成

**最大摩擦点**：Phase 1 的 API 选型错误导致 spec 全面重写。这不是 harness 流程的问题，而是技术探索的固有成本——但如果 harness 有 "API Export Scan" 预检步骤，可以减少返工。

### Gate Quality

5 个 gate 全部通过，但有 1 次 false FAIL：

| Phase | Gate Result | Notes |
|-------|------------|-------|
| Spec v1 | FAIL | 5 MUST FIX（API 选型错误）—— 正确拦截 |
| Spec v2 | PASS | — |
| Plan | PASS | — |
| Dev v1 | FAIL | standards_review_v2 must_fix:2（语义不一致）—— false FAIL |
| Dev v2 | PASS | — |
| Test | PASS | — |
| PR | PASS | — |

**Dev gate false FAIL**：reviewer 将 `must_fix` 理解为"本轮发现的原始 MUST FIX 数量"（=2），gate 脚本期望"当前未解决数量"（=0）。根因是 review YAML schema 对 `must_fix` 的语义定义不够明确。

**建议**：review YAML template 应明确注释 `must_fix: 当前未解决的 MUST FIX 数量（已修复的不计入）`。

### Prompt Clarity

- **Phase 1 (brainstorming)**：对探索性需求很合适，但对"技术性需求"（如"覆盖内置 bash 工具"）有些过度——用户已明确知道要做什么，brainstorming 的"propose 2-3 approaches"步骤才是核心价值。
- **Phase 2 (writing-plans)**：L1 路径指引清晰，但 6 个交付物对 L1 项目偏多（use-cases.md 和 non-functional-design.md 信息密度不高）。
- **Phase 3 (dev)**：skill 指引简洁——"实现 plan 中的 task，通过 review，调用 gate"。五步审查的 prompt 指引有效。
- **Phase 4 (test)**：`test_execution.json` schema 表格非常实用，常见错误列避免了格式陷阱。但 TC template 的 `type: "manual"` 语义模糊。
- **Phase 5 (pr)**：步骤清晰，YAML 字段说明表（含常见错误）有效。

### Automation Gaps

1. **API Export Scan 无自动化**：每个 phase 都需要手动 `grep` Pi 源码确认导出状态。一个 "scan Pi exports" 工具可以节省 ~3 turns。

2. **Test Runner 无模板**：Phase 4 需要从零编写测试框架（assert helpers、test() wrapper、cleanup）。一个 minimal scaffold 可以节省 ~2 turns。

3. **Review YAML Schema 无自动验证**：gate 因 must_fix 语义不一致而 false FAIL，如果有 JSON schema 校验 reviewer 输出，可以避免。

4. **CI 等待是手动的**：`sleep 30 && gh pr checks` 的轮询模式。如果 gate tool 能自动等待 CI 完成再检查，可以节省 ~1 turn。

5. **Phase 5 分支管理**：本项目在 main 上直接开发（扩展仓库的常见模式），但 PR skill 假设有独立 feature branch。需要创建 base branch 来模拟 PR，额外消耗 ~2 turns。Skill 应支持 "direct-to-main" 模式。

### Time Sinks

| Phase | Time Sink | Turns Wasted |
|-------|-----------|-------------|
| Spec | Pi 源码深度扫描 | ~4 |
| Dev | removeAllListeners 修复-重审循环 | ~4 |
| Dev | YAML must_fix 语义修复 | ~1 |
| Test | ERR_STREAM_DESTROYED 调试 | ~3 |
| Test | ESLint unused vars 修复 | ~1 |
| PR | 分支创建 + base branch 模拟 | ~2 |

**总计约 15 turns 用于返工/修复**，占总 60 turns 的 25%。主要根因是两类：(1) API/stream 相关的技术探索成本（~9 turns），(2) 格式/schema 相关的流程摩擦（~3 turns）。

### Top 3 Improvement Recommendations for Harness

1. **增加 "API Export Scan" 预检步骤**（Phase 1 前）：自动扫描目标平台的导出列表，产出可用 API 清单。预计节省 ~9 turns（3 个 phase 的返工）。

2. **Review YAML schema 增加注释 + 自动验证**：`must_fix` 字段明确为"当前未解决数量"，reviewer 输出前用 JSON schema 校验。预计节省 ~1 turn/phase。

3. **支持 "direct-to-main" PR 模式**：扩展仓库通常在 main 上开发，不需要 feature branch。Skill 应允许 `pr_created: true` + `merge_method: direct`（直接 main commit，无需 PR）。预计节省 ~2 turns。
