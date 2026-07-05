---
name: lite-plan
description: >-
  Use when the user says "轻量计划", "lite plan", "小功能计划", "写测试计划",
  "Wave 拆分", "plan this feature", or is in plan mode brainstorming a small
  feature (no architecture change). Produces plan.md + plan.json (CW plan action 入参).
  对应 CW action: plan. Not for architecture-level changes (use full-* workflow).
  Not for execution (that is coding-execute).
---

# 轻量计划（Lite Plan）

> **对应 CW action: `plan`**（coding-workflow tool）。本 skill 产出 plan.json，完成后调
> `cw(action=plan, topicId, planJson)` 通过 CW plan gate。CW 解析 plan.json 的 waves/testCases
> 写入 _cw.db，gate pass 后返回 nextAction（→ dev）。按 nextAction 推进，不自行决定下一步。

为**不涉及架构改动的小功能**产出一份 plan.md，含 7 个章节：业务目标、技术改动点（文件级）、Wave 依赖拆分、**完整的测试验收设计**（单测清单 + E2E 清单 + 覆盖率 gate）、实现步骤（MANDATORY，plan extension 桥接依赖）。

> **含 4 个条件触发的 ensemble 点**（0b 范围守门投票 / 2b 复用检查并集 / 4b 测试完整性并集 / 5b 机器检查+禁读重建）：同源盲区高风险时派 fresh subagent 并行、综合去偏；5b 用机器脚本吃掉结构检查、禁读重建抓盲区。触发条件见路由表与各步骤正文，明确小功能不启用。趋同数据（`*_ensemble_overlap` / `reconstruct_blind_spot`）记 frontmatter，供 coding-retrospect 消费做降级决策。

> **[铁律] 本 skill 只做计划，不写实现代码。** 测试用例只设计（输入/预期/类型），不写测试代码——那是 coding-execute 的 implementer 按 TDD 写的。
>
> **[铁律] 测试设计是重中之重。** plan.md 测试章节不达标 = plan 未完成。验收全绿的前提是 plan 里有可执行、可判定的测试清单。

## 范围守门

[MANDATORY] 写 plan 前先自检——本功能是否真属于 lite。以下任一出现 → **停止，建议改用 full 工作流**（coding-init → full-clarity → ...）：

- 跨 2 个及以上子系统/模块协调
- 状态机变更、核心数据模型变更、公共 API 契约变更
- 需要架构决策（技术选型、模块边界重划分、依赖方向调整）
- 改动影响 3 个以上既有文件的核心逻辑（非测试文件）
- 需要非功能设计（安全/并发/性能/稳定性 NFR 风险分析）

> 详见 `../lite-shared/SKILL.md`「何时升级到 full」。范围错了后面全白做。

### 范围守门 ensemble（投票，边界判定时触发）

> 触发条件：主 agent 自检 5 条判据后，有 1-2 条**处于边界**（不确定算不算命中——如「跨 2 个子系统」的「跨」怎么算、「核心逻辑」怎么界定）。明确属于 lite（0 条命中）或明确属于 full（多条命中）→ 直接判定，不启用。
>
> **[铁律] 触发条件是硬性的，不允许主 agent 基于项目规模/「这次很简单」自行降级跳过 ensemble。** 降级决策由 coding-retrospect 跨功能复盘基于趋同数据（`*_ensemble_overlap` frontmatter）决定——只有 retrospect 判定「上次同类功能 ensemble 趋同 high」时，未来同类功能才可降级单路判定。主 agent 在当前功能内无降级权限。

范围判定是**元决策**——判错整个工作流方向错。低判（本该 full 却走 lite）= 后期发现架构改动全盘返工；高判（本该 lite 却推 full）= 过度流程浪费。两种代价都大且判定有主观性，ensemble 把单点主观判断转多路投票压抖动。

派 2 路 fresh subagent 独立判范围（ensemble 模式同步骤 4b：wait:false 同消息并行 + 差异化，综合=投票）：

| 路 | 判定倾向 | 找什么 |
|----|---------|--------|
| **偏严路** | 倾向升级 full | 哪些判据其实命中了？（宁可走重流程兜底） |
| **偏宽路** | 倾向留 lite | 哪些判据其实不算命中？（防止过度流程） |

投票（主 agent 自检 + 2 路 = 3 票）：
- 3 票一致 → 高置信，按判定走
- 2:1 偏升级 full → **升级**（代价不对称：漏判架构返工 >> 过度流程成本，取偏严策略）
- 2:1 偏留 lite → 留 lite，但**边界判据显式 ask_user 确认**（让用户拍板「这个算不算跨子系统/核心逻辑」），不 agent 自决

