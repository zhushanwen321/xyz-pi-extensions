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

为**不涉及架构改动的小功能**产出一份 plan.md，含 6 个章节：业务目标、技术改动点（文件级）、Wave 依赖拆分、**完整的测试验收设计**（单测清单 + E2E 清单 + 覆盖率 gate）。

> **[铁律] 本 skill 只做计划，不写实现代码。** 测试用例只设计（输入/预期/类型），不写测试代码——那是 lite-execute 的 implementer 按 TDD 写的。
>
> **[铁律] 测试设计是重中之重。** plan.md 测试章节不达标 = plan 未完成。验收全绿的前提是 plan 里有可执行、可判定的测试清单。

## 范围守门

[MANDATORY] 写 plan 前先自检——本功能是否真属于 lite。以下任一出现 → **停止，建议改用 design 工作流**（design-init → design-clarity → ...）：

- 跨 2 个及以上子系统/模块协调
- 状态机变更、核心数据模型变更、公共 API 契约变更
- 需要架构决策（技术选型、模块边界重划分、依赖方向调整）
- 改动影响 3 个以上既有文件的核心逻辑（非测试文件）
- 需要非功能设计（安全/并发/性能/稳定性 NFR 风险分析）

> 详见 `../lite-shared/SKILL.md`「何时升级到 design」。范围错了后面全白做。

## 前置

- 已在 plan mode（`/plan <需求>`）
- 已 `plan(action='select-template', templateName='feature-plan')`

## 路由

按当前步骤 read 对应参考，逐步推进：

| 步骤 | 做什么 | read 参考 |
|------|--------|----------|
| 1. 探索+澄清 | 读代码理解现状，与用户澄清业务目标（可衡量成功标准 + 约束/不做） | — |
| 2. 列技术改动点 | 穷举创建/修改文件（文件级 + 职责） | — |
| 3. Wave 拆分 | 从改动点推导 Wave 表（垂直切片 + 依赖 + 并行组 + 末尾验收 Wave） | `../lite-shared/references/wave-model.md` |
| 4. 测试设计 | 单测清单（AC级可判定）+ E2E 清单（先探测框架）+ 覆盖率 gate | `../lite-shared/references/test-case-schema.md` |
| 5. 写 plan.md | 用完整模板填 6 章节 | `../lite-shared/references/plan-template.md` |
| 6. 自检 | 对照下方 Self-Check 逐条核对 | — |

> [铁律] 步骤 1 不做架构设计。技术约束只记录到 Constraints，不展开选型/接口定义/数据建模。

## plan.md 六章节概览

完整模板见 `../lite-shared/references/plan-template.md`。六章节：

1. **业务目标** — 一句话目标 + 可衡量成功标准 + 约束/不做
2. **技术改动点** — 文件级清单（创建/修改 + 职责），Wave 拆分依据
3. **Wave 拆分与依赖** — 垂直切片 + blocked_by + 并行组 + 末尾验收 Wave
4. **单测用例清单** — 每条可机器判定，每个改动点正常/异常/边界各 ≥1
5. **E2E 用例清单** — 探测框架（playwright.config.*），无框架则降级 + 提示
6. **覆盖率 gate** — 命令 + 60% 阈值

> **[MANDATORY] plan.md 必须含 `## 实现步骤` 章节。** 这是 plan extension `extractPlanSteps` 唯一识别的标题——plan(complete) 时它从这里提取步骤。用别的标题 plan→goal 桥接断裂。

### E2E 框架探测（步骤 4 必做）

写 E2E 清单前 [MANDATORY] 探测：

- 有 `playwright.config.{ts,js}` / `cypress.config.{ts,js}` → 执行方式写 `npx playwright test e2e/<id>.spec.ts`
- 无 → plan.md 标注「项目无 E2E 框架」，执行方式降级为 browser-automation / 手动，提示用户建议装 Playwright

## Self-Check

**[MANDATORY] 全部满足才算 plan 完成。**

范围与目标：
- [ ] 已做范围守门自检，确认属于 lite（非 design）范围
- [ ] 业务目标有可衡量成功标准（非"做好 X"）
- [ ] 技术改动点是文件级清单，无遗漏

Wave 拆分：
- [ ] 每个 Wave 是垂直切片（非水平切片）
- [ ] blocked_by 从调用关系 + 文件影响集推导（有依据）
- [ ] 同并行组 Wave 改动文件无交集
- [ ] 末尾有验收 Wave，blocked_by 所有功能 Wave

测试设计（重中之重）：
- [ ] 每个技术改动点至少 1 条单测
- [ ] 单测每条可机器判定（输入/预期具体值）
- [ ] 每个覆盖点覆盖正常 + 异常 + 边界
- [ ] E2E 已探测框架，执行方式写明具体命令
- [ ] E2E 覆盖每业务用例 happy path + ≥1 失败 path
- [ ] 覆盖率 gate 写明命令 + 60% 阈值

格式：
- [ ] 含 `## 实现步骤` 标题（plan extension 桥接依赖）
- [ ] 无占位符（TBD/TODO/...）

## 交付

plan.md 自检全通过后，提示用户：

```
✅ plan.md 已完成（6 章节）。Wave {N} 个 | 单测 {U} 条 | E2E {E} 条
下一步：plan(action='complete', isolation='compact')，执行方式选 "Goal-driven execution"
   桥接自动 pi.__goalInit 创建 goal。然后 /skill:lite-execute 按 Wave 执行。
```

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
