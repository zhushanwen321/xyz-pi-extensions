---
verdict: fail
must_fix: 4
reviewer: content-quality-reviewer
review_mode: plan_feasibility
date: 2026-06-11
files_reviewed:
  - plan.md
  - e2e-test-plan.md
  - test_cases_template.json
  - use-cases.md
  - non-functional-design.md
  - spec.md (cross-check)
  - plan-mode-design.md (cross-check)
---

# Plan Review v1 — Pi Plan Mode Extension

## 执行摘要

本次审查针对 Phase 2 (Plan) 的 5 份 deliverable 进行 **plan feasibility** 维度的内容质量评估。整体来看，plan.md 思路清晰、覆盖面广、任务分解符合 TDD 流程，e2e-test-plan 和 use-cases 提供了基本的验证和场景锚点。但审查发现 **4 个阻断性问题** 和 **10 个改进项**，主要矛盾集中在三处：

1. **plan.md 的任务依赖图与代码 import 关系不一致** — Task 3/4 引用了 Task 5/6 才创建的模块，按 plan 描述的串行依赖无法独立编译。
2. **use-cases.md 与 design.md 严重脱节** — design.md 列出 11 个 UC，use-cases.md 仅覆盖 4 个，7 个核心场景缺失。
3. **e2e-test-plan.md 多处场景缺乏可执行性** — AI 行为验证、Pi 多 session 模拟、compact 失败模拟等关键路径没有可落地的验证策略。
4. **test_cases_template.json 缺少 expected_result 字段** — 18 个 test case 全部缺少期望输出，无法直接驱动自动化测试。

**Verdict: fail**。建议修复 MUST_FIX 后重新提交。

---

## 评估总览

| 文件 | 评价 | 关键问题 |
|------|------|---------|
| plan.md | 思路清晰，但任务依赖图错误 | Task 3/4 引用 Task 5/6 模块；Task 2 描述不实 |
| e2e-test-plan.md | 9 个场景齐全，但可执行性差 | AI 行为、session 模拟、compact 失败均缺验证策略 |
| test_cases_template.json | 18 个 case 覆盖 11 个 AC | 缺 expected_result、priority、negative test |
| use-cases.md | 4 个 UC，模板质量高 | 缺失 7 个 UC（design.md 列出 11 个） |
| non-functional-design.md | 5 个维度覆盖基础 | 缺可扩展/可维护/可观测/兼容性/资源管理维度；业务安全评估错误 |

---

## MUST_FIX (4 项，阻断)

### MUST_FIX-1: plan.md 任务依赖图与代码 import 关系不一致

**文件:** `plan.md`  
**位置:** Task 3、Task 4 的代码示例；"Execution Flow (BG1 内部)" 段落

**问题描述:**

plan.md 在 "Execution Groups → BG1" 中描述：

> Task 3 (depends on Task 1)  
> Task 4 (depends on Task 1, Task 2)

但 Task 3 的 tool.ts 实际代码（plan.md 第 671-673 行）包含：

```typescript
import { listTemplates, loadTemplate } from "./templates.js";   // Task 5 才创建
import { handlePlanComplete } from "./compact.js";               // Task 6 才创建
import { updatePlanWidget } from "./widget.js";                  // Task 5 才创建
```

Task 4 的 command.ts（第 828 行）包含：

```typescript
import { updatePlanWidget } from "./widget.js";                  // Task 5 才创建
```

Task 4 的 index.ts（第 948-951 行）包含：

```typescript
import { registerPlanTool } from "./tool.js";                    // Task 3 创建
import { registerPlanCommand } from "./command.js";              // Task 4 自身
import { registerPlanEventHandlers } from "./compact.js";       // Task 6 才创建
import { updatePlanWidget } from "./widget.js";                  // Task 5 才创建
```

**实际依赖关系（应调整 plan.md）：**

