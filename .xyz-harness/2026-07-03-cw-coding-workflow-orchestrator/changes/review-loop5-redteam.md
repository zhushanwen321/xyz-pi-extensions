# Review Loop 5 — 红队·反过度设计

verdict: pass-with-deletions
认知帧：反向（质疑/删减）。对每处设计应用 deletion test。
覆盖范围：4 份文档（decisions/issues/nfr/code-arch）+ execution-plan + 16 个骨架文件（2057 行）。

## MUST_FIX（过度严重，建议删减）

### M1. 第三重 guard（checkCacheConsistency）是虚假安全感 + 无决策背书

**证据**：
- `state-machine.ts:46` 注释写「第三重：缓存一致性（**防篡改**）」，T2.6 测「篡改 topic.gatePassed 与 gateHistory 矛盾 → cache_inconsistent」。
- grep 确认：「防篡改 / cache_inconsistent / 第三重」在 `decisions.md`、`issues.md` **均无提及**。D-009 只授权「状态机本身是主强制点」，未授权三重 guard。它是 DESIGN-IT-TWICE Agent3 的产物，在 code-arch 阶段「悄悄」进了骨架，**未经 D 类决策登记**。
- 威胁模型在 D-014「单 agent 串行 + honest」假设下不成立：honest agent 不会去改 `_cw.db`（它不知道格式）；malicious agent 改缓存的同时改 `waves.committed + gateHistory` 即可绕过（第三重只比缓存 vs 重算，不验证据本身真实性）。

**Deletion test**：删 `checkCacheConsistency` + `computeGatePassedFromStore`（~25 行）+ T2.6。系统前两重 guard + gate + judgeByExpected 完整，防跳过能力不降。**通过 deletion test = 过度设计**。

**危害**：虚假安全感比「无保障」更危险——文档宣称防篡改，用户/agent 会依赖一个实际不成立的安全保障。

**建议**：二选一。
- (a) **删第三重**（推荐）：guard 收敛为两重（线性 + 级联）。gate_passed 缓存字段保留供第二重快速判定，删「缓存 vs 重算」自洽校验。
- (b) **重新定位 + 补 D 决策**：若保留，必须 (1) 在 decisions.md 登记新 D 决策说明为何需要它，(2) 注释从「防篡改」改为「数据完整性 self-check（捕捉 store bug）」，(3) T2.6 测试描述同步修正。**不得继续宣传为安全机制**。

## SHOULD_FIX（值得讨论）

### S1. D-016 node:sqlite 在 CW 负载下成本被低估（已 confirmed 不可逆，记债务）

**证据**：CW 负载 = 单 topic 单 db + 整体读改写 + 单 agent 串行（D-014）。node:sqlite 的核心优势（事务、JOIN、并发锁）在此场景**大多用不上**：单 action 整体写一个 tmp+rename 就是原子的；查询按 topicId 整读不需 JOIN；并发由 D-014 假设排除。代价是 experimental API 风险 + 4 表 DDL + 306 行 DAO + 迁移机制（#11 user_version）。D-016 理由「文件方案原子写/崩溃恢复都要自实现」被夸大——tmp+rename 是 30 行 POSIX 社区标准。

**Deletion test**：换回文件方案系统仍工作，且更简。但 D-016 已 ask_user confirmed 的 D-不可逆，本次不回退。

**建议**：记为债务（「未来若遇 experimental API 痛点或迁移负担，可回退文件方案」）；实施期抵抗「加索引/加缓存/引 kysely」的二次过度工程（issues.md #1 方案 B/C 已正确否决，保持）。

### S2. Wave 3 / Wave 4 拆分依据不足

**证据**：execution-plan W3（6 single-shot actions）与 W4（dev/test）串行依赖（W4 blocked_by W3）。但代码上 8 个 handler 都只依赖 state-machine/store/gates/parser，彼此不 import（§3 隔离原则）。W4 不需 W3 产物。拆 W3/W4 = 多一层 Wave 管理开销无收益。

**建议**：合并为「8 actions」一个 Wave，内部 subagent 并行（single-shot 组 + dev/test 组）。其余 Wave（0/1/2/5/6）有真实依赖，保留。

