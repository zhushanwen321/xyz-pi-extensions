---
name: lite-plan
description: >-
  Use when the user says "轻量计划", "lite plan", "小功能计划", "写测试计划",
  "Wave 拆分", "plan this feature", or is in plan mode brainstorming a small
  feature (no architecture change) and needs a plan.md with business goal,
  technical changes, Wave breakdown, and MANDATORY test design (unit cases +
  E2E cases + coverage gate). Produces plan.md consumed by lite-execute.
  Not for architecture-level changes — use design-* workflow instead.
  Not for execution itself — that is lite-execute.
---

# 轻量计划（Lite Plan）

## 核心目标

为**不涉及架构改动的小功能**产出一份 plan.md，含：业务目标、技术改动点（文件级）、Wave 依赖拆分、**完整的测试验收设计**（单测用例清单 + E2E 用例清单 + 覆盖率 gate）。

> **[铁律] 本 skill 只做计划，不写实现代码。** 测试用例只设计（输入/预期/类型），不写测试代码本身——那是 lite-execute 的 implementer 按 TDD 写的。
>
> **[铁律] 测试设计是重中之重。** plan.md 的测试章节不达标 = plan 未完成。验收标准全绿才算开发完成，而全绿的前提是 plan 里有可执行、可判定的测试清单。

## 适用范围（范围守门）

[MANDATORY] 写 plan 前先自检——本功能是否真的属于 lite 范围。以下任一出现 → **停止，建议改用 design 工作流**（design-init → design-clarity → ...）：

- 需要跨 2 个及以上子系统/模块协调
- 涉及状态机变更、核心数据模型变更、公共 API 契约变更
- 需要架构决策（技术选型、模块边界重新划分、依赖方向调整）
- 改动会影响 3 个以上既有文件的核心逻辑（非测试文件）
- 需要非功能设计（安全/并发/性能/稳定性等 NFR 风险分析）

> 详见 `../lite-shared/SKILL.md`「何时升级到 design」。范围判断错了，后面全白做。

## 前置

- 用户已在 plan mode（`/plan <需求>` 进入 brainstorming）
- 已 `plan(action='select-template', templateName='feature-plan')`（或 create-template）

## 执行流程

### Step 1. 探索 + 澄清业务目标

读相关代码（read/grep/bash），理解现状。与用户澄清：

```
业务目标（根）
├── G1: {目标} — 成功标准（可衡量，如"X 指标达到 Y"而非"做好 X"）
├── 约束 & 不做（明确边界，防 scope creep）
└── 技术约束（如"必须用 Postgres"——只记录不展开选型）
```

> [铁律] 不做架构设计。技术约束只记录到 Constraints，不展开技术选型/接口定义/数据建模。

### Step 2. 列技术改动点（文件级）

穷举本次需要**创建/修改**的文件，每个文件写明职责：

```
技术改动点：
- 创建 src/auth/login.ts — 登录逻辑（validateCredentials + issueToken）
- 修改 src/routes/index.ts — 挂载 /login 路由
- 创建 src/auth/login.test.ts — 登录单测
```

> 这是 Wave 拆分的依据。文件级粒度，不要漏（漏了 Wave 依赖推导会错）。

### Step 3. Wave 拆分（read `../lite-shared/references/wave-model.md`）

按 wave-model 的垂直切片原则，从技术改动点推导 Wave 表：

```
| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   | ...     | -    | G1     | ...  |
```

- 推导 blocked_by（看调用关系 + 文件影响集）
- 划分并行组（同组文件无交集 + 无调用依赖）
- 末尾强制加验收 Wave（blocked_by 所有功能 Wave）

### Step 4. 测试设计（read `../lite-shared/references/test-case-schema.md`）—— 重中之重

#### 4a. 单测用例清单

每个技术改动点至少 1 条单测（正常 + 异常 + 边界各有）。用 test-case-schema 的表格格式，每条可机器判定。

#### 4b. E2E 用例清单

按业务用例覆盖边界（happy path + 至少一个失败 path）。**先探测 E2E 框架**：

```
检查项目根/子包是否有 playwright.config.{ts,js} 或 cypress.config.{ts,js}
  - 有 → E2E 用例执行方式写 playwright 命令（npx playwright test e2e/<id>.spec.ts）
  - 无 → plan.md 标注「项目无 E2E 框架」，执行方式降级为 browser-automation / 手动
         并提示用户建议安装 Playwright
```