```
Task 1 (state + 包结构) ← 无依赖
Task 5 (templates + widget) ← Task 1
Task 6 (compact) ← Task 1, Task 5
Task 3 (tool) ← Task 1, Task 5, Task 6
Task 4 (command + index) ← Task 1, Task 3, Task 5, Task 6
```

**为何必须修复:**  
如果 subagent 按 plan.md 描述的依赖关系执行 Task 3，会发现 import 失败但无明确处理方案。`tsc --noEmit` 会因未实现的 module 报错，导致 `pnpm --filter @zhushanwen/pi-plan typecheck` 失败，pre-commit hook 阻断。subagent 会被迫在 Task 3 中临时实现 templates.ts、compact.ts、widget.ts 的 stub，但这与 Task 5/6 的实际实现会产生代码重复和冲突。

**修复建议:**

1. **重排任务顺序**: 将 templates、widget 提到 Task 3 之前，compact 提到 Task 4 之前。  
2. **或: 调整 BG 分组**: 把 BG1 拆为 BG1a (state + templates + widget) + BG1b (tool + command + compact)。  
3. **更新 "Spec Coverage Matrix"**: Task 列需反映新的依赖关系。  
4. **更新 "Dependency Graph & Wave Schedule"**: 调整 Wave 顺序。

---

### MUST_FIX-2: use-cases.md 严重缺失核心业务场景

**文件:** `use-cases.md`  
**对比文件:** `plan-mode-design.md`

**问题描述:**

plan-mode-design.md（第 20-117 行）明确定义了 **11 个 UC**（UC-1 至 UC-11），涵盖：

| UC | design.md 中的描述 | use-cases.md 是否覆盖 |
|----|---------------------|----------------------|
| UC-1 | 新功能实现规划（核心场景） | ✅ UC-1 |
| UC-2 | 复杂 Bug 修复规划 | ✅ UC-2 |
| UC-3 | 重构规划 | ❌ 缺失 |
| UC-4 | 快速方案探索（不写代码） | ✅ UC-3（命名差异） |
| UC-5 | 已有设计文档的实现计划 | ✅ UC-4（命名差异） |
| UC-6 | Plan 迭代修改（用户中途要求修改章节） | ❌ 缺失 |
| UC-7 | 中途切换到 Plan Mode（对话中途输入 /plan） | ❌ 缺失 |
| UC-8 | 取消 Plan Mode | ⚠️ 仅作为 alternative path |
| UC-9 | 查看已有 Plan（/plan 无参数检测已有文件） | ❌ 缺失 |
| UC-10 | Plan 完成后进入实现 | ⚠️ 仅作为 UC-1 步骤 11 |
| UC-11 | 非代码任务规划 | ❌ 缺失 |

**为何必须修复:**

1. **UC-6 (Plan 迭代修改)**: design.md 标注频率"高"，是核心交互模式。涉及"已写章节回头修改"逻辑（spec FR-3.4 已写完的章节可以回头修改），但 use-cases.md 没有对应场景。Phase 3 dev 阶段可能漏掉该功能。

2. **UC-7 (中途切换到 Plan Mode)**: design.md 标注频率"中"，spec FR-1.8 要求"重入时先读已有 plan 文件，判断是新任务覆盖还是同一任务迭代"。当前 plan.md 在 Task 4 中实现了"检测 /tmp 下 plan-*.md 并提示用户选择"，但 use-cases 没有相应场景驱动该行为。

3. **UC-9 (查看已有 Plan)**: 涉及 spec FR-1.3 重入逻辑的核心 — "若当前不在 plan mode，检测已有 plan 文件并提示用户选择（继续/实现/新建/取消）"。use-cases 缺失意味着 AC-11 多 session 隔离的子场景没有业务背书。

4. **UC-11 (非代码任务规划)**: design.md 列举了"会议纪要、文档结构"等非代码场景。如果 use-cases 缺失，Phase 3 可能只实现代码场景，遗漏通用规划能力。

**修复建议:**

