# Decisions — CW (Coding Workflow Orchestrator)

> 本 topic 的 append-only 决策账本。每条 D 类决策记录 id / decision / rationale / classification / confirmed_by / stage / source / status。

## D-001 CW 作为 tool 实现，不是 skill
- **decision**: CW 注册为 Pi tool（`coding-workflow`），非 skill。agent 通过 tool call 与之交互。
- **rationale**: skill 是文字指导（软约束，agent 可无视）；tool call 是机器交互（CW 垄断状态流转）。CW 要强制状态机流转，必须用 tool。source: 多轮设计讨论 + test-orchestrator 已验证的 tool 模式。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户："cw 提供一个 tool，多个 action"）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-002 CW 是上层编排器，goal/todo 是下层执行工具
- **decision**: CW 负责 gate + 状态流转 + 机器验证；goal 提供 active 循环框架 + budget + followUp；todo 管理 agent 具体任务拆分。三者职责不重叠。
- **rationale**: 避免重造 goal 的 budget/followUp；避免 CW 与 goal 强耦合（用户明确要求"不改 goal"）。agent 的 goal objective = "通过 CW 的对应阶段 gate"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户："cw 是上层编排器，负责提供 gate；goal todo 是 agent 实际执行过程中的工具"）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-003 tier 在 create-topic 锁定，不可变
- **decision**: `create-topic` 时确定 tier（lite/mid），写入 `_cw.json.tier`。后续 plan/clarify/detail 提交的 JSON `format` 字段必须 === tier，不匹配 gate 直接拒绝。CW 零 tier 嗅探/升档逻辑。
- **rationale**: 升档意味着 plan 全盘作废重来，不是"继续流转"。tier 锁定让状态机简单且防"中途降级偷工"。source: 用户纠正"不能默认升档，要根据入参来，改了应该作废重来"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-004 test-orchestrator 内化为 CW execute gate 的内部模块
- **decision**: test-orchestrator 不再对 agent 暴露独立 tool。其判定逻辑（judgeByExpected + 状态机 + 全覆盖校验）内化进 CW 的 test action。agent 工具箱只认 CW。
- **rationale**: agent 只认 CW 一个接口，杜绝"绕过 CW 直接调 test-orchestrator"路径。CW 垄断任务派发（test 派发：CW 返回 testCases，agent 跑完回报 actual，CW 机器重算）。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户选 B："test-orchestrator 调用收进 CW submit 内部"）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-005 dev 和 test 都是渐进式提交，数组参数兼容单/批量
- **decision**: dev 入参 `tasks: [{waveId, commitHash}]`，test 入参 `cases: [{caseId, actual, screenshotPath, ...}]`。数组长度 1 = 单个渐进提交，长度 N = 批量。CW 逐个 gate，累计全完成才算阶段通过。
- **rationale**: dev/test 对称设计；agent 可灵活选择渐进或批量；判定时机以 `_cw.json` 累计状态为准，单/批量在终态判定上等价。source: 用户"test 仅提供批量提交的参数，但 agent 想一个个提交也可传长度 1"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-006 plan 结构化为 JSON，CW 直接解析拆任务
- **decision**: plan/clarify/detail 三种产出物必须有结构化 JSON（plan.json/clarify.json/detail.json），format 字段锁 tier。CW 从 JSON 的 waves/testCases 字段直接解析 dev/test 任务清单写入 `_cw.json`。保留 .md 作为人类 review 载体，check 脚本读 .md 跑结构检查。
- **rationale**: md 不可机器解析拆任务；JSON 让 CW 能直接消费并记录状态。format 字段锁 tier 防 tier 漂移。source: 用户"提交的 plan 应该是结构化的 json 或 yaml，否则无法在 cw 中直接拆成任务并记录状态"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-007 skill 收口到 CW，删除跨阶段路由
- **decision**: 新增入口 skill `coding-workflow`（唯一入口）。各阶段 skill（lite-plan/mid-plan/mid-detail-plan/coding-execute/coding-retrospect/coding-closeout）删除"下一步 /skill:xxx"路由，description 改为"本 skill 唯一目标：通过 CW 对应阶段的 gate，完成后按 CW 返回的 nextAction 执行"。
- **rationale**: agent 看到全貌就能跳过中间阶段。收口后 agent 只见当前阶段 gate，跨阶段流转由 CW nextAction 唯一驱动。source: 用户"skill 应该只提供一个入口 skill，其他 skill 都收口到 cw 中作为 gate 通过后的返回 skill"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: **superseded by D-007-REVISIT**

