---
verdict: APPROVED
machine_check: PASS
mode: review
upstream: code-architecture.md, code-architecture.html, issues.md, requirements.md, non-functional-design.md, changes/tracing-code-arch-round-1.md
round: 2
reviewer: independent
dimensions: [internal-consistency, upstream-alignment, executability, completeness, visualization-quality]
note: >
  2026-06-25 schema 复审 + test-matrix 补全 + Step 7 骨架验证：
  frontmatter verdict 大写化 + 加 machine_check 字段 + upstream spec.md→requirements.md（①阶段重构后真相源）。
  补全 MANDATORY「测试矩阵」§6（来源 A 27 条 + 来源 B 11 条 NFR-AC）+ §7 现有代码映射 + 占位符修复。
  check_code_arch.py 8/8 PASS。**Step 7 骨架验证 PASS**（实现代码即骨架：tsc exit 0 + 无 any/eslint-disable/TODO + engine 零 Pi 依赖 + 277/277 测试通过，见 changes/skeleton-verification.md）。
---

# 代码架构定稿审查 — Round 1（11 gap 闭合验证 + 5 维度）

## 判定摘要

**CHANGES_REQUESTED**。11 个 gap 中 8 个完全闭合、3 个部分闭合/残留扩散；5 维度中**内部一致性 FAIL**（budget 检查点这条架构脊柱上，spec.md + issues.md #5 标题/正文 与 issues.md #5 验收 + NFR + code-architecture 三处 persistAndUpdate 表述矛盾）。问题集中在 G4 修订不彻底——只改了 #5 验收行和 code-arch §6，没有回溯清理 spec.md（FR-5/AC-5/UC-3/Background）和 issues.md #5 的标题/问题描述，等于把矛盾从「issues vs NFR vs code-arch」平移到了「spec + issues 标题/正文 vs issues 验收 + NFR + code-arch」。

阻塞交接的是 **F1（spec.md 脊柱矛盾）+ F2（issues.md #5 内部自相矛盾）**，修复成本极低（文本替换 + 一句取证说明），但不修则 budget 这条唯一自动终态路径的需求源头与设计源头对不上。

---

## Part A: G1–G11 闭合逐项核对

