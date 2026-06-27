---
round: 1
date: 2026-06-25
tracked-perspectives: [Goal Traceability, Actor & Use Case Completeness, Data Flow Completeness, UI/UX Scenario Coverage, Cross-System Dependency]
---

> ⚠️ **[已过时 / Superseded — 2026-06-25]** 本文档记录的设计已被后续变更取代：
> goal complete 的 todo 强制前置检查已**移除**，改为仅 prompt 软建议（AI 自行决策，不强制）。
> goal extension 不再读 `pi.__todoGetList` / `pi.__planStart`；`checkCompletePrerequisites` / `buildProgressInput` / `findIncompleteTodos` / `checkProgress` / `ProgressInput` / `TODO_DEGRADED` 已全部删除。
> 根因：pi 框架给每个 extension 独立 api 实例，跨 extension 通信失效（todo 贴的 `__todoGetList` goal 永远读不到）。
> 以下历史内容保留为审查快照，**以根目录设计文档（spec.md / requirements.md 等）最新版为准**。

# Clarity Tracing Round 1 — requirements.md

> 独立 subagent 追踪。fresh context。
> 追踪对象：requirements.md（①澄清需求阶段交付物初稿）。
> 5 个业务视角强制枚举。卡住的地方 = gap。
> 实现层问题一律标「移交②系统设计处理」，不在本阶段展开。

## 视角 1: Goal Traceability（目标可追溯性）

### 检查结果
- [x] 每个业务目标有对应的达成路线（§达成路线表 G1.1–G4 全部有路线）
- [x] 每条路线拆解到了可验证的业务用例（路线→UC 映射完整，§2 全部 UC 有关联目标）
- [x] 无「孤立用例」（UC-1..UC-6 均有关联目标 + 达成路线）
- [x] 无「孤立目标」（G1.1/G1.2/G2.1/G2.2/G3.1/G3.2/G4 全部在达成路线表出现）
- [~] 目标间依赖/冲突关系：部分有声明（G1.1 暂停 vs G2.1 资源兜底在 D14 协调；G2.2 完成审计 vs G1.2 阻塞有 UC 串接），但 G3.2（plan 联动）与 G2.2（完成审计）的交互未明示——见 GAP-T1-04
- [~] 成功标准可衡量：G1.1/G2.1/G3 的成功标准是「行为可发生」级（"任意时刻可暂停""预算耗尽必然终止"），可验收但非量化指标；G2.2「不允许无证据完成」可验收。无量化 KPI（如"暂停响应延迟 < X"）——这类系统不一定需要，记为 K 待用户确认是否需要量化口径

### Gap 列表
| ID | Type | 问题 | 详情 |
|----|------|------|------|
| GAP-T1-01 | K | 成功标准缺乏量化阈值 | G1.1/G1.2/G2.1 的成功标准是行为级（"能暂停""必然终止"），无可衡量基线。例如"预算接近耗尽"的预警阈值（70%/90%）在 UC-3 替代流程出现，但 G2.1 成功标准里没回灌。需问用户：本重构是否需要量化验收指标，还是行为级 AC（已写在各 UC）即足够？ |
| GAP-T1-02 | D | 目标树中 G2.1 与「资源接近耗尽预警」的关系未在目标层声明 | UC-3 替代流程提到 70%/90% 预警引导收尾，但 G2.1 目标只说"资源约束是唯一兜底终止"。预警是 G2.1 的子能力还是独立目标？当前悬空。需决策：预警归入 G2.1 路线，还是单列为达成项。 |
| GAP-T1-03 | K | G3.2「规划与执行无缝衔接」的"无缝"定义模糊 | G3.2 成功标准"规划与执行无缝衔接"——"无缝"指 plan 完成后自动 __goalInit 不需用户再敲命令？还是允许用户确认？D9/D26 说"plan 完成后自动 init goal + 步骤转 todo"，但 requirements UC-1 主流程 step3"规划结果自动衔接到 goal 执行"未说清是否需用户确认。K：衔接是否完全自动（无人工 gate）？ |
| GAP-T1-04 | K | G3.2（plan audit）与 G2.2（completion audit）的校验关系未在目标层说明 | D27 决定 plan audit 是软提醒，todo 完成是硬检查。但 G3.2 目标"无缝衔接"与 G2.2"必须完成全部任务"在 plan 步骤未执行但 todo 全完成时会产生张力（todo 全完成≠plan 步骤全执行）。目标层未说明二者优先级。需问：plan 步骤未执行完但 todo 全完成时，应允许 complete 吗？ |

