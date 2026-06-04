---
phase: pr
verdict: pass
absorbed: false
topic: "2026-06-04-workflow-storage-and-verification"
harness_issues:
  - 'YAML frontmatter 是贯穿 5 个 phase 的持续性痛点：robustness_review 用 code block、dev_retrospect 含 three-dash、taste_review 文件名前缀不匹配。建议：coding-workflow 统一 frontmatter 校验工具（解析 + 命名 + 必填字段），一次修复全局生效。'
  - 'Retrospect 未自动触发，5 个 phase 全靠用户手动提醒。coding-workflow 声明 Auto Mode 但实际未实现。建议：gate PASS 后自动 dispatch retrospect subagent。'
  - 'Subagent ESLint 错误是可预见的重复性工作。建议在 subagent-driven-development skill 模板中注入 ESLint 约束段落（unused vars 加 _ 前缀、禁止 any、import 顺序）。'
  - 'Phase 3 test_results.md 和 Phase 4 test_execution.json 内容 90% 重叠但格式不同。建议统一为一种格式，Phase 4 只做 re-run 验证。'
  - 'coding-workflow-gate prior phase review 检查用硬编码前缀匹配（taste_review），但 ts-taste-check skill 输出 ts_taste_review。建议 reviewPrefix 支持 glob 或 alias。'
  - 'Gate check_gate.py 用 split 拆分 frontmatter，对内容中的 three-dash 极度脆弱。建议改用 yaml.safe_load 或 js-yaml 解析。'
---

# Overall Retrospect — Full Workflow (Phase 1-5)

## Project Overview

**Topic**: workflow-storage-and-verification
**Branch**: feat-workflow-upgrade
**Objective**: 为 `@zhushanwen/pi-workflow` v0.1.4 实现 5 项新能力（External State Pointer、Approval Gate、Verification Gate、Soft 500 Warning、Doc 沉淀）

**Final Deliverables**:
- 172/172 unit tests pass (32 new)
- 24/24 AC verified via 32 test cases
- 5-step specialized reviews all pass (0 must_fix)
- PR #36 created and CI passed
- TypeCheck 12/12 clean, ESLint 0 errors

---

## Phase-by-Phase Execution Quality

### Phase 1 (Spec) — ~45 min

**Accomplished**: 5 FR spec with 24 AC, 6.1-6.3 metrics. v1 review found 2 issues (行号引用错 + AgentPool 设计缺陷), v2 fixed.

**Key issue**: v1 review 抓出 AgentPool `this.pi.sendUserMessage` 假设（实际 AgentPool 不持有 ExtensionAPI），spec v2 改为 callback 模式。这是 spec 阶段最有价值的 catch — 如果在 dev 阶段才发现，返工成本是 10x。

**Verdict**: 顺利。review 机制在 spec 阶段就拦截了设计缺陷。

### Phase 2 (Plan) — ~40 min

**Accomplished**: 5 deliverables (plan.md 37KB, use-cases.md, non-functional-design.md, e2e-test-plan.md, test_cases_template.json). v1 review found 3 cross-section inconsistencies (AC-1.5 ghost, File Structure 漏 index.ts, Data Flow 缺 maybeEmitSoftWarning), v2 fixed.

**Key issue**: plan.md 37KB 单文件，接近可维护上限。L1 模式鼓励单文件但在这种规模下效率下降。AC-1.5 幽灵引用跨 3 个文件，说明 cross-section 一致性需要工具辅助。

**Verdict**: 顺利但偏重。plan 37KB 是 L1 模式的极限。

### Phase 3 (Dev) — ~85 min

**Accomplished**: 8 tasks via 4-wave subagent dispatch (5+1+1+1). 32 new tests, 5 specialized reviews, all pass.

**Key issues**:
- ESLint 错误循环（3 轮 commit 失败，~15 min）— subagent 不遵守 lint 规则
- robustness_review YAML 格式错误 — subagent 用 code block 而非 `---` 分隔符
- sessionDir 全局路径偏差 — subagent 没找到 spec 期望的 session-scoped 路径

**Verdict**: 最大 phase，也是摩擦最多的 phase。subagent 质量（ESLint、YAML 格式）是主要瓶颈。

### Phase 4 (Test) — ~15 min

**Accomplished**: 32/32 TC verified, test_execution.json + test_results_phase4.md produced.

