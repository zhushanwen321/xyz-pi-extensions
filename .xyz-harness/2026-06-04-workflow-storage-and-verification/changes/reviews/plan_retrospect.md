---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-04-workflow-storage-and-verification"
harness_issues:
  - "No automated cross-validation between plan sections (AC Coverage Matrix ↔ spec AC list, File Structure ↔ task Files, Data Flow ↔ Interface Contracts). v1 review caught 3 cross-section inconsistencies manually. Suggest: gate check add a verifier that extracts section cross-refs and validates they exist."
  - "Retrospect is still triggered manually by user, not auto-dispatched after gate PASS (same as Phase 1)."
  - "writing-plans skill L1/L2 评估表清晰且容易执行,但 L1 → 单文件 plan 的实现路径很快导致 plan.md 超过 30KB(本次 37KB)。建议 L1 plan 拆 sub-section 文件的阈值从'L2 才拆'改为'L1 超过 25KB 也要拆'。"
  - "plan.md '禁止实现代码' 规则靠自我约束,缺少自动化检查。建议: gate check 时对 plan.md 跑一次 Python AST 解析或简单的 regex(找 `{` 紧跟 `function`/`class`/`=>` 等实现模式),提示 reviewer 关注。"
---

# Phase 2 Retrospect — Plan

## Phase Execution Review

### Summary

Phase 2 完成了 5 个 deliverable 的一次性产出 + 2 轮 review + 修复 + 提交 + gate PASS,总耗时约 1 小时。

**5 个 deliverable:**
- `plan.md`(L1 master,37KB,8 tasks 跨 5 groups,完整 Interface Contracts + AC Coverage Matrix + Spec Metrics Traceability + Wave Schedule)
- `use-cases.md`(5 UC 完整覆盖 spec AC 1.x/2.x/3.x/4.x/5.x)
- `non-functional-design.md`(5 维度:稳定性/数据一致性/性能/业务安全/数据安全,无空话)
- `e2e-test-plan.md`(6 E2E 场景,覆盖 24 AC)
- `test_cases_template.json`(32 个 test case,API/integration/manual 三种类型)

**Complexity assessment:** 5 维度全在 L1 → 单 plan.md,无 L2 拆分。

**ADR 评估:** 扫描 5 项决策,全部不满足"难以逆转 / 无上下文会惊讶 / 真实权衡"三条件 → 不创建 ADR(评估步骤严格执行,产出可为空)。

### Problems Encountered

**P1: AC-1.5 幽灵引用(3 个文件)**
- 现象:我在 plan.md 的 AC Coverage Matrix 加了"AC-1.5"行,e2e-test-plan.md 的 E2E-1 coverage 列出"AC-1.5",test_cases_template.json 的 TC-1-08 描述写"AC-1.5 (FR-1.5 backward compat)"。
- 根因:Spec 中 FR-1 有 FR-1.1 ~ FR-1.7 共 7 个 FR,但 AC 只有 AC-1.1 ~ AC-1.4 共 4 个 AC(因为 FR-1.5 backward compat 的行为已被 AC-1.3 覆盖,不需要独立 AC)。我**未**先 grep spec 验证 AC 编号,直接脑补了一个 AC-1.5。
- 影响:跨 3 个文件的不一致引用,review 才能抓到。
- 解决:v1 review → v2 修复(全部改回 FR-1.5 + 标注"covered by AC-1.3")。

**P2: File Structure 表 BG2-T4 遗漏 index.ts**
- 现象:File Structure 表中 BG2-T4 行只列 `orchestrator.ts`(modify),但任务的 Implementation outline 明确写道"`index.ts:reconstructState` 重构",Subagent 配置的"修改/创建文件"栏也列出 `index.ts`。
- 根因:写 File Structure 表时,我**先**把任务描述写完(包含跨文件说明),**再**回头填表,但填表时只看了任务标题"B2-T4: External state storage + AgentPool injection",没回去读 Implementation outline 找所有"修改的文件"。
- 影响:plan 的 File Structure 表与任务内容不一致,reviewer 无法从表判断真实影响范围。
- 解决:v1 review → v2 修复(添加 index.ts 行,加"跨文件变更说明"段落,标注行号范围隔离 BG2-T4 vs BG3-T5)。