1. 在 use-cases.md 中补充 UC-3（重构）、UC-6（迭代修改）、UC-7（中途切换）、UC-9（查看已有 Plan）、UC-10（完成后实现）、UC-11（非代码任务）。  
2. 或者明确说明为什么缩减（哪些 UC 合并到现有 4 个中），并在每个合并后 UC 的 Alternative Paths 中列出被合并场景的差异化处理。  
3. 更新 AC 覆盖映射表，覆盖新的 UC。

---

### MUST_FIX-3: e2e-test-plan.md 多场景缺乏可执行性

**文件:** `e2e-test-plan.md`  
**位置:** TS-2、TS-3、TS-5、TS-6、TS-7、TS-9

**问题描述:**

多个测试场景的验证策略不明确或不可自动化：

1. **TS-2 (Brainstorming 流程)** 第 2 步："验证 AI 先执行代码探索（grep/read）"  
   - **缺失:** 怎么捕获 AI 的工具调用顺序？需要 Pi 的工具调用日志还是 hook 拦截？

2. **TS-2** 第 3 步："验证 AI 提问时区分探索能回答的和需要用户偏好的"  
   - **缺失:** 怎么量化"区分"？需要 LLM-as-a-judge 吗？

3. **TS-3** 第 2 步："验证 AI 按章节顺序填写"  
   - **缺失:** plan 文件没有写入时间戳机制，靠什么判断"顺序"？

4. **TS-5 (Complete + Compact)** 第 4-5 步："验证 compact 成功执行" / "验证新上下文中 AI 读取 plan 文件"  
   - **缺失:** 怎么观测 compact 是否成功？怎么观测"新上下文"？  
   - 需要 Pi 平台支持 session snapshot / context trace 才能验证。

5. **TS-6 (Compact 失败降级)** 第 1 步："模拟 compact 失败"  
   - **缺失:** 具体的 mock 策略是什么？需要修改 Pi 核心还是注入测试 stub？

6. **TS-7 (Goal API 启动)** 第 1 步："确保 goal extension 已安装"  
   - **缺失:** e2e 测试在哪个环境运行？dev 环境？CI？需要预先安装 pi-goal。

7. **TS-9 (多 Session 隔离)** 第 1-2 步："在 session A 进入 plan mode"  
   - **缺失:** Pi 是否支持同时多 session？具体 API 是什么？是 `pi session new` 命令还是 extension 主动 fork？  
   - 整个测试场景的可行性未经验证。

**为何必须修复:**

e2e-test-plan 是 Phase 4 (test) 的执行依据。如果这些测试场景的验证方法不明确，Phase 3 实现的代码可能"看起来通过"但实际不可观测。Phase 4 测试编写 subagent 会发现大量场景无法自动化，导致测试覆盖度大幅下降。

**修复建议:**

1. 每个 TS 增加 **"验证方法"** 段落，明确：
   - 自动化 / 人工 / LLM judge  
   - 工具调用日志注入方式  
   - mock 策略（如需要）  
2. 对 TS-5/TS-6/TS-9 标注"需要 Pi 平台支持 X 能力"，并降级为"如果在 Pi 当前版本无法验证，则跳过或转为 integration test"。  
3. TS-9 多 session 隔离如果 Pi 暂不支持，应明确改为"通过 PlanSessionMap 单测验证 + 文档说明手动验证步骤"。

---

### MUST_FIX-4: test_cases_template.json 缺少 expected_result 字段

**文件:** `test_cases_template.json`  
**影响范围:** 全部 18 个 test case

**问题描述:**

当前 schema 仅有 `id`、`type`、`title`、`description`、`steps`，缺少：

1. **`expected_result`** — 自动化测试需要明确期望值。例如 TC-1-01 "Enter plan mode with /plan command"，步骤是 `["Execute /plan with description", "Check state.isActive is true", ...]`，但 `isActive === true` 是隐含的，没有显式 expected_result。

2. **`priority`** — 18 个 test case 无优先级，Phase 4 无法区分 must-pass / nice-to-have / regression-only。

3. **`ac_coverage`** — 已有覆盖关系但分散在 steps 中没有结构化字段。