## D-008 lite test 机器重算，mid test 信声明（诚实标注 gateTier）
- **decision**: lite 的 testCase.expected 结构化（{url, text}），CW test action 机器重算 actual vs expected，丢 claimedStatus（strong-recompute，密封）。mid 的 testCase.assertion 是自然语言，CW 无法重算，信 agent 声明的 status（medium-coverage）。gateTier 字段诚实标注强度差异。
- **rationale**: 可机器判定性的真实边界。mid 的断言（HTTP 状态码/权限/并发）天然不可 url/text 重算，强行统一是假门。诚实标注 medium vs strong 让 agent 和用户知道 lite test pass 比 mid test pass 可信度高。
- **classification**: D-不可逆
- **confirmed_by**: 设计推导（基于 test-case-schema.md 的 url/text 格式 vs mid 自然语言断言的事实差异）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-009 状态机线性，状态机本身是主强制点
- **decision**: 状态机 created→planned/clarified→detailed→developed→tested→retrospected→closed 线性流转。每个 action 有唯一合法前置状态，非法状态直接 throw（不跑 gate）。主强制点不是 goal_complete（不耦合 goal），是状态机本身——agent 不调 CW 就无法推进状态。
- **rationale**: 状态机是 CW 内部的，不依赖 goal。agent 必须和 CW 交互才能推进流程。**关键依据**：分析确认 goal_control(complete) 仅检查 evidence 字符串非空，对 todo/plan 状态不做硬检查（source: goal-control-adapter.ts），因此 goal 无法承担流程强制——CW 必须自担。source: 用户"不改 goal，这两个不能强制耦合" + "都有 gate 的返回，来指导 agent 下一步怎么做"。
- **classification**: D-不可逆
- **confirmed_by**: ask_user
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-010 CW MVP 先做 lite + mid，不做 full
- **decision**: CW 首版支持 tier=lite 和 tier=mid 两条路径。full 路径（full-clarity/full-architecture/.../full-execution-plan）暂不接入 CW。
- **rationale**: 渐进交付。lite/mid 覆盖大多数场景；full 的 6 阶段深度收敛与 CW 的状态机编排需额外设计（design_status 7 阶段状态机的整合）。先验证 lite/mid 再扩 full。
- **classification**: D-可逆（未来扩展 full 时本决策仍成立，只是范围扩大）
- **confirmed_by**: ask_user（用户："cw 当前先只做 mid 和 lite，不做 full"）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-007-REVISIT skill 收口降级（MVP 不删路由）
- **decision**: D-007 降级。MVP 只做入口 skill `coding-workflow` 新增 + 各 skill description 顶部加"对应 CW action: xxx"映射句。**不删路由章节，不改交付章节**。彻底删路由与 D-011 改名同步做。
- **rationale**: reviewer（红队）指出 D-007 删路由与 D-011 改名用同一推迟理由但待遇相反；且 CW 硬强制在状态机（D-009），agent 即使跳过 CW 直接调 coding-execute，dev commit 不被 CW 记录 → test 阶段 CW 因 status 不符直接 throw。强制力不依赖 skill 收口。删路由收益是避免双路由信息源冲突（真实但软），可推迟。
- **classification**: D-可逆
- **confirmed_by**: 设计推导（reviewer 交叉验证 + 主 agent 判断）
- **stage**: mid-plan review-fix-loop round 1
- **source**: review-fix-loop 红队发现 H6
- **status**: confirmed

## D-011 skill 改名推迟到 CW 稳定后
- **decision**: mid-plan→mid-clarify、mid-detail-plan→mid-detail 的改名不在本次做。本次用 SKILL description 顶部加"对应 CW action: xxx"映射。CW nextAction.skill 返回现 skill 名。
- **rationale**: 现在改名要同时改 CW 扩展 + 3 SKILL + 所有交叉引用，一旦 CW 设计调整改动面放大。改名是低风险机械工作，CW 稳定后批量做。
- **classification**: D-可逆
- **confirmed_by**: ask_user（用户认可"可以"推迟）
- **stage**: mid-plan
- **source**: 设计讨论 2026-07-03
- **status**: confirmed

## D-012 #1 CwStore + #2 状态机 guard 触发 DESIGN-IT-TWICE 发散
- **decision**: P0 两个根本性 issue（#1 CwStore 原子写 + #2 状态机 guard 组织）不直接采纳主 agent 的 Strong 推荐方案A，而是触发 DESIGN-IT-TWICE：派 3 subagent 给不同设计约束发散，按固定 slot 表产出，主 agent 逐 slot 横向对比后给 opinionated 推荐，最终选定 ask_user。
- **rationale**: 用户明确要求发散。虽然两题领域成熟（tmp+rename / 声明式转换表是社区标准），但作为 CW 根基的 P0 根本性选择，发散能暴露隐藏 cost 与 radically different 的权衡，避免错定第一个方案。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户选"触发 DESIGN-IT-TWICE 发散"）
- **stage**: mid-detail-plan
- **source**: issues.md batch-ask Step 1b
- **status**: confirmed

## D-013 P2 三个 issue 维持 P2 不升 P1
- **decision**: #9 nextAction 数据结构 / #10 渐进入参统一 / #11 schemaVersion 演进 维持 P2（重要但不阻塞核心路径）。不升 P1。
- **rationale**: #10/#11 是实现细节可后调；#9 nextAction 虽是 agent 接口契约但 MVP 可先扁平结构后续调整，不阻塞 handler 骨架。升 P1 无收益。
- **classification**: D-可逆
- **confirmed_by**: ask_user（用户选"维持 P2"）
- **stage**: mid-detail-plan
- **source**: issues.md batch-ask Step 1b
- **status**: confirmed