**Key issues**: 3 个格式/命名问题阻塞启动（dev_retrospect YAML 解析、taste_review 前缀不匹配、test_execution.json 新格式要求）。全部是格式摩擦而非内容问题。

**Verdict**: 最短 phase，但纯格式修复占 80% 时间。

### Phase 5 (PR) — ~10 min

**Accomplished**: PR #36 created, CI lint-and-typecheck passed, pr_evidence.md + ci_results.md produced, gate PASS.

**Key issue**: 无。PR 创建、CI 等待、evidence 产出流程顺畅。

**Verdict**: 顺畅。coding-workflow 的 PR phase 流程设计合理。

---

## Overall Harness Usability

### What Worked Well

1. **5-phase 结构清晰**: Spec → Plan → Dev → Test → PR，每阶段有明确的 deliverable 和 gate check。没有"不知道下一步做什么"的情况。

2. **Review 机制有效**: Spec 阶段拦截了 AgentPool 设计缺陷，Plan 阶段抓到 3 个 cross-section 不一致，Dev 阶段 5 步审查覆盖了业务逻辑/标准/品味/鲁棒性/集成。review 是整个 harness 最有价值的环节。

3. **Gate check 可靠**: 18 项 check (Phase 3) / 5 项 check (Phase 4) / 3 项 check (Phase 5) 全部精准，无误报。untracked files、YAML 格式、verdict 字段的检查都是刚需。

4. **Subagent 驱动开发可用**: 8 个 task 通过 4 波 subagent dispatch 完成，Wave 1 的 5 个并行 task 节省了 ~50% 时间。subagent 输出质量基本可接受（除 ESLint 和 YAML 格式问题）。

### What Needs Improvement

#### 1. YAML Frontmatter 脆弱性（贯穿全程）

**出现次数**: 4 次（spec_retrospect 未触发但潜在风险、robustness_review code block、dev_retrospect three-dash、taste_review 前缀）

**根因**: gate 用 `split('---', 2)` 解析 frontmatter，对内容中的 `---` 极度脆弱。同时 reviewPrefix 硬编码不匹配实际 skill 输出。

**建议**: 
- 改用 `yaml.safe_load` 解析 frontmatter
- reviewPrefix 支持 glob（`*_taste_review`）或 alias
- harness_issues 字符串禁止包含 three-dash（或在 gate 中改用正则 `^---\s*$` 匹配 boundary）

#### 2. Retrospect 未自动触发（贯穿全程）

**出现次数**: 5 个 phase 全靠用户手动提醒。

**根因**: coding-workflow 声明 "Auto Mode: coding-workflow 扩展自动管理 loop"，但 retrospect dispatch 未实现。

**建议**: gate PASS 后自动 dispatch retrospect subagent，并在完成后自动 commit + push。

#### 3. Subagent ESLint 错误循环（Phase 3）

**出现次数**: 3 轮 commit 失败。

**根因**: subagent task prompt 未包含 ESLint 约束，subagent 自由发挥时产生 unused vars。

**建议**: subagent-driven-development skill 模板中注入 ESLint 约束段落（unused vars 加 `_` 前缀、禁止 `any`、import 顺序）。

#### 4. Phase 3/4 测试产出物重叠

**出现次数**: Phase 4 需要手写 test_execution.json，内容与 Phase 3 的 test_results.md 90% 重叠。

**建议**: 统一为 test_execution.json 格式，Phase 4 只做 re-run 验证（跑 `vitest run` + 确认结果未变）。

### Time Distribution

| Phase | 时长 | 占比 | 主要耗时项 |
|-------|------|------|-----------|
| Phase 1 (Spec) | ~45 min | 22% | spec 写作 + v1/v2 review |
| Phase 2 (Plan) | ~40 min | 20% | 5 deliverable 写作 + v1/v2 review |
| Phase 3 (Dev) | ~85 min | 42% | subagent dispatch + ESLint 修复 + 5 步审查 |
| Phase 4 (Test) | ~15 min | 7% | 格式修复 + test_execution.json |
| Phase 5 (PR) | ~10 min | 5% | PR 创建 + CI 等待 |
| Retrospects | ~8 min | 4% | 5 个 retrospect 写作 |
| **总计** | **~200 min** | — | — |

### Phase 3 Time Breakdown (最耗时 phase)

