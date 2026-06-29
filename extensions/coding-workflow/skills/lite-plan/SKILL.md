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
| 1. 读项目文档 + 探索澄清 | **必读** README/CLAUDE.md/AGENTS.md 等规范（详见下方「规划前置」）；读代码理解现状，与用户澄清业务目标（可衡量成功标准 + 约束/不做） | — |
| 2. 复用检查 + 列改动点 | **先查现有 codebase** 是否有类似功能/可复用代码（判复用 or 抽象，详见「规划前置」）；再列举创建/修改文件（文件级 + 职责） | — |
| 3. Wave 拆分 | 从改动点推导 Wave 表（垂直切片 + 依赖 + 并行组 + 末尾验收 Wave） | `../lite-shared/references/wave-model.md` |
| 4. 测试设计（随改动评估） | 代码每处改动评估现有测试如何随之改；单测清单（AC级可判定）+ E2E 清单（探测项目实际测试栈）+ 覆盖率 gate | `../lite-shared/references/test-case-schema.md` |
| 5. 写 plan.md | 用完整模板填 6 章节 | `../lite-shared/references/plan-template.md` |
| 6. 自检 | 对照下方 Self-Check 逐条核对 | — |

> [铁律] 步骤 1 不做架构设计。技术约束只记录到 Constraints，不展开选型/接口定义/数据建模。

## 规划前置：读项目文档 + 复用检查（步骤 1/2 必做）

### 步骤 1 必读：项目文档先于代码

[MANDATORY] 探索代码前先读项目的规范类文档，建立「项目怎么做事」的认知基准，再读代码：