| Gap | 追踪报告描述 | 定稿验证证据 | 闭合判定 |
|-----|------------|------------|---------|
| **G1** | budget.ts 契约表漏 accumulateTokens / getTokenUsagePercent | §3 budget.ts 表已补这 2 行；但源码 budget.ts 实际导出 **8 个**函数，仍漏 `getTimeUsagePercent`(budget.ts:92) / `getBudgetColor`(budget.ts:98)，二者被 widget.ts:21 import 且 94/98/154/158/188 多处调用 | **部分闭合** → F3 |
| **G2** | service.ts makeResult 等 state.tasks 引用，#1 验收未覆盖 | issues.md #1 验收已增「service.ts 内所有 state.tasks 引用已迁移或删除（makeResult 等 ~8 处）」；源码取证 service.ts 当前 **20 处** `state.tasks`，验收写「所有…~8 处举例」语义覆盖（数字偏低但不影响验收正确性） | **闭合** |
| **G3** | complete 的 plan.md audit 无契约；spec FR 正文与 AC 自相矛盾 | spec.md FR-6 已改为「todo 完成状态硬检查；plan.md 步骤对照为 prompt 驱动软提醒（D27 决策）」；FR-7 同步「非性硬检查——todo 完成状态是唯一硬检查」；code-arch §3 handleComplete 与 spec 一致（plan audit 不入硬契约） | **闭合** |
| **G4** | budget 检查点落点（persistState vs persistAndUpdate）三文档矛盾，#5 验收不可判定 | **矛盾扩散**：issues.md #5 验收(行336) + NFR #5(行99/111/115) + code-arch §3/§6 已统一为 persistAndUpdate ✓；但 issues.md #5 标题(289)/问题描述(298)/缺点(318) 仍是 persistState，spec.md FR-5/AC-5/UC-3/Background(行16/87/95/97/163/211) 仍是 persistState | **部分闭合（残留扩散）** → F1+F2 |
| **G5** | persistAndUpdate 迁入 service.ts 无 issue 跟踪，#4 验收遗漏 | issues.md #4 验收已增「persistAndUpdate 已迁入 service.ts（event-adapter.ts 不再持有 persist 逻辑）」；源码取证 persistAndUpdate 现住 event-adapter.ts:198，确需迁移 | **闭合** |
| **G6** | 功能 3 时序图用 checkBudgetOnTurnEnd 做 terminal 判定，与契约冲突 | 功能 3 时序图正文已改「persistAndUpdate 内直比较」+ Note「非 checkBudgetOnTurnEnd」；但**数据流链(行276)仍写** `service.persistAndUpdate → engine/budget.checkBudgetOnTurnEnd → transitionStatus` | **部分闭合** → F4 |
| **G7** | 功能 5 时序图把 timeStartedAt 重置归给 tickState | 功能 5 时序图已改「CA→CA: timeStartedAt = Date.now()（直接赋值）」+ Note「tickState 不重置」；§3 tick 契约补「不负责 timeStartedAt 重置（见 G7）」；源码取证 tickState(service.ts:75) 确实不重置 | **闭合** |
| **G8** | 功能 2 时序图只画 4 个 AC-2 前置分支中的 2 个 | 功能 2 时序图现有 4 个 alt 分支（todo 未安装 / 空数组 / 有未完成 / 全部完成），覆盖 AC-2 前置 1/2/4；AC-2 第 3 条「验证任务不可 cancelled」是 todo 检查子逻辑，可接受不单独成支 | **闭合** |
| **G9** | 依赖图漏画 persistence → ports 边 | §2 依赖图已补 `persistence --> ports`；HTML 同步；源码取证 persistence.ts:16 `import { GoalHistoryEntry } from "./ports"` 属实 | **闭合** |
| **G10** | prompts.ts ~370 LOC，#9/#10 膨胀有破 400 风险 | §6 Wave 5 已记「Watch：prompts.ts 重构后 ~370 LOC，#9/#10 prompt 膨胀有破 400 风险，需监控」 | **闭合（watch item）** |
| **G11** | ServicePorts 聚合接口定义在 service.ts 而非 ports.ts，design 未声明 | §1 目录表 ports.ts 行已注明「ServicePorts 聚合接口当前在 service.ts，重构可考虑归 ports.ts」；源码取证 ServicePorts 确由 service.ts 导出（tool-adapter.ts:20、actions.ts:16 均 `from "../service"`） | **闭合** |

**闭合统计**：完全闭合 8（G2/G3/G5/G7/G8/G9/G10/G11），部分闭合/残留 3（G1→F3、G4→F1+F2、G6→F4）。

---

## Part B: 五维度审查

### 维度 1: 内部一致性 — **FAIL**

budget 检查点是 goal 唯一的自动终态路径（UC-3），是架构脊柱。定稿后该脊柱的落点函数在文档间仍然分裂：