> 趋同检测（记 plan.md frontmatter，供 coding-retrospect「ensemble 趋同数据复盘」消费）：3 票一致 → 记 `scope_ensemble_overlap: high`（未来同类功能可降级单路判定）；2:1 分歧 → 记 `scope_ensemble_overlap: low`，边界判据已交用户。

## 前置

- **已调 `cw(action=create, slug, tier="lite", objective)` 拿到 topicId**（第一步，锁 tier；后续 plan.md/plan.json 路径都挂在 `.xyz-harness/{slug}/` 下，依赖此 topicId）
- 已在 plan mode（`/plan <需求>`）
- 已 `plan(action='select-template', templateName='feature-plan')`

## 路由

按当前步骤 read 对应参考，逐步推进：

> **[铁律] 本 skill 终点是 `cw(action=plan)` 过 gate，不是写完 plan.md。** plan.md 是人类 review 载体 + CW gate 的检查对象，plan.json + CW plan gate 通过才是真正交付。写完 plan.md 不调 cw(plan) = 没交付。

| 步骤 | 做什么 | read 参考 |
|------|--------|----------|
| 0. 范围守门 | 自检是否真属于 lite（5 条判据），任一命中→升级 full | — |
| 0b. 范围守门 ensemble（条件触发） | 5 条判据中 1-2 条处于边界时：派 fresh subagent 投票判范围（详见正文） | — |
| 1. 读项目文档 + 探索澄清 | **必读** README/CLAUDE.md/AGENTS.md 等规范（详见下方「规划前置」）；读代码理解现状，与用户澄清业务目标（可衡量成功标准 + 约束/不做） | — |

> **[可选加速] 并行模式**：步骤 1 搜集后，若识别到 ≥2 个需澄清问题且 ≥1 个是细节性（详见下方「并行加速模式」），主 agent 同消息分叉：ask_user 提问 ‖ 派 2 路 bg subagent（技术方案 + 测试设计）并行写草案。把「等用户响应」的时间用于并行生成 plan 草案。
| 2. 复用检查 + 列改动点 | **先查现有 codebase** 是否有类似功能/可复用代码（判复用 or 抽象，详见「规划前置」）；再列举创建/修改文件（文件级 + 职责） | — |
| 2b. 复用检查 ensemble（条件触发） | 改动点 ≥3 时：派 fresh subagent 多路搜索策略并集找复用候选（详见正文） | — |
| 3. Wave 拆分 | 从改动点推导 Wave 表（垂直切片 + 依赖 + 并行组；只列功能 Wave，不设验收 Wave——整体回归归 CW test 阶段） | `../lite-shared/references/wave-model.md` |
| 4. 测试设计（随改动评估） | 代码每处改动评估现有测试如何随之改；单测清单（AC级可判定）+ E2E 清单（探测项目实际测试栈，**每条标测试层 mock/real，两层各≥1**）+ 覆盖率 gate | `../lite-shared/references/test-case-schema.md` |
| 4b. 多路反向自检（条件触发） | 改动点 ≥3 / 涉及过滤·查询·匹配·状态机时：派 fresh subagent ensemble 找漏用例（详见正文） | — |
| 5. 写 plan.md | 写到 `.xyz-harness/{slug}/plan.md`（**CW gate 期望位置**，{slug} = cw(create) 的 slug；写到别处 gate 直接 FAIL）。用完整模板填 7 章节（若并行加速模式启用：合并技术方案路 + 测试设计路两份草案） | `../lite-shared/references/plan-template.md` |
| 5b. 草案审查 ensemble（条件触发） | plan.md 写成后：先让 CW gate 机器检查杀结构硬伤（调 `cw(action=plan)` 时自动跑，零 subagent），再派 1 路禁读重建 subagent 做测试盲区三态 diff（详见正文） | — |
| 6. 自检 | 对照下方 Self-Check 逐条核对（含 5b 审查反馈处理） | — |

> [铁律] 步骤 1 不做架构设计。技术约束只记录到「业务目标」章节的约束字段，不展开选型/接口定义/数据建模。

## 并行加速模式（可选，提升 plan 速度）

> 可选优化，非强制。目的是**把「等用户响应」的时间用来并行生成 plan 草案**，不改澄清质量（澄清质量仍靠范围守门 + 输入材料可信度 + fixture 对齐保证）。

### 触发门槛（满足才启用，不满足走串行）

步骤 1 搜集后，主 agent 把识别到的需澄清问题二分类：

- **阻塞性歧义**：影响「做什么」/改动点方向/Wave 结构——bg subagent 等不了，必须先问
- **细节性歧义**：只影响用例输入值/边界值/字段名——bg 可用占位符先做，汇合时填