- **README** — 项目用途、技术栈、入口、命令（test/lint/dev 各在哪层目录跑）
- **CLAUDE.md / AGENTS.md / .claude/rules/** — 项目编码规范、命名约定、禁用模式、一致性惯例（如「一致性 > 品味」「禁 any」）
- **其他规范文档** — docs/standards.md、CONTRIBUTING、架构 ADR（docs/adr/）等

> 不读规范就写代码 = 大概率违反项目约定（用了禁用 API、命名不符惯例、命令在错目录跑），返工成本远高于先读 5 分钟。规范里的约束直接进 plan.md 的 Constraints 章节。

### 步骤 2 必做：复用检查先于新建

[MANDATORY] 列举「新建/修改文件」前，先查现有 codebase 是否已有可复用的功能/代码：

- **类似功能**：项目里是否已实现同类能力？（grep 关键词、看 utils/services/composables 目录）→ 有则复用或扩展，不另起
- **可复用片段**：将要写的逻辑是否已有部分实现散在各处？→ 提取为共享函数/模块
- **架构优化判断**：现有代码与将要写的代码若高度重复，是否值得顺手抽象为可复用？（判据：重复 ≥3 处，或本次 + 可预见未来 ≥2 处）

> 抽象判据要克制（YAGNI）：只有「现在就重复」或「明确即将重复」才抽象，不为推测性未来抽象。复用判断的结果进 plan.md 技术改动点（标注「复用 X」或「新建 Y，因 Z 不可复用」）。

## 输入材料可信度 + 测试 fixture 对齐（步骤 1/4 必做）

步骤 1 探索 / 步骤 4 测试设计时若依赖**输入材料**（handoff / PR 描述 / 上一阶段交接 / 测试 fixture / mock 数据），对其声明分两类处理：

- **事实型声明**（「X 已实现 / 已配置 / 规则在 Y / 文件 Z 存在」）→ **必须 grep/ls/read 实测，不能读了就信**。handoff 常用「已验证 / 已实现」类标题预设权威性，直接抑制二次验证本能——事实型声明只有实测能证伪，逻辑推导不出。
- **判断型结论**（「方案可行 / 逻辑自洽 / 这样改合理」）→ 可逻辑推导后采信，不必逐条实测。

> 实测案例：handoff DoD 写「eslint no-magic-spacing 会查 Tailwind scale」，实测 `eslint.config.mjs` 仅 20 行无此规则——只有 grep 能发现。plan 阶段没 catch，执行期才暴露。**handoff 的事实声明不应盲信**。

**步骤 4 测试设计的特化**（详见 `../lite-shared/references/test-case-schema.md`「fixture 对齐」「同源盲区反向自检」）：
- 写测试清单前，先把涉及的 fixture/mock 数据（`MOCK_COMMANDS`、种子数据、现有测试数据集）**读进上下文**——预期值对照真实 fixture 推算，不从功能描述正向猜
- 用例集合从**调用方 / 数据集反推**边界与异常，不只从功能描述正向推导（同源盲区：正向推导系统性漏掉非预期匹配项）

> 实测案例：plan 设计 U6 用 `query='co'` 预期匹配 /commit，但 mock 数据集含 /compact 也匹配——设计时 fixture 没进上下文，只想着 /commit。

plan.md 引用的事实型前提（依赖某文件/配置/接口存在）都要实测；无法实测标 `[未验证]` 暴露给用户，不默默采信。

## plan.md 六章节概览

完整模板见 `../lite-shared/references/plan-template.md`。六章节：

1. **业务目标** — 一句话目标 + 可衡量成功标准 + 约束/不做
2. **技术改动点** — 文件级清单（创建/修改 + 职责），Wave 拆分依据
3. **Wave 拆分与依赖** — 垂直切片 + blocked_by + 并行组 + 末尾验收 Wave
4. **单测用例清单** — 每条可机器判定，每个改动点正常/异常/边界各 ≥1
5. **E2E 用例清单** — 探测项目实际测试栈，按栈写执行命令；无框架的前端用例用 browser 类 skill / CDP 类 MCP 驱动（Agent 主动发现，不写死名称），或手动
6. **覆盖率 gate** — 按语言×框架表选命令 + 增量算法（见 `test-case-schema.md`「语言×框架增量覆盖率」）+ 阈值（≥60%，项目已有更高阈值则就高）

> **[MANDATORY] plan.md 必须含 `## 实现步骤` 章节。** 这是 plan extension `extractPlanSteps` 唯一识别的标题——plan(complete) 时它从这里提取步骤。用别的标题 plan→goal 桥接断裂。

### E2E / 前端测试栈探测（步骤 4 必做）

写 E2E 清单前 [MANDATORY] 探测项目**实际**测试栈（不预设 Playwright）。完整探测与降级规则见 `../lite-shared/references/test-case-schema.md`「E2E / 前端测试栈探测」。要点：探测到什么框架就写什么命令；无 E2E 框架的前端用例用 browser 类 skill / CDP 类 MCP 驱动（Agent 主动发现，不写死名称）；都不适用写手动。

## Self-Check

**[MANDATORY] 全部满足才算 plan 完成。**

范围与目标：
- [ ] 已做范围守门自检，确认属于 lite（非 design）范围
- [ ] 业务目标有可衡量成功标准（非"做好 X"）
- [ ] 技术改动点是文件级清单，无遗漏
- [ ] 已读项目规范文档（README/CLAUDE.md/AGENTS.md 等），约束已进 Constraints
- [ ] 每个技术改动点已查复用（标注复用来源 or 不可复用原因）

Wave 拆分：
- [ ] 每个 Wave 是垂直切片（非水平切片）
- [ ] blocked_by 从调用关系 + 文件影响集推导（有依据）
- [ ] 同并行组 Wave 改动文件无交集
- [ ] 末尾有验收 Wave，blocked_by 所有功能 Wave

测试设计（重中之重）：
- [ ] 每个技术改动点至少 1 条单测
- [ ] 单测每条可机器判定（输入/预期具体值）
- [ ] 每个覆盖点覆盖正常 + 异常 + 边界
- [ ] E2E 已探测项目实际测试栈，执行方式写明具体命令
- [ ] E2E 覆盖每业务用例 happy path + ≥1 失败 path
- [ ] 每处代码改动已评估现有测试如何随之改（不只新增，还有适配修改）
- [ ] 覆盖率 gate 写明命令（按语言×框架表）+ 增量算法 + 阈值

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