| 文档 | 位置 | 表述 | 对齐? |
|------|------|------|------|
| spec.md:16 | Background | 「budget 检查单一检查点在 persistState」 | ✗ |
| spec.md:87 | FR-4 权限表 | 「persistState 兜底（FR-5）」 | ✗ |
| spec.md:95 | FR-5 标题 | 「budget 自动触发（persistState 兜底）」 | ✗ |
| spec.md:97 | FR-5 正文 | 「persistState 内加 budget 兜底」 | ✗ |
| spec.md:163 | AC-5 | 「persistState 内有 budget 兜底」 | ✗ |
| spec.md:211 | UC-3 | 「persistState 检测 → budget_limited」 | ✗ |
| issues.md:289 | #5 标题 | 「budget 单一检查点（persistState 兜底）」 | ✗ |
| issues.md:298 | #5 问题描述 | 「终态转换只在 persistState 内完成」 | ✗ |
| issues.md:318 | #5 方案A缺点 | 「终态通知延迟到 persistState」 | ✗（逻辑上也错） |
| issues.md:336 | #5 验收 | 「persistAndUpdate 内有 budget 终态检查（事件路径）」 | ✓ |
| NFR #5 (99/111/115) | 取证段 | 「事件路径 persist（persistAndUpdate）…不是 service.persistState」 | ✓ |
| code-arch §3 (123) | persistAndUpdate 契约 | 「事件路径用；…budget 终态检查」 | ✓ |
| code-arch §6 (412) | 架构决策 | 「budget 终态检查在 persistAndUpdate（事件路径）」 | ✓ |

G4 修订只触及 issues.md #5 验收行 + code-arch §6 + NFR（NFR 本来就对），**没有回溯清理 spec.md（6 处）和 issues.md #5 标题/问题描述/缺点（3 处）**。结果：

- **issues.md #5 自相矛盾**：同一 issue 内，标题/问题描述说 persistState，方案 A/验收说 persistAndUpdate。实现者读 #5 问题描述会得到错误结论。
- **spec.md（需求源头）与 issues.md #5 验收（设计验收）矛盾**：任何回溯 spec 的人会认为终态检查在 persistState（command/tool 路径），而 #5 验收要求在 persistAndUpdate（事件路径）。两个函数服务不同代码路径——按 spec 字面实现，UC-3（message_end 累加 token 后预算耗尽自动终止）的调用链会断裂，因为 message_end/turn_end 不调 persistState。

code-arch §3 行153 的「NFR 交接」注释（「上游 system-architecture/issues 写的 persistState 检查点，实际在 persistAndUpdate」）是个补丁，但它只点出了 system-architecture/issues，**没提 spec.md**，且没有驱动 spec.md 回溯修订。补丁不能替代源头修正。

**次级一致性残留（G6）**：code-arch 功能 3 数据流链（行276）「service.persistAndUpdate → engine/budget.checkBudgetOnTurnEnd → transitionStatus」与时序图正文（直比较）和 §3 checkBudgetOnTurnEnd 契约（「只返回 warning，不返回 terminal」）矛盾。G6 修订了时序图正文，漏了同节末尾的数据流链。

### 维度 2: 上游对齐 — **PASS**

spec.md 实际定义 UC-1~UC-4（4 个用例），FR-1~FR-7：

| 上游项 | 契约落点 | 状态 |
|--------|---------|------|
| UC-1（plan→goal→todo→audit 全流程）| 功能1（set）+ 功能2（complete）+ §3 pi.__goalInit/__planStart | ✓ |
| UC-2（用户叫停续跑）| 功能5（pause/resume）+ §3 transitionStatus/checkBudgetOnResume | ✓ |
| UC-3（预算耗尽自动终止）| 功能3（budget 自动终态）+ §3 persistAndUpdate | ✓（契约在，落点表述见维度1） |
| UC-4（agent 自主完成）| 功能2（complete）+ §3 handleComplete | ✓ |
| FR-1~FR-7 | §3 各模块契约表均有对应行 | ✓（G3 闭合后 FR-6/FR-7 的 plan audit 已明确为 prompt 驱动） |

所有 UC + FR 都有对应契约。维度 2 通过。

### 维度 3: 可执行性 — **PASS**

§6 Wave 编排推导表清晰，能从时序图 + issues.md blocked_by 推导依赖：

- Wave 推导与 issues.md 依赖图（#1→#3→#4→#5/#6/#8；#7→#5/#10）一致
- 每张时序图都标注了对应 Wave 和依赖的其他时序图
- persistAndUpdate 迁移（G5）已落入 Wave 3（#4 验收）
- prompts.ts LOC watch（G10）已标注在 Wave 5