**同时满足以下两个条件才触发并行**：
1. ≥2 个需澄清问题
2. ≥1 个是细节性（可并行，bg 用占位符先做）

不满足（0-1 个问题，或全是阻塞性）→ 走串行（当前流程）。编排开销有保证回本。

### 并行流程（触发后）

```
步骤 1 搜集完，识别问题集并二分类 → 满足门槛 → 主 agent 同消息分叉：
  ├─ 主 agent：ask_user(action='add') 批量提问（1-4 个，含阻塞性 + 细节性）
  ├─ bg subagent 路1（技术方案）：planner agent, wait:false, 负责章节 1-3
  └─ bg subagent 路2（测试设计）：general-purpose agent, wait:false, 负责章节 4-6

  ↓ ask_user 等用户响应 ‖ 2 路 bg 并行写草案，两者并行

汇合（ask_user 返回 + 2 路 bg 草案 / notifier 唤醒）→
  主 agent 核对+合并草案：
    1. 阻塞性问题的假设：bg 用「假设X」标注的，拿用户答案逐条核对，推翻则重做该部分
    2. 细节性问题的占位符：拿用户答案填
    3. 合并两路草案：技术方案路输出章节 1-3 + 测试设计路输出章节 4-6 → 拼接为完整 plan.md
    4. 交叉校验：技术方案路的改动点清单是否与测试设计路的用例覆盖清单一致？（不一致→补全）
    5. 测试清单 fixture：review 测试设计路的用例预期是否对照真实 fixture（不盲采，见「输入材料可信度」）
  → 进步骤 5b 草案审查（机器检查 + 禁读重建，条件触发）→ 自检 → 定稿写入 planFilePath → plan(action='complete')
```

### bg subagent 派发模板（2 路，同消息并行派发）

**路 1 — 技术方案（章节 1-3）：**

```
subagent(action:'start', startParam:{
  agent: "planner",
  wait: false,
  task: """
  为以下需求写 plan 草案的**前 3 章节**（业务目标、技术改动点、Wave 拆分），写到临时文件：
  .xyz-harness/plan-draft-tech-{slug}.md（不要碰 planFilePath，不要调 plan(complete)）。

  需求：{一句话}
  约束/规范（主 agent 已搜集）：{规范摘要 + 文件清单}

  需澄清问题及处理：
  - 阻塞性（你不能先定）：{问题1}、{问题2} → 用「假设：X」标注，待主 agent 汇合核对
  - 细节性（你用占位符先做）：{问题3} → 用 {PLACEHOLDER} 占位，待填

  要求：
  - read 下列关键文件理解现状：{文件清单}
  - 读 ../lite-shared/references/wave-model.md 并按垂直切片拆 Wave
  - 每个技术改动点标注复用来源或不可复用原因
  - 输出章节 1-3 及「实现步骤」章节（含每 Wave 的 TDD 步骤）
  - 不写章节 4-6（测试设计），那是另一路 subagent 的活
  - 不实现代码、不 commit
  """
})
```

