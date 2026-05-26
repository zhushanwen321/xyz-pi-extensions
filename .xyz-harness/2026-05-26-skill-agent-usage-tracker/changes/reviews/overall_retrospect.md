---
phase: pr
verdict: pass
---

# Overall Retrospect — Skill & Agent Usage Tracker

## 1. Phase Execution Review (全流程)

### Summary

5 个 Phase 全部完成，从 spec 到 PR。最终交付：usage-tracker extension（被动采集 skill 加载和 agent 调用计数）+ usage-analyzer skill（分析框架）。核心 bug 在 Phase 4 发现并修复（Pi 的 `tool_call` 事件不覆盖 custom tools）。PR: https://github.com/zhushanwen321/xyz-pi-extensions/pull/4

### 各 Phase 执行评估

| Phase | 关键产出 | MUST FIX 数 | 核心问题 |
|-------|---------|------------|---------|
| 1 (Spec) | spec.md, use-cases.md, non-functional-design.md | 2 | 并发竞争、时序风险 |
| 2 (Plan) | plan.md, test_cases_template.json, e2e-test-plan.md | 1 | skillMap 空 guard 缺失 |
| 3 (Dev) | usage-tracker/ (3 files), usage-analyzer/ (1 file) | 3 | initialized 时序、resolve(undefined)、静默 catch |
| 4 (Test) | test_execution.json (10 TC) | 1 (运行时 bug) | tool_call 不覆盖 custom tools |
| 5 (PR) | PR #4, pr_evidence.md, ci_results.md | 0 | 无 CI pipeline |

### 跨 Phase 主题性问题

**1. Spec 假设 vs 运行时行为（贯穿 Phase 1→4）**

最严重的问题。Phase 1 spec 基于 Pi 文档推断 `tool_call` 事件覆盖所有工具（包括 subagent），Phase 2 plan 基于此假设设计实现方案，Phase 3 dev 按此实现，Phase 4 test 才发现假设错误——Pi 只对 7 个内置工具 emit `tool_call`。修复代价：改用 `tool_execution_start` 事件。

根因：spec 阶段没有做技术 spike 验证平台事件行为。对于"依赖外部平台事件系统"的功能，文档推断不够，必须运行时验证。

**2. 审查 ROI 与复杂度不匹配（Phase 3）**

~150 行代码做了 5 步专项审查（BLR + Standards + Taste + Robustness + Integration），其中 Taste 和 Robustness 产出都是 "pass, 0 issues"。对 L1 复杂度项目，审查流程偏重。BLR 产出的 2 条 MUST FIX 有价值，但 19 项 gate check 对这种规模过重。

**3. Manual test 验证深度不足（Phase 4）**

10 个 TC 中 6 个通过代码审查替代运行时验证。Phase 3 的 5 步审查和 Phase 4 的代码审查都没有发现 `tool_call` 不覆盖 custom tools 的问题——这只能通过运行时验证发现。Pi Extension 缺少自动化测试框架是根本限制。

### What Would You Do Differently (全局)

1. **Phase 1 增加技术 spike**：对 Pi 事件系统做一个最小化验证扩展（10 行代码），可以在 5 分钟内避免 Phase 4 的核心 bug。投资回报极高。
2. **审查流程分级**：L1 项目只跑 BLR + Standards，L2 才跑完整 5 步。节省 Phase 3 约 40% 的时间。
3. **Manual test 分两类**：一类是"可运行时验证"（如 TC-1-01 skill 计数，当前 session 就能验证），一类是"只能代码审查"（如 TC-3-01 写失败不崩溃）。前者优先实际运行，后者才用审查替代。不要因为都是 manual 就统一用代码审查。

### Key Risks (Post-Merge)

- **`tool_execution_start` 方案未经运行时验证**：API 文档说对所有工具生效，但当前 session 中无法确认。用户需要在新 Pi session 中触发一次 subagent 调用并检查 `usage-stats.json`。
- **read-before-write 无文件锁**：跨 Pi 进程的极端并发仍可能丢失计数。spec 已文档化为已知限制。
- **stats 文件会持续增长**：没有 GC 机制，长周期使用后文件会越来越大。可以考虑按时间窗口裁剪。

## 2. Harness Usability Review (全局)

### Flow Friction

- **Reviewer skill 分散在不同 workspace**：BLR/Standards/Robustness/Integration 在 `xyz-harness-engineering-workspace`，Taste 在 `~/.pi/agent/skills/`。每个 Phase 都需要手动查找路径。应该在 harness 配置或 CLAUDE.md 中集中记录。
- **Gate 脚本路径硬编码**：每次调用 `check_gate.py` 都需要写完整路径。可以考虑加到 PATH 或项目 script 中。
- **Phase 3 五步审查对 L1 过重**：4 并行审查 subagent + 修复 + 2 并行 v2 审查，流程步骤数与代码量不成比例。

### Gate Quality

- Phase 1-2 gate 有效拦截了 spec 和 plan 中的问题。
- Phase 3 gate 的 19 项检查全面但过重，L1/L2 不区分。
- Phase 4 gate 的 cross-reference 检查（template case vs execution record）设计精巧，有效防止了遗漏。
- Phase 5 gate 最简单（2 项），对无 CI 的项目需要手动声明 `ci_configured: false`。
- **`must_fix` 字段语义不一致**（Phase 1 就提到）：review subagent 和 gate 脚本对 `must_fix` 的理解不同（累计数 vs open 数）。这仍然是未修复的 harness 层面问题。

### Prompt Clarity

- Spec 和 Plan phase 的 skill 指导质量高，渐进提问有效。
- Dev phase 的"简单路径 vs 复杂路径"判断清晰。
- Test phase 对 manual TC 的验证方式指导不足——没有明确说明如何处理"只能代码审查"的情况。
- PR phase 步骤简洁明确，CI 预检步骤有用。

### Automation Gaps

- **无自动化测试框架**（Pi 平台限制，不是 harness 缺口）。
- **无 CI pipeline**：项目没有 `.github/workflows/`，所有检查依赖本地运行。可以在后续 PR 中补齐。
- **审查 subagent 构造需要重复劳动**：每个 review subagent 的 task prompt 都需要手动写文件路径和审查方法论。可以考虑模板化。

### Time Distribution

| Phase | 估计耗时占比 | 核心耗时点 |
|-------|------------|-----------|
| 1 (Spec) | 20% | Pi API 类型定义阅读、3 轮 review |
| 2 (Plan) | 15% | e2e-test-plan 编写、2 轮 review |
| 3 (Dev) | 35% | 5 步审查 + 修复 + v2 审查循环 |
| 4 (Test) | 20% | TC-1-02 诊断（tool_call 不覆盖 custom tools） |
| 5 (PR) | 10% | commit + push + create PR |

Phase 3 和 Phase 4 占了 55% 的时间，其中审查循环和 bug 诊断是主要耗时点。如果 Phase 1 做了技术 spike，Phase 4 的 bug 诊断时间可以省掉，Phase 3 的审查轮次也可能减少（因为不会有基于错误假设的代码）。

### Positive Surprises

- **Skill 计数零配置生效**：安装 extension 后，Phase 3 的审查 subagent 自动产生了真实测试数据（`ts-taste-check: 1`）。被动采集的设计使得测试数据自然积累。
- **Spec → Plan → Dev 的一致性**：3 个 Phase 的交付物（spec 的 FR/AC → plan 的 Task/Step → dev 的代码实现）追溯链完整，没有断层。