下游执行计划可拿着这份文档做 Wave 编排。维度 3 通过。

### 维度 4: 完整性 — **WARN（非阻塞）**

- **方法签名表基本完整**：engine/goal、engine/budget、service、tool-adapter、event-handlers、index 各模块均有契约表。
- **G1 残留（F3）**：budget.ts 契约表漏 `getTimeUsagePercent`(budget.ts:92) 和 `getBudgetColor`(budget.ts:98)。源码取证二者被 widget.ts:21 import 并多处调用（94/98/154/158/188）。G1 补了 accumulateTokens/getTokenUsagePercent（核心），漏了这 2 个渲染辅助导出——若实现者按 §3 表「重建」budget.ts，widget 编译会断裂。
- **异常路径覆盖**：功能 2（complete）的 4 个 alt 分支、功能 5（resume）的 budget 超限分支、功能 1（set）的非终态拒绝分支齐全。
- **#1 验收**：已覆盖 state.tasks 迁移（G2 闭合）。

维度 4 因 F3 标 WARN，不阻塞。

### 维度 5: 可视化质量 — **PASS**

- HTML 加载 Mermaid CDN（`mermaid@10`），`securityLevel: 'loose'`，依赖图 + 3 张核心时序图均可渲染。
- HTML 与 md 的依赖图一致（均含 persistence→ports 边，G9 闭合）。
- HTML 顶部 callout 明确标注 G4 决策（budget 检查在 persistAndUpdate）。
- HTML 契约摘要表与 md §3 一致。
- 依赖图无环声明与源码取证一致（engine/ports 叶子，单向向下）。

维度 5 通过。

---

## Part C: Finding 清单

### 阻塞级（必须修复才能交接）

#### F1 [一致性] spec.md budget 检查点落点未回溯修订
**证据**：spec.md 行 16/87/95/97/163/211 共 6 处仍写 `persistState`，与 issues.md #5 验收(336)、NFR #5、code-arch §3/§6 的 `persistAndUpdate` 矛盾。
**影响**：spec 是需求源头（Step 1）。实现者或后续维护者回溯 spec 时，会认为 budget 终态检查在 persistState（command/tool 路径）。按此实现，message_end/turn_end 事件路径不调 persistState，UC-3（预算耗尽自动终止）调用链断裂。
**修复**：spec.md 6 处 `persistState` → `persistAndUpdate`（事件路径）；FR-5 标题/正文补一句「事件路径 persist（NFR F2 取证确认），非 command/tool 路径的 persistState」。AC-5 同步。

#### F2 [一致性] issues.md #5 标题/问题描述/缺点未回溯修订
**证据**：issues.md #5 内部自相矛盾——标题(289)「budget 单一检查点（persistState 兜底）」、问题描述(298)「终态转换只在 persistState 内完成」、方案A缺点(318)「终态通知延迟到 persistState」，但方案A改动(311)/架构事实(315)/验收(336)说 persistAndUpdate。
**影响**：实现者读 #5 问题描述（而非验收）会得到错误落点。#5 是 P1 核心 issue，标题/问题描述是首要阅读面。
**修复**：#5 标题、问题描述、方案A缺点 3 处 `persistState` → `persistAndUpdate`（事件路径）。

### 非阻塞级（建议修复，不阻交接）

#### F3 [完整性，G1 残留] budget.ts 契约表漏 2 个现存导出
**证据**：code-arch §3 budget.ts 表列 6 行，源码 budget.ts 导出 8 个函数。漏 `getTimeUsagePercent`(budget.ts:92)、`getBudgetColor`(budget.ts:98)，二者被 widget.ts:21 import 并在 94/98/154/158/188 调用。
**影响**：若实现者按 §3 表重建 budget.ts，widget 编译断裂。严重度低于 F1/F2（渲染辅助函数，非脊柱）。
**修复**：§3 budget.ts 表补 2 行（getTimeUsagePercent / getBudgetColor），标注返回值与消费方（widget）。

