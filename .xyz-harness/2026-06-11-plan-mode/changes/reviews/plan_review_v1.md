---
verdict: fail
must_fix: 1
---

# Plan Review v1 — Pi Plan Mode Extension

## 评审记录

- 评审时间：2026-06-11
- 评审类型：Plan 评审（Mode 1: Plan review — 验证 plan 可行性）
- 评审对象：`.xyz-harness/2026-06-11-plan-mode/plan.md` + 4 个配套交付物
- 评审模式：独立评审（独立于既有的 v1~v6 review 历史）
- 配套文档：`spec.md`、`e2e-test-plan.md`、`test_cases_template.json`、`use-cases.md`、`non-functional-design.md`

## 总体评估

plan.md 整体设计质量高：8 个 Task、3 个 Execution Group（BG0/BG1/BG2）、Spec Coverage Matrix 11/11 覆盖、Interface Contracts 完整、TDD 步骤清晰、单 session 隔离用 `PlanSessionMap`、模板系统三级优先级、SKILL.md 含 ask_user + subagent 检测、create-template 路径遍历防护、`__goalInit` 调用模式与 coding-workflow 对齐——架构设计完整。

**但存在一个阻断级架构缺陷**：plan 自我宣称的"BG0 → BG1 → BG2 无循环依赖"在代码层面被打破——BG1 内的 Task 3（`tool.ts`）和 Task 4（`command.ts`）的 import 语句直接依赖 BG2 的 `templates.ts`、`compact.ts`、`widget.ts`。按 plan 的 Wave 调度（Wave 2 = BG1, Wave 3 = BG2），Wave 2 完成的文件在运行时会因找不到 BG2 模块而失败。**这是必须修复才能进入 dev 的问题。**

## MUST_FIX（阻断级）

### M1: BG1 跨组依赖违反（BG1 → BG2）—— 阻断

**位置**：`plan.md` File Structure 表（行 33–34、Files 实际归属）；Task 3 Step 3 `tool.ts` import 段（行 689–697）；Task 4 Step 1 `command.ts` import 段（行 855–861）；Wave 调度（行 259–266）

**问题**：

plan 显式声明"BG1: 核心状态管理"、"BG2: 模板 + Compact + TUI + SKILL"，依赖方向为 `BG0 → BG1 → BG2`。File Structure 表也按此分组：

| 文件 | Group |
|------|-------|
| `src/tool.ts` | BG1 |
| `src/command.ts` | BG1 |
| `src/templates.ts` | BG2 |
| `src/compact.ts` | BG2 |
| `src/widget.ts` | BG2 |

但 Task 3 Step 3 的 `tool.ts` 实现代码显式 import 了 BG2 的三个模块：

```typescript
// extensions/plan/src/tool.ts (Task 3 Step 3，行 691–696)
import { listTemplates, loadTemplate } from "./templates.js";   // ← BG2 (Task 5)
import { handlePlanComplete } from "./compact.js";               // ← BG2 (Task 6)
import { updatePlanWidget } from "./widget.js";                  // ← BG2 (Task 5)
```

Task 4 Step 1 的 `command.ts` 也依赖 BG2：

```typescript
// extensions/plan/src/command.ts (Task 4 Step 1)
import { updatePlanWidget } from "./widget.js";                  // ← BG2 (Task 5)
```

Wave 调度（行 264–266）规定：

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 2 | BG1 | 核心状态管理，依赖 BG0 |
| Wave 3 | BG2 | 模板+Compact+TUI+SKILL，依赖 BG1 |

**矛盾点**：Wave 2 subagent 创建 `tool.ts` 时，`templates.ts` / `compact.ts` / `widget.ts` 尚未存在。TypeScript 编译能通过（type stub 全部 `any`），但：
1. **运行时** `node` 加载 `tool.ts` 时会 `ERR_MODULE_NOT_FOUND`
2. **subagent 隔离** —— plan 要求每个 Task 派遣独立 subagent，BG1 subagent 不知道 BG2 的设计，可能自己写简化版 stub（"missing import" lint 失败 → 跳过 → 产出 broken code）
3. **test runner** —— Task 3 的 `tool.test.ts` 即使只测常量也会触发 module resolution，进而 fail

**为什么这是阻断**：