#### 4c. 覆盖率 gate

写明 gate 命令 + 阈值（增量 ≥ 60%）。

### Step 5. 写 plan.md（用下方强制模板）

用 write 工具写入 plan extension 指定的 planFilePath。**必须包含全部 6 个章节**。

> **[MANDATORY] plan.md 必须用 `## 实现步骤` 标题。** 这是 plan extension `extractPlanSteps` 唯一识别的标题——plan(complete) 时它从这里提取步骤传给 goal。用别的标题会导致 plan→goal 桥接断裂。

### Step 6. 自检

plan.md 写完后，对照下方 Self-Check 逐条核对。不达标当场修，不要交给 lite-execute 带病执行。

## plan.md 强制模板

````markdown
# {功能名} 实现计划

## 业务目标
<!-- 一句话目标 + 可衡量的成功标准 + 约束/不做 -->

## 技术改动点
<!-- 文件级清单：创建/修改的文件 + 每个文件的职责 -->

## Wave 拆分与依赖
<!-- read ../lite-shared/references/wave-model.md 后填 -->
| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   |         |      |        |      |
| W{N+1} | 验收 Wave | 所有功能 Wave | - | 跑全量测试+覆盖率 |

## 单测用例清单（AC 级）
<!-- read ../lite-shared/references/test-case-schema.md 后填。每条可机器判定 -->
| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1     |           |      |      | 正常 |
| U2     |           |      |      | 异常 |
| U3     |           |      |      | 边界 |

## E2E 用例清单
<!-- E2E 框架探测结果：[有 playwright / 无框架，降级 browser-automation|手动] -->
| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1     |      |      |      |      |         |

## 覆盖率 gate
- gate 命令：`pnpm --filter <pkg> test -- --coverage`
- 阈值：增量覆盖率 ≥ 60%

## 实现步骤
<!-- [MANDATORY] 必须用此标题（plan extension extractPlanSteps 识别） -->
<!-- 按 Wave 顺序，每个 Wave 的 TDD 步骤 -->
1. [W1] 写 U1/U2/U3 失败测试 → 实现 → 测试通过 → 提交
2. [W2] ...
3. [W{N+1}] 验收 Wave：跑全量单测 + E2E + 覆盖率，全绿才算完成
````

## Self-Check

**[MANDATORY] 以下全部满足才算 plan 完成。**

范围与目标：
- [ ] 已做范围守门自检，确认属于 lite（非 design）范围
- [ ] 业务目标有可衡量的成功标准（非"做好 X"）
- [ ] 技术改动点是文件级清单，无遗漏

Wave 拆分：
- [ ] 每个 Wave 是垂直切片（切穿相关层，非水平切片）
- [ ] blocked_by 从调用关系 + 文件影响集推导（有依据）
- [ ] 同并行组的 Wave 改动文件无交集
- [ ] 末尾有验收 Wave，blocked_by 所有功能 Wave

测试设计（重中之重）：
- [ ] 每个技术改动点至少 1 条单测
- [ ] 单测每条可机器判定（输入/预期具体值，非模糊描述）
- [ ] 每个覆盖点覆盖了正常 + 异常 + 边界
- [ ] E2E 已探测框架，执行方式写明具体命令（playwright / browser-automation / 手动）
- [ ] E2E 覆盖了每个业务用例的 happy path + 至少一个失败 path
- [ ] 覆盖率 gate 写明命令 + 60% 阈值

格式：
- [ ] 用了 `## 实现步骤` 标题（plan extension 桥接依赖）
- [ ] 无占位符（TBD/TODO/..."）

## 交付

plan.md 自检全通过后，提示用户：

```
✅ plan.md 已完成，含 6 个章节（业务目标/技术改动点/Wave拆分/单测清单/E2E清单/覆盖率gate）。
   Wave 数：{N}（并行组 {G} 个）
   单测用例：{U} 条 | E2E 用例：{E} 条
   E2E 框架：{playwright / 无框架降级}
下一步：plan(action='complete', isolation='compact')，执行方式选 "Goal-driven execution"
   桥接会自动 pi.__goalInit 创建 goal（方向+预算），todo 由 lite-execute 建。
   然后调用：/skill:lite-execute 按 Wave 执行。
```

用户确认后由 plan extension 的 complete action 触发 goal 桥接，再手动触发 lite-execute。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