#### F4 [一致性，G6 残留] 功能 3 数据流链仍引用 checkBudgetOnTurnEnd
**证据**：code-arch 功能 3 时序图正文已改「直比较」，但同节末尾数据流链(行276)仍写 `service.persistAndUpdate → engine/budget.checkBudgetOnTurnEnd → engine/goal.transitionStatus`。checkBudgetOnTurnEnd 契约（§3）明确「只返回 warning，不返回 terminal」。
**影响**：数据流链与时序图正文 + 契约矛盾，实现者可能照链把终态逻辑挂到 checkBudgetOnTurnEnd，复活 G6 原始问题（双检查点 race）。
**修复**：数据流链改为 `service.persistAndUpdate（直比较 tokensUsed/timeUsed）→ engine/goal.transitionStatus`，删除 checkBudgetOnTurnEnd 节点（它只在 agent_end 预警路径，不在终态路径）。

---

## Part D: 结论

定稿在**架构骨架层面是正确的**——分层（engine/ports 叶子 → service → adapters/projection）、变化轴、Deep Module 论证、Wave 编排推导都成立，G2/G3/G5/G7/G8/G9/G10/G11 八个 gap 干净闭合，可视化页面渲染正确。

但在 **budget 检查点这条唯一自动终态脊柱上，G4 的修订是半成品**——只改了 issues.md #5 验收行和 code-arch §6，没有回溯清理 spec.md（6 处）和 issues.md #5 标题/问题描述/缺点（3 处）。结果是矛盾没有消除，只是从「issues vs NFR vs code-arch」平移到了「spec + issues 标题/正文 vs issues 验收 + NFR + code-arch」。需求源头（spec）与设计验收（#5）对不上，不符合「内部一致性」维度的「三文档无矛盾」标准。

F1/F2 修复成本极低（9 处文本替换 + 一句取证说明），但不修则不可交接——budget 脊柱的需求/设计/实现三端必须对齐到同一落点函数。

**判定：CHANGES_REQUESTED**。修复 F1+F2（阻塞）后可重新提交审查；F3+F4（非阻塞）建议同批修掉。

---

## 修复 checklist（供修订方）

- [ ] **F1** spec.md 行16/87/95/97/163/211：persistState → persistAndUpdate（事件路径），FR-5/AC-5 补取证说明
- [ ] **F2** issues.md #5 行289(标题)/298(问题描述)/318(缺点)：persistState → persistAndUpdate（事件路径）
- [ ] **F3** code-arch §3 budget.ts 表补 getTimeUsagePercent / getBudgetColor 两行
- [ ] **F4** code-arch 功能3 数据流链(行276)：删除 checkBudgetOnTurnEnd 节点，改为 persistAndUpdate 直比较 → transitionStatus

---

# 代码架构定稿审查 — Round 2（F1-F4 修订复核）

## 判定摘要

**APPROVED**。Round 1 的 4 个 finding 全部闭合——budget 检查点这条架构脊柱的需求源头（spec）、设计验收（issues #5）、代码契约（code-arch §3/功能3）三端已对齐到同一落点函数 `persistAndUpdate`（事件路径）。budget.ts 契约表补齐 8 个导出，实现者按表重建不会编译断裂。功能3 数据流链不再把终态逻辑挂到 checkBudgetOnTurnEnd，G6 原始 race 风险不复活。

残留的 `persistState` 字样经逐条取证，全部属于三类合法语境（command/tool 路径正确使用 / disambiguation 取证说明 / 被否决的方案B语境），**无一处把 budget 检查点错误归给 persistState**。

## Part A: F1-F4 逐项取证

### F1 [一致性] spec.md budget 落点统一为 persistAndUpdate — **CLOSED**

**取证命令**：`grep -n "persistState\|persistAndUpdate" spec.md`