CLAUDE.md 明确"Subagent 使用约束：子任务间明确依赖关系：无依赖并行，有依赖串行"。BG1→BG2 的隐式依赖是 plan 设计缺陷，不是 subagent 配置可绕过的。

**修复方案**（任选一个）：

| 方案 | 改动 | 代价 |
|------|------|------|
| **A. 重新分组** | 把 `templates.ts` / `widget.ts` 移到 BG1（与 `state.ts` 同组），`compact.ts` 留在 BG2。`tool.ts` 和 `command.ts` import 改成只引用 BG1 模块；tool.ts 的 `complete` handler 中改为 dynamic import `compact.js` 解决剩余依赖 | 1 文件重组 + tool.ts 改 dynamic import |
| **B. 显式 stub 步骤** | 在 BG1 增加 Task X"创建 stubs"：创建 `templates.ts`/`compact.ts`/`widget.ts` 的最小占位实现（只导出类型和空函数），BG2 再覆盖为完整实现 | 1 个新 Task |
| **C. 改 dynamic import** | `tool.ts` 在 `complete` handler 中用 `await import("./compact.js")` 延迟加载；其他 import 也改为函数内调用，避免 module-level 依赖 | 改 2–3 处 import |

**推荐 A**：最干净，符合"BG1 = 状态+tool+command 注册，BG2 = templates/compact 业务实现 + SKILL/UI"的合理分层。tool.ts 在 `complete` 分支 dynamic import compact.js，避开编译期依赖。

**附加建议**：plan 现有 Task 6 的 `compact.ts` 同时导出 `registerPlanEventHandlers` 和 `handlePlanComplete`，且被 Task 4 的 `index.ts` 引用（行 894: `import { registerPlanEventHandlers } from "./compact.js"`）—— 这也是 BG1→BG2 依赖。修复 M1 时一并处理。

---

## SHOULD_FIX（不阻断但应修复）

### S1: State machine "writing" 阶段是死代码

**位置**：`plan.md` 行 55（`PlanPhase` 类型定义）、Task 3（tool.ts `select-template` handler 行 779-786）

**问题**：`PlanPhase = "idle" | "brainstorming" | "writing" | "complete"` 包含 "writing"，但运行时没有任何代码将 phase 切换到 "writing"：

| 设置点 | 文件:行 | 新值 |
|--------|---------|------|
| 进入 plan mode | `command.ts:944` | `"brainstorming"` |
| complete action | `tool.ts:793` | `"complete"` |
| abort action | `tool.ts:805` | `"idle"` |
| abort command | `command.ts:876` | `"idle"` |
| **select-template** | `tool.ts:784` | **未设置 phase（仍为 brainstorming）** |

唯一出现 "writing" 的代码是测试（行 378、611）—— 用作 fixture 数据，但运行时永远不会进入。

**影响**：
- TUI 状态栏（FR-10）无法区分"brainstorming 中"和"writing 中"，与 FR-2.10 描述的"进入 Phase C 的条件"不匹配
- 用户体验上：从 brainstorming 切到 writing 时无任何视觉反馈

**建议**：在 `tool.ts` 的 `select-template` handler 成功路径添加 `state.phase = "writing"; persistPlanState(pi, state);`，让状态机如实反映"已选模板、开始写 plan"的语义。

### S2: `isolation` 参数缺 `StringEnum` 约束

**位置**：`plan.md` 行 727，tool.ts `parameters` schema 定义

**问题**：

```typescript
isolation: Type.Optional(Type.String({ description: "Context isolation method for complete: compact, tree, direct" })),
```

项目已有 `pi-ai` 的 `StringEnum` 工具（type-lint 通过：`shared/types/mariozechner/index.d.ts:125` 声明 `export function StringEnum`），其他 extension 的 tool 普遍用 `StringEnum` 限定枚举值（如 `extensions/goal`、`extensions/coding-workflow`）。这里用 `Type.String` 让 AI 可以传任意字符串，typebox 不做校验。

**影响**：
- AI 传 `"compct"` 拼写错误会进入 default 分支 `"direct"`，**静默降级**——既不报错也不警告
- 与 CLAUDE.md "类型即契约" 不一致
- e2e-test-plan.md TS-5/6 验证"compact 成功/失败"分支时，缺 StringEnum 保护会让隔离方法的可测性变差

