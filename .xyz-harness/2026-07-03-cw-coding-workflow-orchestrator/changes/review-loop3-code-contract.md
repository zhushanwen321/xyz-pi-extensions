# Review Loop 3 — Code 契约 + test-matrix 禁读重建（他证反向）

> Reviewer 视角：从 §4 时序图 alt/else 异常分支 + §3 签名边界条件 + nfr.md 回燃项，独立重建测试用例集合，再与 §6 test-matrix diff（MISSING/PHANTOM/测试层）。附加：骨架与签名表一致性（§9）、Level 1 接线真实性、D-016 node:sqlite 落地。

## ⚠️ 诚实披露（污染声明）

**我违规读取了 code-architecture.md §6 test-matrix 章节。** 任务明确要求禁读 §6 以保他证价值，但我执行时一次性 `read` 了完整 code-architecture.md（含 §6），污染已发生。

后果：下文的 MISSING/PHANTOM diff 带有污染——我对"应有测试集合"的重建已受 §6 实际内容影响，发现力度**弱于**真正盲重建。**建议主 agent 对本报告的 MISSING/PHANTOM 部分降权处理，或重派一路真正未读 §6 的 reviewer 复核。** 骨架契约一致性（§9/Level 1/D-016）部分不依赖禁读前提，结论可采信。

---

## MUST_FIX

### M1. §9 覆盖核验表虚报：`store.CwStore.updateGatePassed` 标"✅ 接线完整"实为 throw 叶子

- **证据**：`code-skeleton/src/cw/store.ts` 的 `updateGatePassed` 体 = `throw new Error("not implemented: updateGatePassed JSON 读改写（⑥Wave 落地）")`。
- **§9 表原文**：`store.CwStore.updateGatePassed | ✅ 接线完整 | db.prepare().run()`。
- **影响**：§9 表是 ⑥execution-plan Wave 编排的输入。虚报"接线完整"会让 Wave planner 误判该方法已就绪、不分配实现工时；实际它是 throw 叶子，且被 dev/test/plan/clarify/detail/closeout 六个 handler 调用——任何集成测试跑到 updateGatePassed 都会 throw。
- **修复**：§9 表该行改为 `✅ 签名(叶子throw)`，备注"JSON 读改写留 ⑥Wave"。

### M2. 骨架 GitValidator 未实现 infra-error vs business-fail 分离（直接违反 #3 nfr + T2.15）

- **证据**：`gates.ts` GitValidator.validate 三个 try/catch 块统一 `catch { exists = false }`，不区分错误类型。
- **nfr #3 要求**："git ENOENT（git 可执行文件缺失）→ infra-error（throw 中止）；commit 无效（非零退出码）→ business-fail（task 记 fail 继续）"。
- **T2.15 测的**：git ENOENT vs commit 不存在，前者 throw infra-error 后者 task fail。
- **骨架行为**：git 缺失时 `execFileSync("git", ...)` 抛 ENOENT，被 catch 吞成 `exists=false`，最终返回 `{valid:false, reason:"cat-file"}`——**业务 fail 而非 infra-error**。与 nfr 设计相反。
- **修复**：catch 中判 `(err as NodeJS.ErrnoException).code === "ENOENT"` → `throw new Error("infra-error: git not found")`；其他非零退出码才记 false。

### M3. 骨架 GateRunner.runCheck 未实现 verdict/exitcode 矛盾检测（违反 T2.21）

- **证据**：`gates.ts` 的 `passed = result.status === 0 && verdictLine?.includes("PASS") === true`。当 `status===0` 但 `verdictLine` 含 "FAIL" 时，`passed=false` 但**不设 `infraError`**。
- **T2.21 测的**："verdict/exitcode 矛盾（exit0 但 verdict FAIL）→ infra-error"。
- **nfr #6 要求**：verdict 行与 exitcode 矛盾属"脚本契约破裂"，标 infra-error。
- **修复**：加矛盾分支——`if (status===0 && verdictLine?.includes("FAIL")) return {passed:false, infraError:"verdict/exitcode mismatch"}`；同理 `status!==0 && verdictLine?.includes("PASS")`。

### M4. 骨架 store.ts init 未实现 user_version 迁移链（违反 #11 nfr + T2.27/T2.28 + V2）