**路 2 — 测试设计（章节 4-6）：**

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  task: """
  为以下需求写 plan 草案的**后 3 章节**（单测用例清单、E2E 用例清单、覆盖率 gate），写到临时文件：
  .xyz-harness/plan-draft-test-{slug}.md（不要碰 planFilePath，不要调 plan(complete)）。

  需求：{一句话}
  技术改动点（由主 agent 或技术方案路提供）：{改动点清单}
  约束/规范（主 agent 已搜集）：{规范摘要}

  需澄清问题及处理：
  - 细节性（你用占位符先做）：{问题3} → 用 {PLACEHOLDER} 占位，待填

  要求：
  - read 下列关键文件理解现状：{技术文件 + fixture/mock 数据文件清单}
  - 读 ../lite-shared/references/test-case-schema.md 并按 schema 写测试清单
  - **fixture 对齐**：先 read 涉及的 fixture/mock 数据进上下文，预期值对照真实 fixture 推算
  - 每个改动点正常/异常/边界各 ≥1 条单测
  - 探测项目实际测试栈（不预设框架），按探测结果写 E2E 执行方式
  - 覆盖率 gate 按语言×框架表选命令
  - 不写章节 1-3（技术方案），那是另一路 subagent 的活
  - 不实现代码、不 commit
  """
})
```

> 两路 bg 草案产出由 notifier 自动唤醒主 agent（`deliverAs: followUp`），不需轮询。若某路 bg 静默 hang（既不完成也不失败），当前无平台级兜底——见 `subagent-dispatch.md`「已知限制」。汇合超时感明显时，主 agent 在下一个可用 turn 调 `subagent(action:list)` 排查。

### 边界与风险

- **2 路拆分降低单路负担**：原来 1 个 bg subagent 写全部 7 章节，注意力和 token 预算倾斜技术方案，测试章节常被压缩。拆成 2 路后各聚焦（技术方案路 3 章节 + 测试设计路 3 章节，实现步骤由主 agent 汇合时补），测试设计质量预期显著提升。
- **交叉校验防漂移**：技术方案路的改动点清单必须与测试设计路的用例覆盖清单一致。汇合时主 agent 做交叉校验——技术方案列了但测试没覆盖的改动点 → 补用例；测试覆盖了但技术方案没列的 → 核实后补改动点或删用例。
- **bg 上下文不足风险**：plan 设计依赖 codebase 理解。解法——bg task 里让它**自己 read 关键文件**（主 agent 给清单），不靠摘要硬做。代价是 bg 耗时≈主 agent 自做耗时，但两路并行跑，不亏。
- **草案烂（阻塞性问题假设错）→ 重做**：汇合时若用户答案推翻了 bg 的阻塞性假设，两路草案的相关部分都必须重做（阻塞性假设通常影响技术方案路，连带影响测试设计路的覆盖范围），不勉强用烂草案。
- **plan mode 状态机**：bg 是独立 session，**只写临时文件，不调 plan(complete)**。主 agent 汇合定稿后才 complete。状态边界干净。
- **不替代澄清质量**：此模式只加速，bg subagent 不找 gap。系统化 gap-finding 走 full-clarity（full 工作流 Step 1）。别因引入并行就觉得澄清更严谨。

## 规划前置：读项目文档 + 复用检查（步骤 1/2 必做）

### 步骤 1 必读：项目文档先于代码

[MANDATORY] 探索代码前先读项目的规范类文档，建立「项目怎么做事」的认知基准，再读代码：

- **README** — 项目用途、技术栈、入口、命令（test/lint/dev 各在哪层目录跑）
- **CLAUDE.md / AGENTS.md / .claude/rules/** — 项目编码规范、命名约定、禁用模式、一致性惯例（如「一致性 > 品味」「禁 any」）
- **其他规范文档** — docs/standards.md、CONTRIBUTING、架构 ADR（docs/adr/）等

> 不读规范就写代码 = 大概率违反项目约定（用了禁用 API、命名不符惯例、命令在错目录跑），返工成本远高于先读 5 分钟。规范里的约束直接进 plan.md「业务目标」章节的约束字段。

### 步骤 2 必做：复用检查先于新建

[MANDATORY] 列举「新建/修改文件」前，先查现有 codebase 是否已有可复用的功能/代码：

- **类似功能**：项目里是否已实现同类能力？（grep 关键词、看 utils/services/composables 目录）→ 有则复用或扩展，不另起
- **可复用片段**：将要写的逻辑是否已有部分实现散在各处？→ 提取为共享函数/模块
- **架构优化判断**：现有代码与将要写的代码若高度重复，是否值得顺手抽象为可复用？（判据：重复 ≥3 处，或本次 + 可预见未来 ≥2 处）

> 抽象判据要克制（YAGNI）：只有「现在就重复」或「明确即将重复」才抽象，不为推测性未来抽象。复用判断的结果进 plan.md 技术改动点（标注「复用 X」或「新建 Y，因 Z 不可复用」）。

### 复用检查 ensemble（并集，改动面大时触发）

> 触发条件：技术改动点 ≥3 个（复用机会随改动面增大，单次搜索盲区变大）。1-2 个改动点的小功能 → 单路复用检查，不启用。

复用检查的质量高度依赖**搜索的全面性**——主 agent grep 了什么关键词、看了哪些目录，决定了能否找到可复用代码。单次搜索有盲区（用关键词 A 搜，漏了用 B 命名的同类功能），漏复用 = 重复造轮子（违反「一致性 > 品味」）。ensemble 用多路不同搜索策略并集补全盲区。

派 2 路 fresh subagent 用**不同搜索策略**再查一遍（ensemble 模式同步骤 4b：wait:false 同消息并行 + 差异化，综合=并集）：

| 路 | 搜索策略 | 找什么 |
|----|---------|--------|
| **语义路** | 按功能语义搜（关键词的同义词、相关概念） | 主 agent 用的关键词的同义词命中的功能 |
| **结构路** | 按代码结构搜（utils/services/composables 目录、export 的函数签名模式） | 结构上相似但命名不同的可复用片段 |

**汇合：** N 路「可复用候选」并集去重，主 agent 判定**真复用 vs 仅相似**（结构相似但语义不同的代码不算复用）。真复用进 plan.md 技术改动点（标注复用来源）。

> 趋同检测（记 plan.md frontmatter，供 coding-retrospect 消费）：2 路候选重合度 > 80% → 记 `reuse_ensemble_overlap: high`（说明主 agent 单路搜索已充分，未来同类可降级）；重合度低 → 记 `low`。

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

## plan.md 七章节概览

完整模板见 `../lite-shared/references/plan-template.md`。七章节：

1. **业务目标** — 一句话目标 + 可衡量成功标准 + 约束/不做
2. **技术改动点** — 文件级清单（创建/修改 + 职责），Wave 拆分依据
3. **Wave 拆分与依赖** — 垂直切片 + blocked_by + 并行组（只列功能 Wave，不设验收 Wave）
4. **单测用例清单** — 每条可机器判定，每个改动点正常/异常/边界各 ≥1
5. **E2E 用例清单** — 探测项目实际测试栈，按栈写执行命令；**每条标测试层 mock/real**（见 `test-case-schema.md` 核心原则四），mock 层 + real 层各至少 1 条；无框架的前端用例用 browser 类 skill / CDP 类 MCP 驱动（Agent 主动发现，不写死名称），或手动
6. **覆盖率 gate** — 按语言×框架表选命令 + 增量算法（见 `test-case-schema.md`「语言×框架增量覆盖率」）+ 阈值（≥60%，项目已有更高阈值则就高）

> **[MANDATORY] plan.md 必须含 `## 实现步骤` 章节。** 这是 plan extension `extractPlanSteps` 唯一识别的标题——plan(complete) 时它从这里提取步骤。用别的标题 plan→goal 桥接断裂。