**建议**：

```typescript
import { StringEnum } from "@mariozechner/pi-ai";
// ...
isolation: Type.Optional(StringEnum(["compact", "tree", "direct"] as const, {
  description: "Context isolation method for complete",
})),
```

### S3: Tool handler 单元测试严重不足

**位置**：`plan.md` Task 3 Step 1（行 654–668）

**问题**：`tool.test.ts` 仅测 4 个 case，且全是 action 枚举和 `validateAction` 工具函数：

```typescript
it("PLAN_ACTIONS contains all required actions", ...);
it("validateAction returns true for valid actions", ...);
it("validateAction returns false for invalid actions", ...);
```

**5 个 action handler 没有任何单元测试**：
- `list-template`：未测
- `select-template`：未测（状态变更、templateName 校验、模板不存在 throw）
- `create-template`：未测（**路径遍历防护**、sanitize 逻辑是安全关键）
- `complete`：未测（状态推进、isolation 传递、session 隔离）
- `abort`：未测（状态重置、widget 清理、session.delete 调用）

**影响**：
- `create-template` 的 `replace(/[^a-zA-Z0-9_-]/g, "")` 路径遍历防护无测试——一旦 subagent 实现时漏掉，`../../etc/passwd` 类攻击可能成功
- `abort` 状态重置是核心安全功能（避免 cancel 后状态泄漏），无回归保护

**建议**：为以下 4 个 case 补单元测试：
- `create-template` 拒绝 `../../../etc/passwd` 路径（mock fs）
- `select-template` 模板不存在时 throw 含模板名的 Error
- `complete` 推进 state.phase = "complete" 并调用 handlePlanComplete
- `abort` 重置 isActive/phase/planFilePath/requirement/templateName 全字段

### S4: e2e-test-plan 缺乏客观断言方法

**位置**：`e2e-test-plan.md` 全部 9 个 TS

**问题**：所有 TS 步骤使用主观/不可机器执行的断言：

| TS | 步骤 | 问题 |
|----|------|------|
| TS-1 | "验证 TUI 状态栏显示 `[Plan Mode]`" | 无 TUI 渲染快照捕获方法 |
| TS-2 | "验证 AI 先执行代码探索（grep/read）" | 无 AI 行为日志捕获 |
| TS-3 | "验证 AI 按章节顺序填写" | 无章节顺序断言方法 |
| TS-5 | "验证 compact 成功执行" | 未说明 compact 成功的客观标志（session entry 包含 compaction record?） |
| TS-6 | "模拟 compact 失败" | 未给出模拟方法（mock `ctx.compact`？环境变量？） |
| TS-7 | "验证 `__goalInit` 被调用" | 未给出"被调用"的客观标志（spy？session entry 包含 goal-init？） |
| TS-9 | "在 session A 进入 plan mode...session B 进入 plan mode" | 未说明如何触发多 session（开两个 Pi 进程？/tree fork？） |

**影响**：e2e 测试更像 checklist 而非可执行测试套件，dev 阶段无法机械验证"通过/失败"。

**建议**：为每个 TS 补充"**验证方法**"列，例如：
- TS-1: `inspect ctx.ui.getWidget("plan-mode")` 返回的 Text 节点包含字符串 `"[Plan Mode]"`
- TS-5: `inspect sessionManager.getEntries()` 找到 `type === "compaction"` 的最新 entry
- TS-6: 通过 `process.env.PI_PLAN_FORCE_COMPACT_FAIL=1` 让 `ctx.compact` 抛错（需在 plan 实现中加这个 dev-only hook）
- TS-7: 在 `__goalInit` 上加 spy，断言被调用 1 次且参数含 `planFilePath`
- TS-9: 启动两个 Pi 进程（不同 sessionFile），分别调 `/plan` 命令，inspect 各自 `sessionManager.getEntries()`

### S5: 5 个内置模板只展示 1 个

**位置**：`plan.md` Task 5 Step 3（行 1192）

**问题**：Task 5 创建 5 个内置模板（feature/bugfix/refactor/research/implementation），但代码块只展示 `feature-plan.md` 的内容，其余 4 个用"其他 4 个模板类似，各有不同的章节结构"带过。