### S3. 第三重 guard 的连带复杂度（若 M1 选保留才适用）

**证据**：第三重要求 `gate_passed` 缓存字段 + `computeGatePassedFromStore` 双份重算逻辑（逻辑模型版 `computeGatePassed` + store 原始行版，维护两份）。`gate_history.progressive` 列当前无消费方（appendGateHistory 写，无 load 过滤逻辑用 progressive）。

**建议**：若 M1 删第三重，`gate_passed` 缓存可改为第二重直接重算（进一步简化）；`progressive` 列若审计不用则删。

## DEFEND（看似过度实则必要，给辩护）

### D1. 8 个 action handler 独立文件（不是过度拆分）

看似 8 文件多（actions/ 目录占 8/16 文件）。辩护：§3「加 action 不影响其他」是核心隔离原则——每 action 独立变化单元，grep 单文件可知全逻辑。合并成单文件 `actions.ts` 会违反单文件 1000 行上限（8 handler × ~80 行 + 公共逻辑已接近），且每加 action 改大文件增加 merge 冲突。8 文件密度合理（最短 create.ts 58 行有完整逻辑，最长 test.ts 148 行承载双分支）。**不删**。

### D2. GateRunner verdict 行 + exitcode 双信号（不是过度解析）

看似可只看 exit code。辩护：#6 方案 A 的核心价值就是区分「业务 fail」（check 发现问题，exit 1 + verdict FAIL，agent 改代码重试）vs「infra error」（python 缺失/crash/超时，agent 修环境）。单看 exit code 无法区分 verdict 与 crash（crash 也可能 exit 1）。双信号 + `infraError` 字段让 agent 重试策略分化，是必要的运维语义。**不删**。

### D3. CwStore / gates 的内部 seam（不是过度抽象）

CW 声称零 Port，但有 2 个内部 seam（CwStore mock、GateRunner/GitValidator mock）。辩护：test-matrix 中 mock 层用例（T2.1/T2.4/T2.6/T2.7/T4.1/T4.2 等约 20 条）必须注入故障场景（gate fail / cache 不一致 / 4 checker fail-fast / lite 谎报），不 mock 就要起真实 python+git+sqlite，无法注入「verdict/exitcode 矛盾」「subprocess 超时」等边缘。2 seam × (产+测) 2 adapter = 符合「2 adapter = 真 seam」。**不删**。（注：AC-1.5 宣称「DatabaseSync 可注入 mock」，但骨架 `CwStore` 构造函数只收 dbPath 字符串、内部 new DatabaseSync——seam 声明与骨架不一致，Wave 落地时需补构造函数注入。）

## OK（已验证非过度）

- **NFR 矩阵 11×7=77 格、24 个 ⚠️**：每个 ⚠️ 有「风险/影响/缓解/残余」4 字段实质展开，不是占位。稀疏度反映真实风险（#4 纯内存注册表 0 ⚠️ 合理；#6 subprocess 边界 5 ⚠️ 合理）。缓解项 17 条全回灌 test-matrix（T2.11-T2.28）。**无膨胀**。
- **骨架 16 文件**：14 代码文件 1:1 对应 §3 的 14 模块（无多余），2 基础设施（external.d.ts/tsconfig）。每文件有真实类型/SQL/schema/接线，无纯签名凑数文件。**密度合格**。
- **plan-parser 用 typebox Value.Assert**：复用项目既有依赖，schema 与类型同源避免双份维护（issues.md #5 方案 B/C 已正确否决手写+ajv）。V3 骨架验证 import 可解析。**非过度**。
- **dispatch 单 schema 全 Optional 参数**：是 schema 弱类型（agent 调 create 可传 planJson 被忽略），但属「不够设计」非「过度设计」，红队不指控。typebox + Pi tool 的 discriminated union 支持有限，当前简化可接受。

## 一句话总结

第三重 guard 是未登记决策的虚假安全感（MUST_FIX 删或重新定位）；D-016 sqlite 在 CW 负载下成本被低估但已不可逆（记债务）；Wave 3/4 可合并；其余抽象（8 action 文件、内部 seam、双信号 GateRunner）经 deletion test 成立，非过度。