**budget 检查点全部落在 persistAndUpdate（7 处）**：
| 行 | 位置 | 表述 |
|----|------|------|
| 16 | Background | 「budget 检查单一检查点在 persistAndUpdate（事件路径，NFR F2 取证确认）」 |
| 87 | FR-4 权限表 | 「persistAndUpdate 兜底（FR-5）」 |
| 95 | FR-5 标题 | 「budget 自动触发（persistAndUpdate 兜底，事件路径）」 |
| 97 | FR-5 正文 | 「persistAndUpdate 内加 budget 兜底」+ disambiguation 取证注 |
| 152 | AC-4 | 「系统自动 budget/time_limited（persistAndUpdate）」 |
| 163 | AC-5 | 「persistAndUpdate 内有 budget 兜底（单一检查点，终态转换只在此处）」 |
| 211 | UC-3 | 「persistAndUpdate 检测 → budget_limited」 |

**仅剩 1 处 persistState（行97），且是 F1 明确要求补的取证说明**：
> 「注：persistAndUpdate 是事件路径（message_end/turn_end）的 persist 函数，非 command/tool 路径的 persistState」

这是 disambiguation，不是矛盾落点。Round 1 报告的 6 处矛盾（16/87/95/97/163/211）全部修正。

**结论**：spec 需求源头与设计验收对齐。F1 闭合。

### F2 [一致性] issues.md #5 标题/问题描述/缺点统一为 persistAndUpdate — **CLOSED**

**取证命令**：`sed -n '285,340p' issues.md | grep -n "persistState\|persistAndUpdate"`

**F2 要求的 3 处全部修正**：
| #5 区块相对行 | abs 行 | Round 1 | Round 2 | |
|--------------|--------|---------|---------|---|
| 标题 | ~289 | persistState 兜底 | persistAndUpdate 兜底，事件路径 | ✓ |
| 问题描述 | ~298 | 只在 persistState 内完成 | 只在 persistAndUpdate（事件路径 persist 函数）内完成 | ✓ |
| 方案A缺点 | ~318 | 延迟到 persistState | 延迟到 persistAndUpdate | ✓ |

**#5 区块内残留的 persistState 全部合法**（取证 5 处）：
- abs~315：架构事实 disambiguation note（「不走 service.persistState（command/tool 路径）」）— 取证说明，正确
- abs~322：方案B 标题（「保持 agent_end + persistState 双检查点」）— 被否决的备选，应保留 persistState 语境
- abs~328：方案B 缺点（race condition 描述）— 被否决备选的缺点举证，正确

方案B 是被否决的对照项，其内部提及 persistState 是论证语境，不是设计主张。#5 内部不再自相矛盾（标题/问题描述/方案A/验收一致指向 persistAndUpdate，方案B 作为对照项指向 persistState 属正确对比）。

**结论**：F2 闭合。

### F3 [完整性，G1 残留] budget.ts 契约表补 getTimeUsagePercent / getBudgetColor — **CLOSED**

**取证命令**：`awk '/### 模块: engine\/budget.ts/,/### 模块: service.ts/' code-architecture.md | grep -E "^\| ..."`

**契约表现有 8 行（与源码导出数对齐）**：
| 函数 | 签名 | 消费方标注 |
|------|------|----------|
| checkBudgetOnTurnEnd | (state, timeUsedSeconds) → BudgetCheckResult | 只返回 warning（70/90） |
| checkBudgetOnResume | (state) → {type, dimension} \| null | #5 |
| checkProgress | (state, progress) → ProgressCheck | #7 |
| accumulateTokens | (currentTokensUsed, usage) → number | — |
| getTokenUsagePercent | (state) → number | widget/agent_end 共用 |
| **getTimeUsagePercent** | (state, timeUsedSeconds) → number | **widget 消费**（F3 新增） |
| **getBudgetColor** | (percent) → error/warning/muted | **widget 消费**（F3 新增） |
| tick | (timeStartedAt, ...) → TickResult | 不负责 timeStartedAt 重置 |