**影响**：
- subagent 在执行时无明确指引，可能生成 5 个几乎相同（只改标题）的低差异化模板
- research-plan 应含"方案对比表"、bugfix-plan 应含"根因分析 + 复现步骤"、implementation-plan 应含"任务依赖图"——这些**结构性差异**是 spec FR-4.5 的核心价值
- 设计文档（`plan-mode-design.md`）可能已有各模板章节设计，plan 应直接引用或复制

**建议**：
- 选项 A：plan 直接列出 5 个模板的章节大纲（不写完整内容，但列出 `## 章节名` 行）
- 选项 B：在 Task 5 增加"参考 `docs/plan-mode-design.md` 第 X 节"链接，让 subagent 去读

### S6: `non-functional-design.md` 中 /tmp 权限描述错误

**位置**：`non-functional-design.md` 第 5 节"数据安全"

**问题**：

> Plan 文件权限继承 /tmp 目录默认权限（通常 755），无额外安全风险。

`/tmp` 目录默认权限是 `1777`（rwxrwxrwt，含 sticky bit），不是 `755`。755 是普通目录的默认权限（如 `/etc`）。

**影响**：评估"无额外安全风险"的依据错了。实际风险是：
- `/tmp` 是 world-writable，plan 文件内容对同机其他用户**可读**
- 若 plan 包含敏感设计（API key 位置、内网地址、token 流转逻辑），会被其他用户读到
- 建议在 non-functional-design 明确"plan 内容应避免包含明文密钥/令牌，敏感设计应脱敏"

**建议**：修正权限描述为 `1777`，并补一段"敏感信息防护"建议。

### S7: Tree 隔离路径无 e2e/test_cases 覆盖

**位置**：`e2e-test-plan.md`（无 TS-x 覆盖 tree 路径）、`test_cases_template.json`（无 TC-x 对应 tree）

**问题**：spec_review_v2 N2 已指出"AC 缺少 session_before_tree 路径的覆盖"，plan 继承了此缺口。Task 6 实现了 `session_before_tree` handler，但：
- e2e-test-plan 9 个 TS 全在覆盖 compact/direct/无隔离三种情况，无 TS 对应 tree
- test_cases_template 19 个 case 无 TC 对应 tree handler

**影响**：tree 隔离功能在 dev 阶段无回归保护。spec FR-5.4/5.7 描述的"tree 回退"功能在 dev 后无法机械验证。

**建议**：在 e2e-test-plan.md 补 TS-x "Complete + Tree"，test_cases_template.json 补 TC-x 覆盖：
- 用户选 tree 隔离 → `ctx.ui.notify` 显示"Use /tree to navigate" → 调用 `/tree` 触发 `session_before_tree` → handler 在摘要中注入 plan 文件路径

### S8: use-cases.md UC-4 描述的功能 plan 未实现

**位置**：`use-cases.md` UC-4 main flow step 2

**问题**：

> 2. AI 检测到已有 spec，跳过 brainstorming
> 3. 用户选择模板（implementation-plan）
> 4. AI 读取 spec.md

**plan Task 4 的 `/plan` command handler 不包含"检测 spec.md 存在 → 跳过 brainstorming → 进入 writing"的分支**。/plan command 进入时无条件 `state.phase = "brainstorming"`（行 944），且无任何代码去扫描 spec.md。

**影响**：UC-4 是 use-cases.md 承诺的功能，但 plan 无法兑现。

**建议**（任选一）：
- A. 在 plan Task 4 增加子逻辑：检测到 `/plan 实现 spec.md` 模式时，跳过 brainstorming 直接进 writing
- B. 在 SKILL.md（Task 7）让 AI 自行判断（"如果用户提到已有 spec.md，先读再决定是否跳过 brainstorming"），但这是提示词约束，AI 可能不遵守
- C. 在 use-cases.md 删除 UC-4（spec 本身未明确要求此功能）

最简洁是 C：spec 业务用例（spec.md 行 105-127）只列了 UC-1~UC-4 与当前 use-cases.md 一致，但 use-cases.md 把 UC-4 描述得比 spec 更具体。**两者出现分歧时以 spec 为准**——但应在 use-cases.md 加注脚说明"UC-4 的 spec 跳过逻辑由 SKILL.md 提示词驱动，无 command 级别强制"。