4. **negative test case 缺失** — 全部 18 个都是 happy path。`plan.md` 中大量 `throw new Error` 路径（未知 action、模板不存在、templateName 为空等）没有对应 test case。

**为何必须修复:**

`test_cases_template.json` 是 Phase 4 测试编写的模板。缺少 expected_result 意味着每个测试编写者要自行推断期望值，导致：

- 同样的 AC 被不同 subagent 实现为不同测试断言  
- 测试覆盖不一致  
- Phase 4 gate check 难以判定"哪些 TC 必须通过"

negative test 缺失意味着错误处理路径没有自动化覆盖，与项目"所有 throw new Error 路径必须有测试"的标准（来自 `taste-lint` 规则）不一致。

**修复建议:**

1. 每个 test case 增加 `expected_result` 字段（结构化对象或字符串）。  
2. 增加 `priority` 字段（`must-pass` / `should-pass` / `regression`）。  
3. 至少增加 6 个 negative test case：  
   - TC-N-01: Unknown action throws error  
   - TC-N-02: select-template with non-existent template  
   - TC-N-03: create-template with empty templateName  
   - TC-N-04: create-template with path traversal characters  
   - TC-N-05: /plan abort when not in plan mode (no-op)  
   - TC-N-06: loadTemplate with invalid project dir

---

## SHOULD_FIX (10 项，不阻断但建议修复)

### SHOULD_FIX-1: extension-dependencies.json 声明与代码硬依赖不一致

**文件:** `plan.md` Task 0 Step 2

**问题:**

```json
{
  "name": "@zhushanwen/pi-plan",
  "dependsOn": [
    { "name": "@zhushanwen/pi-goal", "type": "optional" }
  ]
}
```

但 `compact.ts` 中：

```typescript
const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
if (goalInit) {
  goalInit(...);
}
```

代码逻辑是 "if available, call; if not, skip"。声明为 optional 是合理的（有降级路径），但需要明确：

- `optional` 是因为运行时检测（plan 可独立运行）  
- **不应**误读为"goal 是 nice-to-have 功能"。plan 的核心场景 UC-1 都依赖 goal 启动。

**建议:** 在 plan.md 的 Task 0 Step 2 增加注释，说明 optional 的具体含义（运行时检测 + 缺失降级，不是功能降级）。

---

### SHOULD_FIX-2: non-functional-design.md 业务安全评估错误

**文件:** `non-functional-design.md` 第 4 节

**原文:**

> **风险:** AI 可能违反约束执行写入操作（概率低）。

**问题:**

LLM 违反提示词约束是常见现象，不是"概率低"。经验上：

- 提示词约束的依从率约 70-90%（取决于模型和复杂度）  
- 涉及"我会记得不写"这类被动约束，依从率更低  
- "Plan Mode 期间禁止编辑非 plan 文件" 是个 soft constraint，AI 完全可能误判

**建议:**

1. 修改为"概率中等"  
2. 缓解措施除"用户在 review 时可发现并 abort"外，增加：  
   - 在 TUI widget 中持续显示 "[Plan Mode - READ ONLY]"（视觉强化）  
   - plan.md Task 6 的 SKILL.md 中要求 AI 每次写工具调用前自我提醒（prompt-level guard）  
   - 文档明确："plan mode 不做 tool_call 拦截是 spec FR-8.2 的设计选择，违反约束需要 abort 处理"

---

### SHOULD_FIX-3: non-functional-design.md 多个 NFR 维度缺失

**文件:** `non-functional-design.md`

**缺失维度:**

