# Context Summary — mid-detail-plan round 1

> CW grilling 前上下文。主 agent **不得重新确认**下述 confirmed 决策。

## 1. 不可推翻决策清单

D-不可逆（漏一条，主 agent 就会把已拍板决策当新问题重问）：

- D-001 CW 是 Pi tool 非 skill，垄断状态流转
- D-002 CW 上层(gate+状态机+机器验证)；goal 下层(budget/followUp)；todo 下层(拆分)。不改 goal
- D-003 tier(lite/mid)create-topic 锁定，JSON.format===tier，零升档
- D-004 test-orchestrator 内化为 CW test gate 内部模块，agent 只认 CW
- D-005 dev/test 渐进式提交，入参数组(1=单/N=批量)，逐个 gate 累计判定
- D-006 plan/clarify/detail 必产结构化 JSON(CW 解析拆任务)，.md 留人读+check 读
- D-008 lite test 机器重算丢 claimedStatus(strong-recompute)；mid test 信声明(medium-coverage)
- D-009 状态机线性(7 态 created→...→closed，见 §4.1)。主强制点=状态机本身(非 goal_complete，后者仅查 evidence 非空)

D-001~006/009 confirmed_by ask_user；D-008 by 设计推导。

D-可逆(不重确认)：D-010 MVP 只 lite+mid；D-007-REVISIT skill 收口降级(加入口+映射+review 落盘，**不删路由**)；D-011 改名推迟；~~D-007~~ superseded。

## 2. 设计树入口（细节读 system-architecture.md 对应节）

- issues(§5/§7/§9/§13)：gate 注册表+4 档+fail-fast、八条不变式、内化 5 步、review 桩(skill 落盘)、lib/gates 移除 re-export、JSON schema、遗留物(删 coding-execute.js/留 check_execute.py)、零 Port 代价
- nfr(§4.2/§7/§5.3/§8/§6)：两重校验、原子性(CwStore)、lite 密封、commit 三项校验、schema 演进、child_process、Session 隔离、coverage 分化
- code-arch(§2/§3/§4/§8/§12)：三层、目录(index.ts+src/cw/{state-machine,store,gates,plan-parser,types}.ts+actions/8)、状态机表、CwTopic、JSON schema、时序图(submit/dev/test 双分支)、签名表
- execution：Wave 拓扑 types→store/state-machine/gates/plan-parser→actions→index→删 test-orchestrator+删 coding-execute.js+移除 lib/gates re-export→skill 改造

## 3. 接口契约（硬约束）

- 状态机两重校验(§4.2)：①currentState∈expectedStatuses[action]；②渐进阶段进下阶段校验上阶段累计(dev 全 Wave committed 进 test；test 全 case passed 进 retrospect)。违者 throw 不跑 gate
- gateTier 4 档(§5.1)：weak-structural(仅结构)/medium-git(commitHash 三项,dev)/medium-coverage(+信声明,mid test)/strong-recompute(重算丢声明,lite test,唯一密封)
- _cw.json(§8.1)：schemaVersion=1；顶层 身份(tier 锁定)/status/planFormat/waves(committed)/testCases(expected|assertion/status/commitHash)/gateHistory(真相源)/evidence?/coverage?
- JSON 3 套(§12)：LitePlan(format:lite,waves+expected 结构化)/MidClarify(format:mid-clarify,仅 tier+deliverables,不含任务)/MidDetail(format:mid-detail,waves[issues]+assertion)。format===topic.tier
- 内化(§9)：judgeByExpected+类型→src/cw/types.ts；expected 解析→plan-parser.ts(JSON 结构化非 markdown 正则,重写)；src/test-orchestrator/ 整体删；index.ts 改 registerCodingWorkflowTool
- 零 Port(§6)：check_*.py/git/_cw.json/judgeByExpected/Pi SDK 全不做
- action 入参(§3)：除 create 外含 topicId；create 用 slug。**不订阅 pi.on**。错误 throw。dependsOn/parallelGroup 仅记录不消费(Wave 可乱序)。workspacePath=git cwd
- 遗留物(§13)：删 workflows/coding-execute.js；留 check_execute.py(跨格式 E1/T1.1,skill 内部门)

## 4. 长期约束

ARCHITECTURE：三层 monorepo；extension 独立 npm 包；进程内执行。

TEST-STRATEGY：vitest 禁 node:test；纯逻辑提独立模块；集成测试 PlainPallet 绕过；SDK 契约测试覆盖 pi.on/registerTool/ctx；不 import Pi SDK。

NFR C-1：禁模块级 let 跨 session 共享。CW 合规。

AGENTS：child_process 禁 fs 外原生(CW 第三用户)；Tool typebox+{content,details}+throw；禁 any；pi.extensions=["./index.ts"]。