| 子项 | 时长 | 可优化 |
|------|------|--------|
| Subagent dispatch (4 waves) | ~40 min | 串行 task 间更快衔接 |
| ESLint 修复 (3 轮) | ~15 min | subagent prompt 加 lint 约束 → 0 |
| 5 步审查 dispatch | ~25 min | Integration 提前到 BLR 后并行 |
| Gate 修复 (YAML) | ~5 min | frontmatter 自动校验 → 0 |

---

## Cross-Phase Patterns

### Pattern 1: 格式问题占比过高

4 次 YAML/frontmatter 问题（Phase 3 的 robustness_review、Phase 4 的 dev_retrospect + taste_review 前缀 + test_execution.json），总计 ~20 min，占非核心工作时间的 ~30%。这些全部是格式摩擦而非内容问题。

**解决方案**: 一次投入 — 统一 frontmatter 校验工具 + reviewPrefix glob 匹配 + 测试产出物统一格式 — 可以消除后续所有同类问题。

### Pattern 2: Review 机制是最大价值点

- Spec v1 review 拦截 AgentPool 设计缺陷（避免 10x 返工）
- Plan v1 review 抓 3 个 cross-section 不一致
- Dev 5 步 review 覆盖 5 个维度，全部 pass 但找到 6+ 低优先级 issue
- Review 的 ROI 远高于 gate check（gate 检查格式，review 检查内容）

### Pattern 3: Subagent 质量与约束正相关

Wave 1 的 5 个并行 subagent（有详细 prompt：文件路径 + 修改内容 + 测试要求）产出质量高。Wave 2-4 的串行 subagent prompt 更短，偏差更大（sessionDir 全局路径、YAML 格式错误）。

**结论**: subagent prompt 越详细（文件路径、行号、修改内容、ESLint 约束、frontmatter 格式要求），产出质量越高。这是线性关系，不是边际递减。

---

## Improvement Suggestions (for harness maintainers)

### 高优先级（消除重复性摩擦）

1. **统一 frontmatter 校验**: 在 `check_gate.py` 中改用 `yaml.safe_load` 解析 frontmatter。在 coding-workflow gate 中将 reviewPrefix 改为 glob 匹配（`*_taste_review`）。一次修复，3 类问题全部消失。

2. **Retrospect 自动触发**: gate PASS 后自动 dispatch retrospect subagent。coding-workflow 已声明 Auto Mode，实现这一步即可。

3. **Subagent ESLint 模板**: 在 subagent-driven-development skill 的 task prompt 模板中加入 ESLint 约束段落，自动注入到所有编码 subagent。

### 中优先级（提升效率）

4. **测试产出物统一**: Phase 3 直接产出 test_execution.json 格式，Phase 4 只做 re-run + diff 确认。消除 90% 重复工作。

5. **Integration Review 时序**: 五步审查中，Integration 只依赖 BLR。BLR 完成后立即 dispatch Integration，不等其他 3 个。

6. **L1 plan size threshold**: L1 plan 超过 25KB 时主动拆 sub-doc（plan-data-model.md / plan-state-machine.md），不等到 L2 才拆。

### 低优先级（锦上添花）

7. **Cross-section 自动校验**: gate check 加 step，提取 plan.md 中所有 cross-ref（AC-N / file:N / method-name），验证其在 spec/source 中存在。

8. **P0 WARNING 级别**: gate 对 taste_review 的 P0 计数输出 WARNING（不 block 但醒目显示），帮助主 agent 决定是否处理。

9. **Spec 行号自动验证**: gate check 时提取 spec.md 中所有 `{file}:{N}` 引用，grep 验证行号正确性。

---

## Final Assessment

**整体评价**: 5-phase harness 流程在本次 feature 开发中表现良好。总耗时 ~200 min，其中核心工作（spec/plan/代码/测试）占 ~70%，格式摩擦占 ~15%，review/retrospect 占 ~15%。Review 机制是最有价值的环节，在 spec 阶段就拦截了关键设计缺陷。主要改进空间在自动化（ESLint 模板、frontmatter 校验、retrospect 自动触发），投入一次、长期受益。

**harness_issues 统计**: 5 个 retrospect 共计 24 条 improvement suggestion。去重后高优先级 6 条，中优先级 5 条，低优先级 4 条。最高频主题：YAML/frontmatter（6 次）、subagent 质量（4 次）、自动化（5 次）。