---

## INFO（参考性建议）

### I1: SKILL.md 缺"禁止写入类命令"清单

**位置**：`plan.md` Task 7 SKILL.md（行 1326–1373）

spec FR-8.1 明确："提示词告知 AI **禁止编辑非 plan 文件、禁止运行写入类命令**"。当前 SKILL.md 只写了 "READ-ONLY: Do NOT edit any files except the plan file. Do NOT run write commands."——**没有列举"哪些命令属于写入类"**。

建议补具体清单（删文件类、git commit/push、npm/pnpm install、数据库写操作等），降低 AI 误判概率。

### I2: `command.ts` 的 reentry 检测 `/tmp/plan-*.md` glob 过宽

**位置**：`plan.md` Task 4 Step 1（行 919–935）

`/tmp/plan-*.md` 会匹配到**同机其他项目/其他用户**的 plan 文件（`/tmp` 是共享的）。建议：
- 用 `os.tmpdir() + 用户名 + 进程 ID` 隔离目录
- 或文件名加 project hash：`/tmp/plan-${projectHash}-${slug}.md`

### I3: `loadTemplate` 静默返回 null（违反 no-silent-catch）

**位置**：`plan.md` Task 5 `templates.ts`（行 1107–1111）

```typescript
try {
  return fs.readFileSync(template.path, "utf-8");
} catch {
  return null;  // 静默失败，无日志
}
```

taste-lint `no-silent-catch` 规则禁止空 catch。应改为 `console.warn` 或 `ctx.ui.notify` 报告（虽然 templates.ts 不直接持有 ctx，可以引入可选 logger 参数）。

### I4: `select-template` 后 `state.phase` 未推进

与 S1 同源——若选择走 S1 修复（推进到 "writing"），此条自动解决。

---

## 维度统计

| 维度 | 数量 | 严重度 |
|------|------|--------|
| MUST_FIX | 1 | 阻断 dev |
| SHOULD_FIX | 8 | 不阻断 dev，但应修复 |
| INFO | 4 | 建议改进 |
| **总计** | **13** | — |

| 维度 | 评分（1-10） | 说明 |
|------|-------------|------|
| Spec 覆盖度 | 10 | 11/11 AC 全部映射到 task |
| 架构合理性 | 6 | 顶层设计优秀，但 BG1→BG2 跨组依赖是结构性缺陷 |
| TDD 步骤清晰度 | 7 | state/templates 测试完整；tool handler 测试严重不足 |
| 跨 extension 一致性 | 9 | `__goalInit`、`ctx.compact`、`setWidget` 等调用模式与 coding-workflow/goal 对齐 |
| 与 spec 一致性 | 8 | 大部分对齐；UC-4 与 spec 有微小分歧（S8） |
| 可执行性 | 5 | BG1→BG2 依赖阻断 + e2e 测试缺乏客观断言方法 |
| **综合** | **7.5** | 一次性 plan 偏上但有可执行的硬伤 |

---

## 关键正面观察

- **Spec Coverage Matrix 完整**：11 条 AC 全部映射到 task（行 124–133）
- **状态机设计正确**：`PlanSessionMap + reconstructPlanState` 满足 AC-11 多 session 隔离
- **create-template 路径遍历防护**：`replace(/[^a-zA-Z0-9_-]/g, "")` 防 `../../` 攻击
- **abort 双重入口**：`/plan abort` command + plan tool `abort` action 满足 FR-7.1/7.2
- **Goal API 调用模式与 coding-workflow 一致**：`(pi as unknown as Record<string, unknown>).__goalInit` 与 `extensions/coding-workflow/lib/tool-handlers.ts:504` 完全一致
- **session_before_compact / session_before_tree handler**：返回值签名与 Pi SDK 实际行为对齐（已验证 `agent-session.js:1288-1307` 和 `2194-2216`）
- **隔离方法选项丰富**：compact/tree/direct 三选项覆盖 FR-5.3/5.4/5.5

---

## 关键负面观察