## D-014 迷雾 #14 多 session 并发写 _cw.json 不展开
- **decision**: #14 不从迷雾展开为正式 issue。当前假设单 agent 串行操作一个 topic。#1 实现后用集成测试模拟顺序调用验证。未来真有并发需求（GUI 多窗口/多 agent）再加乐观锁（version + CAS）。
- **rationale**: 当前无并发证据，展开需先确认场景是否真实存在，属未来需求（YAGNI）。NFR C-1 的 session 隔离 CW 已合规（无模块级状态）。
- **classification**: D-可逆
- **confirmed_by**: ask_user（用户选"不展开"）
- **stage**: mid-detail-plan
- **source**: issues.md batch-ask Step 1b
- **status**: confirmed

## D-015 full 路径不接入（Won't，非延后）
- **decision**: #13 full 路径接入明确为 Won't（不做），不只是 P3 延后。CW 定位是 lite+mid 工具，可见未来不接 full 6 阶段状态机。强化 D-010。
- **rationale**: 用户明确"full 不接入"（与 #12 改名延后对比，full 是不做非延后）。若未来需要 full，开新 topic 重新设计，不在本次 scope 留尾巴。
- **classification**: D-可逆
- **confirmed_by**: ask_user（用户选"改名延后。full 不接入"）
- **stage**: mid-detail-plan
- **source**: issues.md batch-ask Step 1b
- **status**: confirmed

## D-016 存储改用 node:sqlite（Node 内置）+ 关系表模式
- **decision**: CW 持久化层从「文件 _cw.json + 自实现 tmp+rename 原子写」改为「Node 内置 node:sqlite + 关系表」。数据模型从单 JSON 文件（§8.1 CwTopic）改为 sqlite 关系表（topic/wave/test_case/gate_history 分表）。修正架构 §6（零 Port：保留零第三方依赖精神，但 _cw 存储行从 fs 改 node:sqlite）和 §8（数据模型从 JSON 改关系表 schema）。
- **rationale**: 架构原选文件方案出于「零新依赖」，但代价是原子写/崩溃恢复都要自实现。DESIGN-IT-TWICE 发散中用户质疑为何不用 sqlite，指出 better-sqlite3 预编译问题应可解决。tavily 搜索证据：(1) better-sqlite3 在 Node 24 有官方确认预编译缺失（issue #1384，用户环境 Node v24.11.1 直接踩雷）；(2) node:sqlite 是 Node.js 官方内置模块（v22.5 引入，v23.4 不再需 flag，v25.7 成 RC），native build 责任归 Node 官方，用户零负担。三项实测全过（ESM import / 文件持久化 / 事务原子性——崩溃事务不污染）。node:sqlite 的 experimental 风险可接受（Node 25.7 已 RC，CW 用法是 SQL 标准不会随 API 变）。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户选"用 node:sqlite" + "关系表模式"；用户坚持调研推翻主 agent 的文件方案初始推荐）
- **stage**: mid-detail-plan
- **source**: issues.md DESIGN-IT-TWICE #1 发散 + tavily 搜索
- **status**: confirmed
- **影响**: #1 CwStore issue 降难度（原子写归 sqlite 事务，不再自实现）；#11 schemaVersion 语义从 deserialize 兼容改为 ALTER TABLE 迁移；架构 §6/§8 需修正（Step 1 末尾执行）

## D-017 第三重 guard 定位为数据完整性 self-check（非安全机制）
- **decision**: checkCacheConsistency（第三重 guard）保留代码，但重新定位：从原宣传的「防篡改」（安全机制）改为「数据完整性 self-check」（防御性编程）。它捕捉 store 层 bug（如 updateGatePassed 写错导致缓存与 gateHistory 不一致），**不是**防恶意篡改（honest agent 不改 _cw.db；malicious agent 改缓存+证据即绕过——红队 Route5 正确指出原「防篡改」定位是虚假安全感）。
- **rationale**: DESIGN-IT-TWICE Agent3 发散产出第三重，主 agent 在 code-arch task prompt 让 drafter 采纳，但 (1) 最终选定未登记 D 决策（流程失误），(2) 「防篡改」宣传夸大能力（用户基于此采纳）。红队 Route5 deletion test 指出删之系统仍完整工作。用户重新拍板：保留代码但诚实改定位（ask_user 选「重新定位为 self-check」）。保留理由：防 store bug 有真实价值，改动小（改注释+补决策），不推翻代码。不宣传为安全机制。
- **classification**: D-不可逆
- **confirmed_by**: ask_user（用户选「重新定位为 self-check」，基于红队 Route5 质疑后的知情决策）
- **stage**: mid-detail-plan review-fix-loop round 1
- **source**: review-fix-loop 红队 Route5 M1
- **status**: confirmed
- **影响**: state-machine.ts checkCacheConsistency 注释改；code-architecture.md 描述改（§3 签名表/§6 T2.6/§9 表）；nfr #2 安全维度不点出第三重（归数据完整性维度）