## 视角 2: Actor & Use Case Completeness（角色与用例完整性）

### 检查结果
- [x] Actor 列全：§2 用例图标了「开发者/Agent/预算系统」三个 Actor，系统边界（Goal 扩展）有 subgraph 标注
- [~] 隐含 Actor——见 GAP-T2-01（Plan Mode 作为触发衔接方，被提到但未列为 Actor/外部系统边界）
- [~] 同一 Actor 的权限级别——见 GAP-T2-02（"开发者"是否区分有/无 plan 可用的权限场景未提）
- [x] 用例前置/后置：UC-1..UC-6 每个都有前置条件 + 后置状态
- [~] 主流程/替代/异常覆盖——大部分有，但缺口见下表
- [x] 用例图标注了系统边界 + include/extend（UC-1 extend UC-4，UC-5 extend UC-2）

### 强制检查项（每 UC 主/替代/异常/前置/后置）
| UC | 主流程 | 替代流程 | 异常流程 | 前置 | 后置 |
|----|--------|----------|----------|------|------|
| UC-1 | OK | OK | OK（→UC-5） | OK | OK |
| UC-2 | OK | OK（从 blocked 恢复） | OK（崩溃重启） | OK | OK |
| UC-3 | OK | OK（预警） | OK（agent 忘完成→兜底） | OK | OK |
| UC-4 | OK | OK（plan 对照软提醒） | OK（拒绝完成） | OK | OK |
| UC-5 | OK | OK（→UC-6） | OK（非 active 拒绝） | OK | OK |
| UC-6 | OK | OK（有未终态目标拒新目标） | OK（幂等） | OK | OK |

### Gap 列表
| ID | Type | 问题 | 详情 |
|----|------|------|------|
| GAP-T2-01 | K | Plan Mode 是否应作为独立 Actor / 系统边界外的参与方 | UC-1 主流程 step2「Agent 判定任务复杂，建议先进 Plan Mode 规划」+ step3「规划完成自动衔接」——Plan Mode 在 UC-1 里既是被调用方又是产出方，但用例图把 plan 画在系统边界外（§6 关联图）。Plan 是 Actor 还是外部系统？其触发「规划完成」事件由谁发起（agent 还是 plan 扩展本身）？requirements 没说清。这影响 UC-1 的 actor 责任划分。 |
| GAP-T2-02 | D | UC-1 替代流程"任务简单时 Agent 跳过规划"的判定主体与触发点 | UC-1 替代流程说"Agent 跳过规划直接执行"，但 D26 说"LLM 自主判断复杂度"。判定"简单"这个动作发生在 goal 启动后第一轮？还是发起前？如果 agent 判错了（该规划没规划），有无补救？需决策：是否接受 agent 误判无补救（对齐 Codex 信任 agent）。 |
| GAP-T2-03 | K | UC-3"通知用户终止原因"的 Actor 责任未定义 | UC-3 主流程 step4「通知用户终止原因」——谁通知？预算系统是自动无人为触发的 Actor（UC-3 Actor 标注），它如何"通知用户"？通过 UI 状态提示（§5）？这是行为还是需要显式通知通道？需澄清"通知"的形态。 |
| GAP-T2-04 | F | UC-2 异常"进程崩溃后重启，暂停态应保持"与 D14 一致，但 requirements 未提 blocked 崩溃恢复 | UC-2 异常只写 paused 崩溃保持，但 D14/D20 决定 blocked 也对称（崩溃保持 blocked）。UC-5 没写崩溃恢复异常流程。spec FR-3 有「reconstructGoalState 不强制 paused→active（崩溃后保持 paused；blocked 保持 blocked）」——requirements UC-5 缺这条异常。可能漏写。 |
| GAP-T2-05 | D | 缺"恢复后预算已超"的用例/异常分支 | D25 决定 /goal resume 时做 budget 重检（checkBudgetOnResume 拒绝已超 budget 的 goal）。UC-2 替代流程"从被阻塞态恢复（需重检资源）"提到重检，但没说重检失败（resume 时发现已超 budget）怎么办。这是 resume 的异常分支，requirements 缺。需决策：resume 时已超 budget → 直接转终态？还是拒绝 resume？ |

## 视角 3: Data Flow Completeness（数据流完整性）