### E2E / 前端测试栈探测（步骤 4 必做）

写 E2E 清单前 [MANDATORY] 探测项目**实际**测试栈（不预设 Playwright）。完整探测与降级规则见 `../lite-shared/references/test-case-schema.md`「E2E / 前端测试栈探测」。要点：探测到什么框架就写什么命令；无 E2E 框架的前端用例用 browser 类 skill / CDP 类 MCP 驱动（Agent 主动发现，不写死名称）；都不适用写手动。

> **[MANDATORY] 探测含「读项目测试手册」**：除扫框架配置外，必须扫 `TEST-STRATEGY.md` / `docs/testing/` / `CLAUDE.md`/`AGENTS.md` 测试规范是否有项目已沉淀的测试手册。有则 read 对应功能章节，复用已有 data-testid 清单/调用链/fixture 位置/已知坑（这些仅靠读组件源码无法发现），E2E 用例直接复用其断言模式并标注来源。详见 test-case-schema 第 2 步。

## 步骤 4b：多路反向自检（ensemble，条件触发）

> [铁律] 测试设计是 lite-plan 的重中之重，最大的敌人是**同源盲区**——主 agent 既是功能理解者又是用例设计者，两角色同源，盲区也同源（详见 `test-case-schema.md`「同源盲区反向自检」）。full 用 fresh subagent 禁读重建对抗；lite 降维为「反向自检」。
>
> **反向自检的局限：它还是同一个 agent 在做。** 同一个脑子先正向设计用例、再要求自己反向自检，认知惯性依然存在——这正是 ensemble 的用武之地。

### 触发门槛（满足才启用）

满足以下**任一**条件触发；明确的小功能（1-2 个改动点、纯 CRUD 增删改）走单路反向自检（`test-case-schema.md`「同源盲区反向自检」），不启用 ensemble：

- 改动点 ≥3 个（盲区随改动面增大）
- 涉及过滤/查询/匹配逻辑（`query='co'` 预期匹配 /commit 却漏了 /compact 这类——同源盲区高发区）
- 涉及状态机或跨多状态转换（非法转换路径易漏）

### 流程

主 agent 写完**单测清单草案**后（E2E 清单同步，但本步聚焦单测——E2E 受执行栈约束，ensemble 边际收益低），派 2-3 个 fresh subagent 各自独立做反向自检。**差异化是关键**——同 prompt 重复 N 次，盲区高度相关，ensemble 无增益。每路从**不同切入点**反推漏掉的用例：

| 路 | 切入点 | 找什么 |
|----|--------|--------|
| **数据集反推路** | read 完整 fixture/mock 数据集进上下文 | 数据集里还有哪些值会命中过滤/触发边界？（对照真实数据，非正向猜） |
| **调用方反推路** | read 所有调用方代码进上下文 | 调用方实际会传什么异常输入？空值/超长/并发？ |
| **异常路径路** | 列举每个错误处理点 + 状态转换点 | 每个错误分支有用例吗？每个非法状态转换覆盖了吗？ |