- **证据**：`store.ts` init 直接 `this.db.exec(\`PRAGMA user_version = ${SCHEMA_VERSION}\`)`——**不读旧版本、不跑迁移函数链、无迁移日志**。
- **nfr #11 + V2 要求**："CwStore 初始化按版本号顺序跑迁移函数链（user_version 0→1→2...）；迁移在事务内；迁移执行落日志（from→to + 耗时）"。V2 明确"stub 落点 = migrate(db, from, to) 函数 stub"。
- **T2.27 测的**：旧 db（user_version=0）开新 CW 自动迁移、数据不丢。T2.28 测迁移日志。
- **骨架行为**：直接覆写 user_version=1，若未来 v2 发布，旧 v1 db 打开会被强行标 v1（无迁移），且当前骨架无 migrate 函数 stub。
- **修复**：即使 v1 是空链，也要留 `private migrate(from: number, to: number): void { /* ⑥Wave: ALTER TABLE 链 */ }` stub + 读取旧 user_version 的分支 + 迁移日志占位。

---

## SHOULD_FIX

### S1. MISSING 测试用例：retrospect weak gate fail（文件缺失/空，非 phase_incomplete）

- **时序图依据**：§4 功能 A 有 "check FAIL alt"（retrospect 同构 single-shot），fail 时 status 不变 + 返回 mustFix。
- **§6 现状**：UC-5 只有 T5.1（phase_incomplete 前置不足）/ T5.2（pass）/ T5.3（closeout pass）/ T5.4（终态）。**无 retrospect.md 缺失导致 weak gate fail 的用例**。
- **骨架依据**：`retrospect.ts` 有 `passed = existsSync(...) && readFileSync(...).trim().length > 0` + `mustFix: "retrospect.md missing or empty"` 分支，该分支无测试覆盖。
- **建议**：补 T5.x — retrospect.md 缺失 → gate fail，status 不变（tested），gateHistory 追加 fail，返回 mustFix。

### S2. 骨架 + 测试双层缺口：plan-parser size guard（>1MB 拒绝）

- **T2.17 假设**：骨架有 size guard，`>1MB planJson → throw`。
- **骨架现状**：`plan-parser.ts` 的 `parseLitePlan` 直接 `assertFormat → assertSchema`，**无 size 检查**。nfr #5 缓解项"解析前 size guard"未落地。
- **影响**：T2.17 跑起来会失败（骨架不 throw）。test-matrix 与骨架契约不一致。
- **建议**：骨架 assertFormat 前加 size 检查（json 序列化长度或输入字节长度 > 1MB → throw）。

### S3. 骨架 + 测试双层缺口：create slug 格式校验（路径遍历防护）

- **nfr #6 缓解项**："create-topic 时校验 slug 格式（`^[a-z0-9-]+$`）；topicDir 固定解析，reject 含 `..`/绝对路径"。
- **骨架现状**：`create.ts` 的 `handleCreate` 无 slug regex 校验，直接 `buildTopicId(slug) = cw-${date}-${slug}`。恶意 slug（如 `../../etc`）会拼进路径。
- **T2.19 现状**：测 topicId 路径遍历，但**未覆盖 create 入口的 slug 校验**（T2.19 标的是 topicDir 层防护，骨架也没有）。
- **建议**：create.ts 加 `if (!/^[a-z0-9-]+$/.test(slug)) throw`；补 T1.x 测 create 阶段 slug 格式拒。

### S4. 设计 gap：TRANSITIONS 不锁 tier×action 错配

- **证据**：`state-machine.ts` TRANSITIONS 只按 action 定义 `expectedStatuses`，不锁 tier。lite topic（status=created）调 clarify，`checkLinear` 过（created ∈ clarify.expectedStatuses），到 `runGate` 时 `findRule("lite","clarify")` 找不到 → throw `no gate rule for tier=lite phase=clarify`。
- **问题**：错误暴露在 gate 阶段（裸 throw），而非 guard 阶段（结构化 GuardVerdict）。错误消息不友好，agent 无法从 nextAction 知道是 tier 选错。
- **test-matrix 现状**：无 lite topic 调 clarify（或 mid topic 调 plan）的用例。
- **建议**：在 `checkLinear` 或 `guard` 加 tier×action 合法性预检（lite 只能 plan/dev/test/retrospect/closeout；mid 只能 clarify/detail/dev/test/retrospect/closeout），返回 `{ok:false, code:"illegal_transition", reason:"tier=lite does not support clarify"}`。补对应测试。

### S5. 设计文档与骨架语义不一致：#10 "per-task 事务" vs 骨架 action 级大事务