**源码交叉验证**（确认这 2 个导出真实存在且被消费）：
- `budget.ts:92 export function getTimeUsagePercent`
- `budget.ts:98 export function getBudgetColor`
- `widget.ts:21 import { getBudgetColor, getTimeUsagePercent, getTokenUsagePercent }`
- widget.ts:95/98/99/155/158/159/193 多处调用

**结论**：实现者按 §3 表重建 budget.ts，widget 编译不会断裂。G1 残留完全闭合，F3 闭合。

### F4 [一致性，G6 残留] 功能3 数据流链删除 checkBudgetOnTurnEnd 节点 — **CLOSED**

**取证命令**：`sed -n '270,285p' code-architecture.md`

**Round 1 残留**（行276）：
> `service.persistAndUpdate → engine/budget.checkBudgetOnTurnEnd → transitionStatus`

**Round 2 现状**（行278）：
> `Pi(message_end) → message-end.accumulateTokens → service.persistAndUpdate（直比较 tokensUsed/timeUsed）→ engine/goal.transitionStatus（若超限）→ persistence.serializeState + notify`

checkBudgetOnTurnEnd 已从箭头链中删除。链路改为 persistAndUpdate 内「直比较 tokensUsed/timeUsed」，与时序图正文（「注：终态判定是直比较，非 checkBudgetOnTurnEnd」）和 §3 checkBudgetOnTurnEnd 契约（「只返回 warning，不返回 terminal」）三处一致。

行278 末尾的「注：checkBudgetOnTurnEnd 只在 agent_end 预警路径，不在终态路径」是显式 disambiguation，正确说明 checkBudgetOnTurnEnd 的真实角色，不是把它放回终态链。

**结论**：G6 原始问题（双检查点 race）不会复活。F4 闭合。

## Part B: 残留 persistState 全量语境审计

为排除「矛盾平移」风险，对三文档所有 persistState 残留做语境分类：

| 文档 | 残留数 | 全部合法? |
|------|--------|----------|
| spec.md | 1 | ✓ 行97 disambiguation 取证注（F1 要求补的说明） |
| issues.md | 5 | ✓ #5 区块内：架构事实 disambiguation(1) + 方案B 否决语境(4) |
| code-architecture.md | 14 | ✓ 见下表 |

code-architecture.md 14 处 persistState 逐条分类：
- **command/tool 路径正确使用**（6处）：行19（目录树）、94（循环依赖）、124（persistState 契约）、136（handleReportBlocked tool 路径）、182（功能1 set 命令路径）、335+365（功能5 pause 命令路径）
- **disambiguation 取证说明**（4处）：行155（NFR 交接注）、276（功能3 关键说明）、414（架构决策）、415（统一与否决策）
- **Deep Module 设计 seam 讨论**（4处）：行376/377/379（讨论 persistAndUpdate vs persistState 的设计 seam）

**无一处把 budget 检查点归给 persistState。** budget 检查点的落点表述在三文档中 100% 指向 persistAndUpdate。

## Part C: 最终判定

四项 finding 全部闭合，无新矛盾引入。budget 检查点这条 goal 唯一自动终态脊柱（UC-3）在需求源头（spec）→ 设计验收（issues #5）→ 代码契约（code-arch §3/功能3）三端术语统一为 `persistAndUpdate`（事件路径），Round 1 指出的「矛盾从 issues vs NFR vs code-arch 平移到 spec + issues 标题/正文 vs issues 验收 + NFR + code-arch」问题已消除。

G1 残留（F3）补齐后，budget.ts 契约表与源码导出完全对齐（8 函数全列），实现者按表重建零编译风险。G6 残留（F4）补齐后，功能3 数据流链不再把终态逻辑挂到只做 warning 的 checkBudgetOnTurnEnd。

**判定：APPROVED**。文档可交接给执行计划阶段（Step 6）。