### 检查结果
- [x] DFD 画了（§3 mermaid，标注 用户/Agent/Goal/Todo/Budget/Plan/UI/历史 的流向）
- [~] 每类数据产生→处理→消费→归档：§3 数据清单表列了 5 类数据，但「来源/处理/消费者/归档/敏感级别」——见 GAP-T3-01
- [~] 数据在系统间流转格式：DFD 标了"只读快照""完成证据"但未标数据结构/格式——见 GAP-T3-02
- [x] 数据孤岛：规划产物→完成审计软提醒有消费；完成证据→历史有归档；无明显孤岛
- [~] 无源数据——见 GAP-T3-03（预警阈值的"基线"无源）
- [x] 敏感级别标注：5 类全标「内部」（合理，本系统无外部敏感数据）

### Gap 列表
| ID | Type | 问题 | 详情 |
|----|------|------|------|
| GAP-T3-01 | K | 数据清单「规划产物」的消费者/归档与 DFD 不一致 | §3 数据清单：规划产物→归档"项目 .xyz-harness/ 文件"。但 DFD 里 P[Plan 规划产物]→G，且 §6 关联图说 plan 步骤通过 prompt 引导 agent 调 todo 创建。规划产物到底是 plan.md 文件（被 agent 读）还是已被转成 todo 的数据？归档策略"项目文件"vs 其他数据"随会话持久化"——规划产物的生命周期与 goal 解耦（plan 文件随项目，goal 随会话），goal 终态后 plan 文件如何处理？需澄清。 |
| GAP-T3-02 | D | 跨系统数据流转的数据结构/格式未定义 | DFD 标"只读快照"（Goal←Todo）、"完成证据"（Agent→Goal）。但快照的 schema（Todo[] 结构）、证据的格式（string？结构化？）未在业务层定义。这偏实现，但「证据至少包含什么」（如"哪些任务+什么验证结果"）是业务可决定的。需决策：完成证据的业务最小内容要求。 |
| GAP-T3-03 | K | 预警阈值（70%/90%）的数据源/基线无定义 | UC-3 替代流程 + §5 UI 提到 70%/90% 预警。但"70%"的基数是什么——tokenBudget？timeBudget？两者独立还是合并算？数据清单"资源预算"行只说"已用 token/已用时间"，没说预警基线如何算。需澄清预警百分比的基数定义。 |
| GAP-T3-04 | F | CONTEXT.md 的 Todo 数据模型与 V2 requirements 冲突（事实层） | requirements 数据清单 + D2/D15 决定 todo 是四态 {id,text,status,isVerification?}（含 cancelled + isVerification）。但 CONTEXT.md「Todo」条目写"轻量级三态任务项 pending/in_progress/completed"，且「GoalTask」条目仍存在（V2 已删除 GoalTask）。CONTEXT.md 是统一语言来源，与 requirements 直接冲突。需更新 CONTEXT.md（否则后续阶段术语不一致）。这是事实层 gap：统一语言文档过时。 |

## 视角 4: UI/UX Scenario Coverage（界面交互场景覆盖）

### 检查结果
- [x] 本需求有 UI 交互（编辑器内状态栏 + /goal 命令面板），不降级
- [~] 每个用户用例有交互场景——见 GAP-T4-01（UC-4/UC-5 agent 触发的状态变化的用户侧可见性）
- [~] 关键页面布局——§5 只描述文字级（状态栏显示目标+剩余预算），无布局细节，但本系统无独立页面，文字描述可接受
- [x] 交互流程画了（§5 发起/暂停恢复/查看/预警/终止）
- [~] 不同终端——见 GAP-T4-03（Pi 是 TUI，终端一致性是否需说明）
- [~] 空状态/加载状态/错误状态——见 GAP-T4-02
- [x] 状态可见性有专节（§5 状态可见性：每个状态都有对应显示，暂停 vs 阻塞可区分）

### Gap 列表
| ID | Type | 问题 | 详情 |
|----|------|------|------|
| GAP-T4-01 | K | Agent 触发的状态变化（UC-4 完成/UC-5 阻塞）在用户侧如何呈现未描述 | §5 交互流程只描述用户主动操作（发起/暂停/恢复）的反馈。但 UC-4（agent 自主完成）、UC-5（agent 报告阻塞）是 agent 主动触发的状态变化——用户怎么知道 goal 完成了？怎么知道 goal 被阻塞了？§5 状态可见性说"每个状态都有对应显示"，但没说"完成时是否弹通知/阻塞时是否高亮提示"。需澄清 agent 触发态变化的用户通知方式。 |
| GAP-T4-02 | D | 错误状态的交互未描述 | §5 描述了正常态 + 预警态，但错误状态（如 /goal pause 在非 active 态被拒、/goal resume 时已超 budget 被拒、complete 前置检查失败）的用户反馈未描述。用户看到什么提示？需决策错误反馈的呈现（toast/状态栏/命令行回显）。 |
| GAP-T4-03 | K | 预算剩余的展示粒度未定义 | §5"状态栏显示目标与剩余预算"——剩余预算显示绝对值（剩余 X token / Y 分钟）还是百分比？两者都显示？这影响用户对"还剩多少"的感知。需澄清展示粒度。（偏实现但业务可决定展示口径） |