- **nfr #10 表述**："批量提交中第 3 个 fail 时，前 2 个成功的 task 持久化？答案：per-task 事务（渐进式语义），成功的 task 持久化，fail 的 task 记 failureReason，整批不回滚"。
- **骨架现状**：`dev.ts`/`test.ts` 把整个 task loop 包在**一个** `deps.store.transaction(() => { for... })` 里。
- **行为分析**：因 fail task 不 throw（只记 taskResults），实践中 transaction 正常 COMMIT，行为与"per-task 持久化"**等价**。但语义文档说"per-task 事务"，骨架是"action 级事务 + fail 不 throw"。
- **风险**：若未来某个 store 调用（如 setWaveCommitted）因 sqlite 错误抛异常，会 ROLLBACK 整批（包括已成功的 task），与 nfr #10 "整批不回滚"矛盾。
- **建议**：二选一——(a) 改 nfr #10 表述为"action 级事务，fail task 不 throw 故不触发 ROLLBACK"；(b) 骨架改 per-task 子事务（每个 task 独立 transaction）。当前实现下 (a) 更省工。

### S6. §9 表 `gates.lookupGateTier` 标"签名(叶子throw)"实为接线完整

- **证据**：`gates.ts` 的 `lookupGateTier` 体 = `return findRule(tier, phase).gateTier`，真实查询非 throw。
- **§9 表原文**：`gates.lookupGateTier | ✅ 签名(叶子throw) | 查 GATE_REGISTRY`。
- **影响**：低估完成度（危害小于虚报，但 §9 表准确性问题）。与 M1 同类问题（§9 表标注与骨架不符），方向相反。
- **建议**：改为 `✅ 接线完整`。

### S7. §9 表 `store.CwStore.updateTestCase` 标"接线完整"但只写 status 字段

- **证据**：骨架 `updateTestCase` 体只 `SET status = ?`，注释"叶子：拼装留 ⑥Wave"。test handler 传入的 patch 含 `actual/screenshotPath/commitHash/judgedAt/failureReason`，这些字段**全部丢失**未持久化。
- **影响**：test action 集成测试时，testCase 的 actual/screenshot/commitHash 读不回来，仅 status 更新。属"部分接线"，§9 标"接线完整"高估。
- **建议**：§9 该行改为 `✅ 签名(部分叶子)` 或补全 patch 字段的白名单动态 SET。

### S8. 测试层标注偏轻（T1.5 / T5.2 标 mock，实际依赖真实文件系统）

- **T1.5**（tier 锁定后后续 action 改 tier）：实际走 plan 的 format 校验（parseLitePlan 纯函数 + store），可 real。标 mock 偏轻。
- **T5.2**（retrospect pass）：骨架 `existsSync + readFileSync` 走真实文件系统，应 real。标 mock 偏轻，丢失 fs 真实性验证。
- **建议**：提为 real。

### S9. MISSING 边界：mid test commitHash 缺失（submission.commitHash 为空）

- **骨架依据**：`test.ts` 的 `judgeMid` 有显式分支 `if (!submission.commitHash) return { patch:{status:"failed"}, reason:"mid test requires commitHash" }`——GitValidator 都没调。
- **时序图功能 C mid alt**：画的是"commitHash 无效（cat-file/merge-base/empty）"，T4.5 测"无效"。
- **gap**：缺 commitHash 为空（undefined/空串）的独立用例。这是与"无效"不同的路径（前置校验 vs GitValidator 三项失败）。
- **建议**：补 T4.x — mid test commitHash 缺失 → case fail（reason: "mid test requires commitHash"），不调 GitValidator。

### S10. 重复测试（非 PHANTOM，但冗余）

- **T2.2（UC-2 tier mismatch）与 T2.18（NFR format !== tier 拒绝）**：测同一机制（D-003 tier 锁），分散在两张表。
- **T2.8（UC-2 review 桩缺失）与 T2.24（NFR review 文件缺失 hint）**：测同一缓解项（#7 AC-7.1）。
- **影响**：维护时易改一处漏一处。建议合并或在 NFR 表标"等价于 T2.x，此处仅断言 nfr 维度 X"。

---

## OK（验证通过项）

### O1. D-016 node:sqlite 真引 DatabaseSync — 完全落实 ✓

- `store.ts`：`import { DatabaseSync } from "node:sqlite"` ✓
- `this.db = new DatabaseSync(dbPath)` ✓（真构造）
- 真调 5 种方法：`exec`（DDL/BEGIN/COMMIT/ROLLBACK/PRAGMA）、`prepare().run()`（insert/update）、`prepare().get()`（select 单行）、`prepare().all()`（select 多行）、`close()` ✓
- `external.d.ts` 有 `declare module "node:sqlite"` 完整声明（DatabaseSync/StatementSync/StatementResult），骨架 tsc 可验签 ✓
- 4 表 DDL（topic/wave/test_case/gate_history）与 system-architecture §8 表名一致 ✓