**派发模板（wait:false，同消息并行）：**

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  context: "<test-case-schema.md 的「同源盲区反向自检」节 + 单测清单草案 + {本路切入点材料}>",
  task: """
  你是独立审查 subagent，上下文与主 agent 隔离。主 agent 已写完单测清单草案，你只做一件事：
  **找漏掉的用例**（不重写已有用例，不评价已有用例质量）。

  read 单测清单草案 + {本路切入点材料}，按 test-case-schema.md 的反向自检规则，从{本路切入点}反推：
  - {数据集反推路：遍历完整数据集，找出草案没覆盖但会命中过滤/触发边界的值}
  - {调用方反推路：grep 所有调用方，找出会传入但草案没测的异常输入}
  - {异常路径路：列举每个错误处理分支和状态转换，找出草案没覆盖的}

  输出「漏掉的用例建议」清单，每条：
  - 用例 ID（建议如 U7）
  - 覆盖改动点（文件:函数）
  - 输入（具体值）
  - 预期（具体断言）
  - 类型（正常/异常/边界）
  - **为什么主 agent 漏了它**（同源盲区诊断——一句话说明正向设计为何看不到这条）

  不要重复已有用例。不要重写清单。只输出建议。
  """
}) → 返回 {subagentId}
```

**汇合（notifier 唤醒，不需轮询）：**

主 agent 收齐 N 路建议后：
1. **去重对照**：N 路建议 union，按「覆盖改动点 + 输入场景」去重。同时对照草案——剔除 subagent 误报的「已在草案里」的条目
2. **合并入草案**：去重后的建议合并进单测清单，连续编号
3. **趋同检测**（决定未来是否持续 ensemble，记 plan.md frontmatter 供 coding-retrospect 消费）：
   - N 路建议重合度 > 80%（都指出同样几个漏的用例）→ 高置信遗漏，直接补；同时记 `test_ensemble_overlap: high`（未来同类功能可降级回单路反向自检）
   - 重合度低（各找各的）→ 同源盲区确实大，ensemble 价值高，全部补进；记 `test_ensemble_overlap: low`

### 边界与风险

- **不替代正向设计**：本步是验证，不是生成。主 agent 必须先正向设计完整草案，再派 ensemble 找漏——草案空/残缺时 ensemble 无从对照
- **bg 草案假设错 → 重做该部分**：若并行加速模式下 bg 草案的阻塞性假设被用户答案推翻（SKILL.md「并行加速模式」），重做后**重跑 4b**（在新草案上找漏），不沿用旧草案的 ensemble 结果
- **E2E 不 ensemble**：E2E 受执行栈强约束（happy-dom 无真实视口等），ensemble 边际收益低、误报多。E2E 走单路反向自检 + 「E2E 用例可执行性自检」（`test-case-schema.md`）
- **小功能不触发**：明确属于 lite 的小功能（1-2 改动点）走单路反向自检即可，ensemble 是编排开销 ≥ 收益的反模式

## 步骤 5b：草案审查（机器检查 + 禁读重建，条件触发）

> 触发条件：plan.md 写成后（含并行加速模式合并完成），满足以下**任一**条件触发；1-2 个改动点的小功能走单路自检（步骤 6），不启用本步：
> - 技术改动点 ≥3 个
> - Wave 数 ≥2 个

> **两层审查：机器吃结构，禁读重建抓盲区。** 本步用 CW gate 的机器检查杀 7 项里的 5 项结构硬伤（调 `cw(action=plan)` 时自动跑，零 subagent），再派 1 路禁读重建 subagent 做机器做不了的语义/盲区审查。从原来的 2 路读后审查降为「机器 + 1 路禁读重建」——更强（禁读比读后审查能发现更多盲区）且更省。
>
> **与 4b 的编排关系**：4b 在单测清单草案**写入前**找漏（草案完成后立即派 ensemble 反向自检），5b 在 plan.md**写入后**做禁读重建。两者都跑，不互替——4b 找漏后草案已更新，5b 在**更新后的草案**上重建（不沿用 4b 的结果，因为 4b 是读后审查、5b 是禁读重建，方法论不同）。4b 侧重多路视角并集，5b 侧重禁读三态 diff。

### 第一层：机器结构检查（CW gate 自动跑，零 subagent）

plan.md 写成后，主 agent 产出 plan.json 并调 `cw(action=plan)` 时，CW gate 自动跑机器检查（agent 不再手动自跑脚本）。覆盖项（7 项中的 5 项机器可判）：
- ① 结构：6 必须章节齐全 / `## 实现步骤` 标题存在 / 无占位符
- ② 方案：Wave 表可解析 / **同并行组文件无交集**（精确机器判）
- ③ 测试：单测输入/预期非空且无模糊词（正常工作/应该返回...） / 每个改动点有对应单测 / 覆盖率 gate 命令存在且阈值 ≥60%