1. **可扩展性:** 模板数量增长（>50 个）时性能？新增 plan action 时如何不破坏 API？  
2. **可维护性:** 模块已按 state/tool/command/compact/widget 拆分，应在 NFR 中明确。测试覆盖率目标？  
3. **可测试性:** plan extension 是否易于测试？需要 mock 的依赖（pi 对象、ctx）？  
4. **可观测性:** Plan mode 进入/退出/abort/complete 应有日志或 metrics，当前完全无显式日志。  
5. **兼容性:** Pi 旧版本兼容？Windows /tmp 路径（`%TEMP%`）？  
6. **错误处理:** 除 compact 失败降级外，appendEntry 失败、状态文件损坏、template 文件 I/O 错误等路径未讨论。  
7. **资源管理:** Plan 文件在 /tmp 不主动清理 — /tmp 长期积累风险未讨论。  
8. **国际化:** SKILL.md 默认语言？模板默认语言（feature-plan.md 是英文）？  
9. **跨 extension 契约稳定性:** `__goalInit` 通过 `(pi as Record<string, unknown>)` 访问是 hack，pi-goal 重构时 plan 会静默失败。

**建议:** 在 v2 中补充上述维度，每项 1-2 段即可。

---

### SHOULD_FIX-4: plan.md Task 2 描述不实

**文件:** `plan.md` Task 2

**原文:**

> **Type:** backend  
> **Files:**  
> - Modify: `extensions/plan/src/index.ts`  
> - Test: `extensions/plan/src/__tests__/state.test.ts` (extend)

**问题:**

Task 1 已完整实现 `persistPlanState` 和 `reconstructPlanState`（plan.md 第 462-490 行）。Task 2 的 Step 1 只是在 `state.test.ts` 中**追加测试**（plan.md 第 547-588 行），不修改 index.ts 也不引入新功能。

但 Task 2 描述为"State 持久化与重建（per-session）"，像是新功能任务。实际是测试增量任务。

**建议:**

明确标注 "Task 2 类型: test-only (覆盖 Task 1 实现的 persistPlanState/reconstructPlanState 的测试分支)"，或合并到 Task 1。

---

### SHOULD_FIX-5: plan.md compact.ts 中 API 签名需验证

**文件:** `plan.md` Task 6

**问题:**

`compact.ts` 代码示例中：

```typescript
ctx.compact({
  customInstructions: ...,
  onComplete: () => { ... },
  onError: (_error: Error) => { ... },
});
```

`onError: (error: Error) => void` 签名是基于假设。plan.md 引用了"参考 coding-workflow compact 逻辑"，但未在 plan.md 中引用具体代码行号或签名文档。

类似地：

```typescript
pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
```

`deliverAs: "steer"` 选项的有效性需验证。

**建议:**

1. 在 plan.md 引用 `extensions/coding-workflow/lib/tool-handlers.ts` 的具体行号和 `ctx.compact` 实际签名。  
2. Phase 3 实施前，subagent 需先 read 实际 API 验证签名，不要照搬 plan.md 示例。

---

### SHOULD_FIX-6: use-cases.md Module Boundaries 不完整

**文件:** `use-cases.md` 每个 UC 的 Module Boundaries 字段

**问题:**

所有 UC 的 Module Boundaries 都是 "plan extension, goal extension"，但实际涉及：

- **pi-ask-user** — brainstorming 阶段提问（spec FR-2.3）  
- **pi-subagents** — 实现阶段并行（spec FR-6.1）  
- **Pi 核心 ctx.compact** — 上下文隔离（spec FR-5.3）  
- **Pi 核心 session_before_compact handler** — 压缩摘要（spec FR-5.6）

**建议:** 补充所有相关 module，让 Phase 3 实施 subagent 知道完整依赖。

---

### SHOULD_FIX-7: use-cases.md UC-3 "搜索相关资料" 含义不明

**文件:** `use-cases.md` UC-3

**原文:** "AI 搜索相关资料"  

**问题:** "资料" 指什么？网络搜索？读 README？spec 中没明确 plan mode 是否支持网络搜索（WebFetch / WebSearch 工具）。

**建议:** 明确 "AI 探索代码 + 阅读项目文档"。如果需要外部搜索，标注为软能力（依赖 Pi 是否配置 WebSearch 工具）。

---

### SHOULD_FIX-8: e2e-test-plan.md 缺少错误路径测试