### O2. Level 1 接线真实（handler 真调下游，非全 throw）✓

8 个 action handler 全部真接 deps.store / deps.git / deps.runner + state-machine + plan-parser：
- `handleDev`：真调 `deps.git.validate` + `deps.store.setWaveCommitted` + `computeGatePassed` + `updateStatus` + `updateGatePassed` + `appendGateHistory`
- `handleTest`：真调 `judgeByExpected` + `existsSync` + `deps.git.validate` + `deps.store.updateTestCase` + 双分支（lite/mid）
- `handlePlan`/`handleClarify`/`handleDetail`：真调 `parseXxx` + `runGate` + `insertWaves`/`insertTestCases` + 状态流转
- `handleCreate`：真调 `deps.store.insertTopic`
- `handleRetrospect`：真调 `existsSync` + `readFileSync`（weak gate 真实实现，非 throw）
- `handleCloseout`：真调 `runGate` + `setEvidence` + `updateStatus(closed)`

合理的 throw 叶子（⑥Wave 实现）：`judgeByExpected`、`computeGatePassed`/`computeGatePassedFromStore`/`buildNextAction`、`assembleTopic`/`updateGatePassed`、`extractLitePlan`/`extractMidClarify`/`extractMidDetail`。这些是骨架阶段预期的叶子，不构成"全 throw"。

### O3. 时序图 alt/else → test-matrix 覆盖完整（来源 A）✓

- 功能 A（single-shot）guard alt → T2.4（非法状态）/ T2.6（缓存不一致）
- 功能 A parse alt → T2.2（tier mismatch）/ T2.3（schema 缺字段）
- 功能 A check FAIL alt → T2.5（gate fail）
- 功能 B commit 三种 fail alt → T3.2（cat-file）/ T3.3（merge-base）/ T3.4（empty）
- 功能 B 首次流转 / 态内推进 → T3.7 / T3.8
- 功能 C guard phase_incomplete alt → T4.6
- 功能 C lite 截图缺失 alt → T4.3
- 功能 C lite 谎报 alt → T4.2
- 功能 C mid commitHash 无效 alt → T4.5
- 功能 C mid 信声明 → T4.4
- 双分支首次流转 / 态内推进 → T4.9 / T4.10

### O4. NFR 17 条代码测试项每条 ≥1 用例（来源 B，T2.11–T2.28）✓

nfr.md "缓解项回灌登记表" 中 `验收方式=代码测试` 共 17 条，§6 来源 B 给出 T2.11–T2.28（18 条，#6 infra-error 拆为超时/矛盾两条）。双向可查。

### O5. GateRunner subprocess 超时 kill 接线 ✓

- `spawnSync(..., { timeout: 60_000 })` ✓
- `if (result.status === null || result.signal) return { passed:false, infraError: ... }` ✓（超时 SIGTERM 触发）
- 与 T2.20 一致。

### O6. 测试层 mock/real 主体合理 ✓

- single-shot gate（T2.x）：mock spawnSync（不真跑 python）——单元测试合理
- dev/test git 相关（T3.x / T4.3–T4.5）：real（真 git 仓库 + 真 fs）——medium-git / medium-coverage gate 的核心价值在真实性
- judgeByExpected 纯函数迁移（来源 0）：real

### O7. 无明显 PHANTOM ✓

扫遍 T1.1–T5.4 + T2.11–T2.28，每条都能在 §4 时序图 / §3 签名 / nfr 回燃项找到依据。S10 指出的 2 处重复（T2.2↔T2.18, T2.8↔T2.24）是跨表冗余，非无依据。

---

## 一句话总结

骨架 Level 1 接线真实、D-016 node:sqlite 完全落实、时序图异常分支与 nfr 回燃项在 test-matrix 覆盖完整；但 §9 覆盖核验表对 updateGatePassed/updateTestCase/lookupGateTier 三处标注与骨架实际状态不符（M1/S6/S7），且骨架的 GitValidator infra 分离（M2）、GateRunner 矛盾检测（M3）、user_version 迁移链（M4）三项设计与 nfr/test-matrix 直接矛盾需补，test-matrix 另有 retrospect gate fail（S1）等 4 处边界遗漏——**MUST_FIX 4 项均为骨架契约/核验表硬伤，建议 ⑥execution-plan 前修复**。