**FAIL → 当场修**（主 agent 直接改 plan.md 结构硬伤），重新调 `cw(action=plan)` 直到 PASS。机器检查的定位：杀低级硬伤，不占 subagent 预算。

### 第二层：禁读重建（1 路 fresh subagent，做机器做不了的）

plan.md 草案完成后，派 1 路禁读重建 subagent。**禁读**是核心——不读 plan.md 的测试章节，而是从技术改动点 + fixture 数据**独立重建**该有哪些测试用例，再 diff plan.md 的测试清单。读了就被锚定，退回读后审查。

> 注：机器结构检查现由 CW gate 在 `cw(action=plan)` 调用时自动执行（见下文「交付」），与本步的禁读重建解耦——本步只做 agent 侧的盲区重建，结构硬伤交给 CW gate 兜底。

> 范式照搬 full-issues 角色 A（覆盖重建者）：禁读产出物 → 独立按规则重建 → diff → 三态 MISSING/PHANTOM/MISMATCH。这比「读后挑错」强一个量级——读后审查发现「写错的」，禁读重建发现「该有没写的」（同源盲区）。

**派发模板（wait:false）：**

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  task: """
  你是独立禁读重建 subagent，上下文与主 agent 隔离。
  **重建阶段禁止读 plan.md 的测试章节**（单测/E2E/覆盖率）。读了就被锚定，退回读后审查。

  你的任务：从技术改动点 + fixture 数据独立重建「该有哪些测试用例」，再 diff plan.md 现有清单。

  步骤：
  1. read plan.md 的「技术改动点」章节（只读这章，建立改动点清单）
  2. read 涉及的 fixture/mock 数据文件（主 agent 在 task 里给清单）：{fixture 文件清单}
  3. 对每个改动点，按 test-case-schema.md 的反向自检规则，独立推导：
     - 正常用例（主流程该测什么）
     - 异常用例（调用方会传什么异常输入？空值/超长/并发？）
     - 边界用例（数据集里哪些值会触发边界？）
     建成重建用例集 T_recon（不参考 plan 现有用例）
  4. **重建完成后**才 read plan.md 的测试章节。逐条 diff T_recon vs plan 现有用例，产出三态 gap：
     - **MISSING（漏项）**：T_recon 有、plan 无对应用例（该测没测）
     - **PHANTOM（脱锡）**：plan 有用例、但对应改动点查不到或无意义（假冒/越界）
     - **MISMATCH（虚覆盖）**：标了覆盖但断言不对（如只测正常路径，异常分支空缺）
  5. 输出三态 gap 清单，每条：改动点 / 输入 / 预期 / 类型 / **为什么主 agent 漏了它**（同源盲区诊断）

  不重写已有用例。不评价已有用例质量（那是机器检查的活）。只输出 gap。
  不修改文件。
  """
})
```

### 汇合（notifier 唤醒，不需轮询）

主 agent 收到禁读重建 gap 清单后：
1. **去重对照**：gap 清单 vs plan 现有用例，剔除 subagent 误报的「已有」条目
2. **三态分级处理**：
   - `MISSING` → 必须补（该测没测 = 验收会漏）
   - `PHANTOM` → 核实后删（假冒用例误导执行）
   - `MISMATCH` → 改断言（虚覆盖比没有更危险）
3. **处理完后进步骤 6 自检**

> 趋同检测（记 plan.md frontmatter，供 coding-retrospect 消费）：MISSING gap 数量 >5 → 记 `reconstruct_blind_spot: high`（主 agent 同源盲区大，禁读重建价值高，保持启用）；MISSING ≤1 → 记 `low`（主 agent 单路已够，未来可降级）。

### 边界

- **机器检查是前置门**：CW gate 机器检查 FAIL 时先修结构硬伤，不派禁读重建（结构烂的 plan 重建无意义）。
- **不替代步骤 0b/2b/4b**：本步是测试设计的盲区重建，0b/2b/4b 是范围/复用/测试完整性检查。互补关系，不是替代。
- **小功能不触发**：1-2 改动点、1 Wave 的极简功能，机器检查 + 步骤 6 单路自检已够，禁读重建编排开销 > 收益。
- **E2E 不重建**：E2E 受执行栈强约束，重建误报多。禁读重建只针对单测。E2E 走机器检查（执行方式非抽象）+ 单路自检。

## Self-Check

**[MANDATORY] 全部满足才算 plan 完成。**

范围与目标：
- [ ] 已做范围守门自检，确认属于 lite（非 full）范围
- [ ] **若触发步骤 0b**（5 条判据 1-2 条处于边界）：范围守门 ensemble 已投票，3 票一致或 2:1 偏升级已升级；2:1 偏留 lite 时边界判据已 ask_user 确认；未触发则确认范围明确（0 条或多条命中直接判定）
- [ ] 业务目标有可衡量成功标准（非"做好 X"）
- [ ] 技术改动点是文件级清单，无遗漏
- [ ] 已读项目规范文档（README/CLAUDE.md/AGENTS.md 等），约束已进「业务目标」章节的约束字段
- [ ] 每个技术改动点已查复用（标注复用来源 or 不可复用原因）
- [ ] **若触发步骤 2b**（改动点 ≥3）：复用检查 ensemble 多路候选已并集去重 + 判定真复用（vs 仅相似）后进技术改动点；未触发则确认单路复用检查已做
- [ ] 若启用并行加速模式：2 路 bg 草案（技术方案 + 测试设计）已合并；阻塞性假设已逐条拿用户答案核对（推翻的已重做）；细节性占位符已填；交叉校验已做（技术方案改动点 vs 测试覆盖清单一致）；测试清单 fixture 已 review（不盲采 bg 预期）

Wave 拆分：
- [ ] 每个 Wave 是垂直切片（非水平切片）
- [ ] blocked_by 从调用关系 + 文件影响集推导（有依据）
- [ ] 同并行组 Wave 改动文件无交集

测试设计（重中之重）：
- [ ] 每个技术改动点至少 1 条单测
- [ ] 单测每条可机器判定（输入/预期具体值）
- [ ] 每个覆盖点覆盖正常 + 异常 + 边界
- [ ] E2E 已探测项目实际测试栈，执行方式写明具体命令
- [ ] **E2E 每条标测试层（mock/real），且 mock 层 + real 层各至少 1 条**（real 层无环境则标 `[需集成环境]` 降级手动，不可省略）
- [ ] E2E 覆盖每业务用例 happy path + ≥1 失败 path
- [ ] 每处代码改动已评估现有测试如何随之改（不只新增，还有适配修改）
- [ ] 覆盖率 gate 写明命令（按语言×框架表）+ 增量算法 + 阈值
- [ ] **若触发步骤 4b**（改动点 ≥3 / 涉及过滤·查询·匹配·状态机）：ensemble 漏用例建议已去重对照后合并入单测清单；未触发则确认属于明确小功能（1-2 改动点）单路反向自检已做

格式：
- [ ] 含 `## 实现步骤` 标题（plan extension 桥接依赖）
- [ ] 无占位符（TBD/TODO/...）