**P3: Data Flow Chain 缺 maybeEmitSoftWarning 调用链**
- 现象:Interface Contracts 中有 `AgentPool.maybeEmitSoftWarning` 的签名,但 Data Flow Chain 的 AgentPool 部分只展示了 `dispatch() → totalCallCount += 1`,**不**包含 `maybeEmitSoftWarning` → `onSoftLimitReached` → `pi.sendUserMessage` 的完整流转。
- 根因:Data Flow Chain 中,我**只**展示了"在 dispatch 中 increment counter"这个机械步骤,没把"increment → maybeEmitSoftWarning → callback → orchestrator.pi.sendUserMessage"作为**一个完整 call chain**画出来。
- 影响:Data Flow Chain 不完整,FR-4 的核心触发机制没法从数据流图直接看出。
- 解决:v1 review → v2 修复(在 dispatch 块后追加 4 层缩进的 `maybeEmitSoftWarning` → 阈值判断 → 回调 → 注入代码)。

### What Would You Do Differently

1. **写 plan 前先 grep spec 列出所有 AC/FR 编号清单,作为 cross-check 工具**。v1 抓到 AC-1.5 ghost 引用是因为我没做这步。如果在 plan 写之前就有一份 `spec_actual_ac = [1.1, 1.2, 1.3, 1.4, 2.1, ..., 6.3]`,在 plan 中引用任何 AC 时可以即查即用,不会凭脑补。
2. **File Structure 表**用 checklist 形式生成:每个 task 写完 Implementation outline 后,自动把 outline 中提到的所有文件路径(grep `\`.*\.ts\`` / `\`.*\.md\``)填入 File Structure 表的对应行,而不是凭记忆填。
3. **Data Flow Chain**反向构造:先把 Interface Contracts 列出的所有公有方法(method 名 + class)做成"必须出现在 Data Flow 中"的 checklist,然后逐个 method 写出调用链,确保零遗漏。

### Key Risks for Later Phases

| 风险 | 触发条件 | 缓解 |
|------|----------|------|
| **BG2-T4 / BG3-T5 共同改 index.ts,可能冲突** | 两 task 都 modify 同一文件 | plan 已用行号范围隔离(BG2-T4:99-124,BG3-T5:155-180 + 484-642)。Phase 3 dev 时严格执行 |
| **External file 路径依赖 sessionDir,Pi 平台可能变化** | sessionDir 解析方式变化 | plan 阶段假设 `import.meta.url` + ctx 路径解析,实现时用 `ctx.cwd` 或 `import.meta.dirname` |
| **persistState() 改 async 后,所有调用点必须 await** | orchestrator 中 ~7 处调用点 + index.ts 1 处 | plan 已标注"find all callers and add await"。实现时 grep `persistState()` 验证 |
| **stub 改动可能影响其他 7 个扩展** | shared/types/mariozechner/index.d.ts 是共享桩 | plan BG1-T2 已包含"`pnpm -r typecheck` 全包验证" |
| **Soft Warning callback 内部 throw 影响 dispatch** | onSoftLimitReached 抛错 | plan TC-4-03 显式测试"callback 抛错不影响 dispatch" |
| **PI approve 集成: pi.sendUserMessage 在 force mode 跳过 confirm** | force 模式用户可能误用 | plan UC-2 AP-2.3 已说明"force 是显式跳过 confirm" |

---

## Harness Usability Review

### Flow Friction

**F1: 仍无 auto-trigger 的 retrospect subagent**
- 现象:Phase 2 gate PASS 后,系统提示"Write the retrospect per the steer instructions",但需要用户手动提醒"now execute the retrospect for Phase 2"才能开始。
- 影响:本次用户连续 2 个 phase 手动触发 retrospect,如果忘记可能漏掉。
- 严重度:中。

**F2: 跨 section 一致性靠手工**
- 现象:plan.md 内有 6+ 章节(Background / File Structure / Interface Contracts / Data Flow Chain / AC Coverage Matrix / Spec Metrics Traceability / Wave Schedule / Tasks),每章节都可能引用 spec 的 AC 编号、文件路径、interface 方法名。我**没**有自动校验工具,只能靠 review 抓不一致。
- 严重度:中(每次 v1 review 都有 1-3 个 cross-section 不一致)。

### Gate Quality

- **Phase 2 gate 跑 10 项检查** — 全过。✅
- **正确识别 L1** — `plan_bl_review: skipped (complexity=L1)`,正确跳过 L2 专属检查。✅
- **正确识别 32 test cases** — `test_cases_template.json: 32 cases, all have id/type/title`,JSON 解析+字段校验都过。✅
- **没识别 plan 内部 cross-section 不一致** — gate 只检查文件存在 + frontmatter,不做内容深度校验。这与设计 trade-off(深度校验由 review subagent 负责)一致。✅