## 视角 5: Cross-System Dependency（跨系统功能关联）

### 检查结果
- [x] 关联图画了（§6 mermaid，Goal/Todo/Plan/Budget 四方）
- [x] 本系统依赖的外部系统功能列出（Todo 只读快照、Plan 双向联动、Budget 兜底）
- [~] 本系统提供给其他系统的功能——见 GAP-T5-01（Goal 暴露 __goalInit 给 plan/coding-workflow，requirements 未在关联清单列）
- [x] 依赖方向清晰（Goal→Todo 只读、Goal↔Plan 双向、Goal→Budget 消耗）
- [~] 同步/异步——见 GAP-T5-02
- [~] 契约稳定性——§6 标了 Todo/Plan/Budget 均"稳定"，但见 GAP-T5-03（CONTEXT.md 过时影响契约语义）

### 代码取证（验证现状事实）
- `pi.__todoGetList` 已存在于 extensions/todo/src/index.ts:42（返回快照）——契约存在
- `pi.__planStart` / `pi.__goalInit` 已存在于 extensions/plan、extensions/goal——契约存在
- extension-dependencies.json：goal dependsOn todo（optional）、plan dependsOn goal（optional）、coding-workflow dependsOn goal（optional）——依赖方向与 requirements §6 一致，无循环

### Gap 列表
| ID | Type | 问题 | 详情 |
|----|------|------|------|
| GAP-T5-01 | F | 关联清单漏列 Goal 对外提供的功能（__goalInit） | §6 关联清单只列了"本系统依赖的外部系统"（Todo/Plan/Budget），没列"本系统提供给其他系统的功能"。代码取证：plan dependsOn goal（通过 __goalInit 启动 goal）、coding-workflow dependsOn goal（同）。requirements 关联图把 Plan 画成双向（Goal<-->Plan），但关联清单只描述了 Goal 读 Todo、Goal↔Plan、Goal→Budget，没说 Goal 暴露什么给 Plan/coding-workflow。关联清单不完整（缺出向依赖）。 |
| GAP-T5-02 | K | 跨系统交互的同步/异步语义未标注 | 视角模板要求"跨系统交互是同步还是异步"。§6 关联清单"交互方式"列写了"运行时读取""运行时检测可用性+衔接""每轮累加+单一检查点"，但没明确同步/异步。例如 __todoGetList 是同步读取（快照），__planStart 是同步还是触发后异步等待？__goalInit 衔接是同步阻塞吗？这影响用户感知（衔接是否瞬时）。需澄清。 |
| GAP-T5-03 | F | CONTEXT.md 过时导致跨系统契约语义不一致（事实层） | CONTEXT.md「Budget」条目列四维度（Token/Time/Max Turns/Max Stall Turns），但 V2（D22/D28）删除了 Max Turns 和 Max Stall Turns。CONTEXT.md「GoalStatus」虽列了 paused/blocked 但「GoalTask」条目仍存在（V2 删除）。跨系统契约（goal 暴露的语义）依赖统一语言，CONTEXT.md 过时会让 plan/coding-workflow 等消费方对 goal 的理解错误。需更新 CONTEXT.md。同 GAP-T3-04。 |
| GAP-T5-04 | K | Todo 未加载时的降级语义在关联层未说明 | §6 Todo 行写"未加载时降级"，代码取证 todo 是 optional 依赖。但降级后：complete 前置检查会失败（D17 拒绝 complete）、budget checkProgress 无 todo 数据。requirements UC-4 异常说"未建任务清单/未加载→拒绝完成"，但关联层没说"Todo 缺失时 Goal 的核心能力（完成）受限"。需澄清：Todo 缺失是否应视为 Goal 不可用（而非降级运行）？ |

## 汇总