审查：
- [ ] **若触发步骤 5b**（改动点 ≥3 或 Wave ≥2）：CW gate 机器检查通过（`cw(action=plan)` 触发，结构硬伤已修）；禁读重建三态 gap 已处理（MISSING 已补 / PHANTOM 已删 / MISMATCH 已改）；未触发则确认属于明确小功能（1-2 改动点、1 Wave）机器检查 + 单路自检已做

## 交付

plan.md 自检全通过后，**必须额外产出 plan.json**（CW `plan` action 的入参，D-006 结构化 JSON）。

**plan.json schema 见 `../lite-shared/references/cw-json-schemas.md`「plan.json」节**（字段约束 + format 锁定 + 写入路径）。
关键提醒：`format` 必须 === `"lite"`（D-003 tier 锁定）；`testCases[].id` 用 `E1` 格式；`testCases[].expected` 是 judgeByExpected 重算基准。

> **[铁律] plan.json.testCases 只装 E\*（E2E），U\*（单测）不进 plan.json。** U* 留 plan.md 的「单测用例清单」章节，coding-execute 执行收尾机器门（check-execute.ts）读 plan.md + test-results.json 验收 U*。plan.json 的 testCases 只服务 CW test gate（test.ts judgeByExpected 重算 E*）。详见 cw-json-schemas.md「plan.json」节的映射说明。

plan.json 写到 `.xyz-harness/{topic}/plan.json`。写完后调 CW：

```
cw(action=plan, topicId="<create 时返回的 topicId>", planJson=<JSON.parse(plan.json 文件内容)，必须传 object 不能传 string>)
```

**[MANDATORY] `planJson` 必须是 object**（`JSON.parse` 后的值），不是 JSON 字符串。
传 string 会被 CW 在 `assertFormat` 拒（报 `invalid plan json: not an object`），因为 schema 声明的是 `type: object`。

CW 通过 plan gate 后返回 `nextAction: {action:"dev", skill:"coding-execute", waves:[...]}`，
按它推进（不自行决定下一步）。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