### Prompt Clarity

**PC1: writing-plans skill 模板清晰** — Header / File Structure / Interface Contracts / Tasks / Wave Schedule 都有模板。Task 的 5-step TDD 模式可读性高。

**PC2: L1 vs L2 评估表清晰** — 5 维度表直接对照 spec 决策,本次 5 项全在 L1,直接出 L1 plan。

**PC3: "禁止实现代码" 规则明确** — Self-Check Checklist 中明确列出。interface signatures 不算实现,这是关键豁免,我遵循了。

**PC4: ADR 评估步骤明确** — 三条件 + 评估方法可执行。本 spec 5 决策都不满足,明确写"no ADR needed"。

**PC5: e2e-test-plan.md / test_cases_template.json 模板清晰** — YAML frontmatter 字段表 + JSON schema 都给出。

### Automation Gaps

**AG1: Cross-section 一致性验证(同 Phase 1 重复)**
- 现象:plan.md 6+ 章节的 cross-ref 靠人。v1 review 抓到 3 个(AC-1.5 ghost / File Structure 漏 / Data Flow 缺)。
- 建议:gate check 加 1 个 step,提取 plan.md 中所有 `(state|orchestrator|index|agent-pool|tool-generate).ts:N` / `AC-N` 引用,验证它们:
  1. 引用目标文件存在
  2. AC 编号在 spec.md 的 AC 列表中存在
  3. File Structure 表覆盖所有 task Implementation outline 中提到的文件

**AG2: Retrospect auto-trigger 仍未实现** (同 Phase 1 F1)

**AG3: "实现代码"自动检测**
- 建议:gate check 时对 plan.md 跑 `python3 -c "..."`,用 regex 找疑似实现代码(如包含 `function.*{` + `return` + `//` 等模式),给 reviewer 标红。

### Time Sinks

| 耗时项 | 时长 | 原因 | 可优化 |
|--------|------|------|--------|
| 5 个 deliverable 写 | ~30 min | 内容多(plan.md 37KB) | 可拆 subagent 并行(写 use-cases / non-functional / e2e-test-plan),但主 agent 单独写连贯性更好 |
| v1 review 抓 3 issue | ~3 min | subagent 跑 review | 已经自动化 |
| 修 3 issue + 重写 v2 | ~5 min | 都是文档准确性调整 | 见 AG1: 自动化校验可减至 0 |
| commit + push | ~1 min | 正常 | 已最优 |

总 ~40 min,合理范围。

---

## Improvement Suggestions (for harness maintainers)

1. **Cross-section consistency verifier**: 在 `check_gate.py` 中新增 step,提取 plan.md 的所有 cross-ref 引用(AC-N / file:N / method-name),验证其在 spec / source / Interface Contracts 中存在。Phase 2 的 AC-1.5 ghost + File Structure 漏 + Data Flow 缺 都能被这个 verifier 在 gate 阶段抓住,无需 review 抓。

2. **Retrospect auto-trigger** (同 Phase 1): coding-workflow 扩展应在 gate PASS 后自动 dispatch retrospect subagent,不需要用户手动说 "now execute the retrospect"。

3. **L1 plan size threshold**: L1 模式鼓励"单 plan.md 文件",但当 plan 接近 30KB 时(5+ FR),子文档(`plan-detail-X.md`)拆分能减少 30% 写入耗时。本次 37KB 是临界点,下次类似规模应主动拆 sub-doc(plan-data-model.md / plan-state-machine.md 等)。

4. **Implementation code detector**: 在 gate check 中加 1 行 Python regex 找疑似实现代码(`function.*{.*return.*}`,`class.*{.*\n.*\n.*}`,`=>.*\{.*return.*`),给 reviewer 标红(不强制 fail,但提示 review 时关注)。这能在写 plan 时"自我纠正"实现冲动,而不是靠 review 抓。

5. **File Structure 自动生成**: writing-plans skill 的 File Structure 表可以反向自动生成——主 agent 只写 Task Implementation outline 段落,File Structure 表由 subagent 解析 outline 中提到的所有文件路径,自动填表。这能消除"Implementation outline 包含文件但 File Structure 表漏"的不一致(本次 v1 review 抓到的 P2 就是这种)。