**文件:** `e2e-test-plan.md`

**问题:** 9 个 TS 全部是 happy path。`plan.md` 中以下错误处理路径未覆盖：

- TS-N-1: `plan` tool 未知 action 抛错  
- TS-N-2: `select-template` 模板不存在  
- TS-N-3: `create-template` 模板名为空 / 含非法字符  
- TS-N-4: `select-template` / `create-template` 缺必填参数  
- TS-N-5: /plan abort 时未在 plan mode  

**建议:** 补充 negative test scenarios。

---

### SHOULD_FIX-9: plan.md /tmp 资源管理

**文件:** `plan.md` Task 4 command.ts 代码

**问题:** Plan 文件生成在 `/tmp/plan-{slug}.md`，无清理机制：

- 长期使用 Pi 会在 /tmp 积累大量 plan 文件  
- slug 截断到 30 字符可能产生冲突（"添加用户认证" vs "添加用户管理"）  
- 不同 OS（macOS /tmp 1-3 天清理一次 vs Linux 视配置）行为不同

**建议:**

1. 在 plan.md 中明确 /tmp 清理责任（OS 自动 / 用户手动 / 退出 plan mode 时清理）。  
2. 如果不清理，在 NFR 文档中加一段 "资源管理" 说明累积风险。  
3. slug 截断 30 字符可能产生 hash 后缀避免冲突：`plan-{slug}-{shortHash}.md`。

---

### SHOULD_FIX-10: plan.md Task 0 changeset 版本号

**文件:** `plan.md` Task 0 Step 3

**原文:**

```markdown
---
"@zhushanwen/pi-plan": minor
---
```

**问题:** 新包首次发布，changeset 通常用 `patch`（如果是 bug 修复）或 `minor`（如果是新功能）。plan mode 是新功能，`minor` 是合理的。但与 monorepo 其它新包（如 `extensions/structured-output/` 首次发布）对比，确认 convention 一致。

**建议:** 验证 monorepo 历史新包的 changeset convention 保持一致。

---

## NICE_TO_HAVE

1. **test_cases_template.json schema 定义:** 顶层增加 `version` / `created_at` / `schema` 字段，便于版本管理。  
2. **use-cases.md UC 关系图:** 用 mermaid 描述 4 个 UC 之间的降级关系（如 UC-4 spec 不存在 → 降级到 UC-1）。  
3. **plan.md 性能数字:** 给出具体的性能预算（"listTemplates < 50ms @ 20 files"），而不仅是"性能无问题"。  
4. **e2e-test-plan.md TS-9 降级方案:** 如果 Pi 不支持多 session，改为"通过 PlanSessionMap 单测 + 手动验证文档"。

---

## 修复优先级建议

| 优先级 | 项目 | 工作量 |
|--------|------|--------|
| P0 | MUST_FIX-1（任务依赖图） | 中（重排 4-5 个 Task + 更新 BG/Wave） |
| P0 | MUST_FIX-2（UC 缺失） | 中（补充 6-7 个 UC + 更新 AC 映射） |
| P0 | MUST_FIX-3（e2e 可执行性） | 中（每个 TS 增加验证方法段） |
| P0 | MUST_FIX-4（test case 字段） | 小（schema 升级 + 18 个 case 补字段 + 6 个 negative） |
| P1 | SHOULD_FIX-2（NFR 业务安全） | 极小 |
| P1 | SHOULD_FIX-3（NFR 多维度） | 中（补 5-6 个维度） |
| P2 | 其它 SHOULD_FIX | 分散 |

---

## 总结

plan 的核心思路和架构决策是正确的（5-phase subagent-driven、TDD、per-session 状态、spec 覆盖矩阵）。但 4 个 MUST_FIX 反映的是**计划的可执行性**和**交付物的完整性**问题 — 这是 Phase 3 subagent 执行前的最后质量关。

建议**集中修复 MUST_FIX 后重交 v2**。SHOULD_FIX 可在 v2 中选择性修复，不阻断 Phase 3 启动。