### 按类型统计
| 类型 | 数量 | 说明 |
|------|------|------|
| F（事实，需主 agent 二次确认） | 4 | GAP-T2-04、GAP-T3-04、GAP-T5-01、GAP-T5-03 |
| K（知识，需问用户） | 9 | GAP-T1-01、T1-03、T1-04、T2-01、T2-03、T3-01、T3-03、T4-01、T4-03、T5-02、T5-04 |
| D（决策，需做选择） | 4 | GAP-T1-02、T2-02、T2-05、T3-02、T4-02 |
| **总计** | **17** | （注：部分 ID 跨类，按主类型归类后 F=4, K=9, D=4） |

### 按优先级排序
**P0（阻塞收敛，必须在①阶段解决）**
1. **GAP-T3-04 / GAP-T5-03（F，重复）**：CONTEXT.md 过时——Todo 三态 vs V2 四态、GoalTask 仍存在、Budget 四维度 vs V2 两维度。统一语言文档与 requirements 直接冲突。这是事实层最严重 gap：①阶段交付物（requirements）与项目统一语言（CONTEXT.md）不一致，下游阶段会基于错误术语工作。必须更新 CONTEXT.md。
2. **GAP-T1-04（K）**：G3.2（plan audit 软提醒）与 G2.2（completion audit 硬检查）在"todo 全完成但 plan 步骤未执行完"时的张力未在目标层裁决。这是核心业务语义（完成的标准到底是什么），影响 UC-4 验收。
3. **GAP-T2-05（D）**：resume 时预算已超的异常分支缺失。D25 决定了要重检，但重检失败的行为（转终态？拒绝 resume？）未定，UC-2 异常流程不完整。

**P1（影响完整性，建议①阶段解决）**
4. GAP-T2-04（F）：UC-5 缺 blocked 崩溃恢复异常（D14/D20 已决策但 requirements 漏写）
5. GAP-T5-01（F）：关联清单缺出向依赖（Goal→plan/coding-workflow 的 __goalInit）
6. GAP-T1-03（K）：G3.2"无缝衔接"是否完全自动无 gate
7. GAP-T2-01（K）：Plan Mode 是 Actor 还是外部系统边界
8. GAP-T4-01（K）：agent 触发的状态变化（完成/阻塞）用户侧通知方式
9. GAP-T3-01（K）：规划产物（plan.md）的生命周期与 goal 解耦后的处理

**P2（细节，可后置）**
10. GAP-T1-01（K）：成功标准是否需量化阈值
11. GAP-T1-02（D）：预警归入哪个目标
12. GAP-T2-02（D）：agent 误判复杂度无补救是否接受
13. GAP-T2-03（K）：UC-3"通知"的形态
14. GAP-T3-02（D）：完成证据的业务最小内容
15. GAP-T3-03（K）：预警百分比基数
16. GAP-T4-02（D）：错误状态交互反馈
17. GAP-T4-03（K）：预算剩余展示粒度
18. GAP-T5-02（K）：跨系统同步/异步语义
19. GAP-T5-04（K）：Todo 缺失是降级还是 Goal 不可用

### 结论
requirements.md 在**目标可追溯性（视角1）和用例骨架（视角2主流程）**上结构完整、无孤立目标/用例，达成路线表清晰。

但存在 **17 个 gap**，集中在三类问题：
1. **统一语言过时（P0，F 类）**：CONTEXT.md 描述的是 V1 模型（GoalTask/三态 Todo/四维 Budget），与 V2 requirements 全面冲突。这是最严重的问题——①阶段的核心交付物（requirements）与项目术语权威（CONTEXT.md）不一致，必须先更新 CONTEXT.md 才能收敛。
2. **边界场景与异常分支不完整（P1）**：多个 UC 的异常/替代流程有缺口（resume 超预算、blocked 崩溃恢复、agent 触发态的用户通知、complete 时 plan vs todo 张力）。这些是业务语义层缺口，不是实现层。
3. **跨系统关联单向（P1，F 类）**：关联清单只画了入向依赖，漏了 Goal 暴露给 plan/coding-workflow 的出向契约。

**未发现实现层 gap 需在本阶段展开**——所有偏实现的问题（数据结构 schema、状态机字段、预警计算）均已标注为移交②系统设计或降级为业务口径决策。

**建议收敛动作**：
- 主 agent 优先处理 P0 的 3 个 gap（更新 CONTEXT.md + 裁决 plan audit vs completion audit 语义 + 定义 resume 超预算行为）。
- P1 的 F 类（UC-5 崩溃异常、关联清单出向）可直接补写无需问用户。
- K 类汇总问用户（约 9 个问题），D 类由主 agent 裁决或纳入下一轮。