- **BG1→BG2 跨组依赖是阻断级缺陷**（M1）—— plan 自我宣称的依赖结构与代码不一致
- **Tool handler 无单元测试**（S3）—— 安全关键（路径遍历）和状态机关键（abort 重置）逻辑无回归保护
- **E2E 测试缺乏客观断言**（S4）—— 9 个 TS 全是主观/不可机械执行的 checklist
- **5 个内置模板内容 80% 未明确**（S5）—— subagent 可能生成低差异化模板
- **Tree 路径无测试覆盖**（S7）—— 继承自 spec 的缺口，dev 后无法机械验证

---

## 结论

**Fail。** plan.md 的 1 个 MUST_FIX（M1: BG1→BG2 跨组依赖违反）必须在进入 dev 阶段前修复，否则 subagent 派遣会因找不到模块而失败，或生成 broken code 通过 tsc 但运行时崩溃。8 个 SHOULD_FIX 建议在 dev 过程中同步修复（特别是 S1/S2/S3 这三个改动小、价值高的项），以降低 dev 阶段的回滚成本。

**优先级建议**：
1. **M1**（必须修复）—— 推荐方案 A（重新分组：templates/widget 移到 BG1）
2. **S1**（低成本高价值）—— 5 行代码修复状态机
3. **S2**（低成本）—— 1 行 schema 替换
4. **S3**（中成本高价值）—— 补 4 个 unit test
5. **S4**（dev 阶段同步）—— e2e 测试补"验证方法"列
6. **S5**（dev 阶段同步）—— 5 个模板补章节大纲
7. **S6/S7/S8**（low）—— 可在 dev 末尾一并处理

---

## 评审元数据

```yaml
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-11T17:00:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  scope:
    - plan.md
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  cross_checked_with:
    - spec.md
    - extensions/coding-workflow/lib/tool-handlers.ts
    - extensions/coding-workflow/index.ts
    - extensions/goal/src/index.ts (lines 422 for __goalInit)
    - shared/types/mariozechner/index.d.ts
    - @earendil-works/pi-coding-agent/dist/core/agent-session.js (lines 1288, 1521, 2194 for event signatures)
  incremental: false
  independent: true
  summary: "plan 评审 fail。1 个 MUST_FIX（BG1→BG2 跨组依赖违反，阻断 dev），8 个 SHOULD_FIX（应修复但非阻断），4 个 INFO。MUST FIX 推荐方案 A：把 templates.ts/widget.ts 移到 BG1，tool.ts 改 dynamic import compact.js。"

statistics:
  total_issues: 13
  must_fix: 1
  should_fix: 8
  info: 4
  must_fix_resolved: 0
  low_inherited_open: 0
  low_new: 8
  info_new: 4

issues:
  - id: M1
    severity: must_fix
    title: "BG1 跨组依赖违反（BG1 → BG2）"
    blocks_dev: true
    recommended_fix: "方案 A：重新分组（templates/widget 移 BG1，tool.ts 改 dynamic import compact.js）"

  - id: S1
    severity: should_fix
    title: "State machine 'writing' 阶段是死代码（无代码路径设置）"
  - id: S2
    severity: should_fix
    title: "isolation 参数缺 StringEnum 约束（违反项目 typebox 约定）"
  - id: S3
    severity: should_fix
    title: "Tool handler 单元测试严重不足（5 个 action handler 零测试）"
  - id: S4
    severity: should_fix
    title: "E2E 测试步骤缺乏客观断言方法（不可机械执行）"
  - id: S5
    severity: should_fix
    title: "5 个内置模板只展示 1 个（subagent 可能生成低差异化模板）"
  - id: S6
    severity: should_fix
    title: "non-functional-design.md 中 /tmp 权限描述错误（755 应为 1777）"
  - id: S7
    severity: should_fix
    title: "Tree 隔离路径无 e2e/test_cases 覆盖（继承自 spec 缺口）"
  - id: S8
    severity: should_fix
    title: "use-cases.md UC-4 描述的功能 plan 未实现（spec.md 检测逻辑缺失）"

  - id: I1
    severity: info
    title: "SKILL.md 缺'禁止写入类命令'清单"
  - id: I2
    severity: info
    title: "/plan reentry 检测的 /tmp/plan-*.md glob 过宽（跨项目污染）"
  - id: I3
    severity: info
    title: "loadTemplate 静默 catch 返回 null（违反 taste-lint no-silent-catch）"
  - id: I4
    severity: info
    title: "select-template 后 state.phase 未推进（与 S1 同源）"
```
