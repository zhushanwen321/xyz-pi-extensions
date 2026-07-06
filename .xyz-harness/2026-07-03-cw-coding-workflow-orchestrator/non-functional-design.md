---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — CW (Coding Workflow Orchestrator)

> 沿副作用分析树逐 issue × 7 维度展开。D-016 已把存储层从「文件 tmp+rename」改为「node:sqlite + 关系表」，
> 数据完整性维度的原子性/崩溃恢复归 sqlite 天生（事务原子性已实测：崩溃事务不污染），本维度风险谱相应下移；
> 并发维度的新不确定性（DatabaseSync 同步 API 的多 session 连接管理）标记为需⑤骨架验证。

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 CwStore node:sqlite DAO | 方案A 手写 DAO | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| #2 状态机 guard 组织 | 方案A 声明式转换表 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| #3 GitValidator 失败语义 | 方案A 逐条容错 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #4 gate 注册表编码 | 方案A 声明式数组 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #5 plan-parser JSON 校验 | 方案A typebox Value.Assert | ⚠️ | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| #6 GateRunner subprocess 错误 | 方案A stdout+exitcode | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| #7 review 桩跨 skill 契约 | 方案A 预检+hint | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| #8 test-orch 内化回归 | 方案A 迁移核心用例 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #9 nextAction 数据结构 | 扁平结构 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #10 渐进入参数组统一 | 内部循环 | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #11 schemaVersion 演进 | user_version 迁移 | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |

（✅ 无风险 / ⚠️ 有风险已缓解；矩阵无不可接受档位——所有方案在 issues.md 已定稿，NFR 无回退信号）

## 详细分析

> 写量规则：✅ 维度只给一行理由；⚠️ 维度按 4 字段展开。

### #1: CwStore node:sqlite DAO + 事务 — 方案 A

#### ⚠️ 安全
- **风险**: agent 输入的 slug / topicId / commitHash / JSON 字段进入 SQL，若 DAO 用字符串拼接则有 SQL 注入面。
- **影响范围**: 所有写库的 action handler（create/dev/test/...）。
- **缓解方案**: node:sqlite 的 `DatabaseSync.prepare(sql).bind(...args)` 全量参数化，禁止字符串拼接 SQL；DAO 层 lint 规则禁 `.exec("INSERT ... " + x)` 模式。
- **残余风险**: 0（参数化是 sqlite 标准能力，无残余）。

#### ⚠️ 数据完整性
- **事务边界**: 每个 action handler 的多表写（如 dev 提交更新 wave 表 + 追加 gate_history 表）必须在同一 `BEGIN/COMMIT/ROLLBACK` 事务内。
- **并发场景**: 单 agent 串行（见并发维度）。
- **迁移方案**: D-016 后由 sqlite PRAGMA `user_version` + ALTER TABLE 承担（关联 #11），不再 JSON deserialize 补默认。
- **回滚策略**: 事务中任一语句抛错 → ROLLBACK，`_cw.db` 不变（D-016 已实测：崩溃事务不污染）。原子性从「自实现 tmp+rename」下沉为 sqlite 天生，风险显著降低。

#### ✅ 性能
CW 负载极低（单 agent 串行，每 topic 一个 db 文件，单 action 几条 SQL），sqlite 事务开销远非瓶颈，无需索引/缓存优化。

#### ⚠️ 并发控制（标记需⑤骨架验证）
- **竞态场景**: 同一 Pi 进程多 session 同时操作同一 topic 的 `_cw.db`（迷雾 #14 未展开，当前假设单 agent 串行）。node:sqlite `DatabaseSync` 是同步 API，同进程多连接的文件锁行为、WAL 模式可用性、`busy_timeout` 重试语义需在骨架验证。
- **幂等策略**: 状态机 guard（#2）天然幂等——非法转换直接 throw，重复请求不产生副作用。
- **锁策略**: 无显式锁，依赖 sqlite WAL + BUSY 重试（比原文件方案 tmp+rename 的「A 读→B 读→A 写→B 写」逻辑覆盖更可控）。跨进程竞争靠 BUSY 重试吸收；同进程同步 API（DatabaseSync）多连接竞争需串行化（per-topic 单连接），否则同步阻塞调用栈可能死锁——V1 骨架验证哪条路径成立。
- **分布式考虑**: N/A（单进程内）。

#### ✅ 稳定性
sqlite 崩溃恢复天生（事务原子性 + WAL），disk-full / IO 错误 sqlite 自处理并以 throw 上报，CW 转 infra-error 即可。

#### ⚠️ 兼容性
- **API 变更**: node:sqlite 在 Node 24 为 experimental（Stability 1.1），Node 25.7 RC。API 签名可能变。
- **数据兼容**: 见 #11 迁移。
- **客户端影响**: node:sqlite 三层版本边界：Node < 22.5 不可用；22.5-23.3 需 `--experimental-sqlite` flag（README 文档提示用户开 flag）；≥ 23.4 免 flag。除 `engines.node` 锁 ≥ 22.5 外，README 与加载时 catch 块对 flag 缺失给明确错误提示（区分「版本不够」与「flag 未开」）。
- **灰度/回滚**: CW 仅用 SQL 标准（CREATE TABLE / INSERT / BEGIN / SELECT），不依赖 experimental 语法糖，API 变更对 CW 用法影响可控；`package.json` 的 `engines.node` 声明最低版本。

#### ⚠️ 可观测性
- **日志**: 事务 COMMIT/ROLLBACK 落结构化日志含 topicId + action + 耗时。
- **指标/追踪/告警/审计**: gate_history 表是天生审计表（sqlite3 CLI 可查），不需额外指标。

### #2: 状态机 guard 组织 — 方案 A

#### ✅ 安全 / ✅ 数据 / ✅ 性能 / ✅ 并发 / ✅ 稳定 / ✅ 兼容
guard 是纯内存无状态只读函数：入参已由 typebox schema 在 tool 接口层校验；guard throw 在任何写之前；内存转换表查询；无外部依赖；内部规则。无副作用。

#### ⚠️ 可观测性
- **日志**: guard throw 须区分两类语义——`illegal state transition`（状态机线性违例）vs `previous phase incomplete`（跨阶段级联未满足），错误码/消息分离让 agent 知道是"调错 action"还是"上阶段没跑完"。
- **告警**: 无（agent 自处理）。

### #3: GitValidator 失败语义 — 方案 A

#### ✅ 安全 / ✅ 数据 / ✅ 性能 / ✅ 并发 / ✅ 兼容
execFileSync 无 shell 注入面（args 直传 argv，不经 shell 解释）；只读 git 不直写 `_cw.db`（失败结果经 store 事务记录）；本地 git 命令快；只读无共享态；git CLI 签名稳定。

#### ⚠️ 稳定性
- **故障场景**: git 可执行文件缺失（ENOENT）/ 仓库损坏 / 非零退出码。需区分「commit 无效（业务 fail，该 task 记 fail 继续）」vs「git 基础设施不可用（infra-error，throw 中止 action）」。
- **降级方案**: 不降级——infra-error 直接 throw 让 agent 知道是环境问题。
- **熔断/限流**: N/A。
- **重试策略**: 不重试（git 本地调用确定性，重试无意义）。
- **SLA 影响**: 无。

#### ⚠️ 可观测性
- **日志**: fail 的 task/case 须在返回的 nextAction 明确列出（failureReason 含具体哪项校验挂了：cat-file 不存在 / merge-base 不属仓库 / diff-tree 空 commit）。
- **审计**: gate_history 记录 fail 项。

### #4: gate 注册表编码 — 方案 A

#### ✅ 全维度无风险
内部声明式配置 + 通用执行器：纯内存只读注册表；gate_history 在 #1 事务内追加；fail-fast 是纯逻辑。无外部边界、无副作用、无可观测新增需求（gate_history 表已是审计载体）。

### #5: plan-parser JSON 校验 — 方案 A

#### ⚠️ 安全
- **风险**: agent 可喂任意/超大/深嵌套 JSON 给 plan/clarify/detail action，恶意 100MB JSON 撑爆内存或深嵌套爆栈。
- **影响范围**: plan/clarify/detail 三个 handler。
- **缓解方案**: 解析前 size guard（reject > 1MB，CW 交付物 JSON 体积可控）；typebox Value.Assert 校验 schema；禁用 `JSON.parse` 递归深度异常的输入。
- **残余风险**: 0。

#### ⚠️ 数据完整性
- **事务边界**: N/A（解析无写）。
- **并发场景**: N/A。
- **迁移方案**: N/A。
- **回滚策略**: format 字段 !== topic.tier 时 throw（D-003 tier 锁定），解析失败不写库，状态不变。

#### ⚠️ 性能
- **预期负载**: 单次解析，体积小。
- **关键路径延迟**: 超大 JSON 解析是唯一延迟点，size guard 缓解（与安全同因同缓解）。
- **扩展性瓶颈**: 无。
- **优化方案**: size guard 提前拒绝。

#### ✅ 并发 / ✅ 稳定 / ✅ 兼容 / ✅ 可观测
无状态纯函数；typebox Value.Assert 是纯校验；内部 schema；校验错误消息明确（哪个字段缺/类型错）。

### #6: GateRunner subprocess 错误处理 — 方案 A

#### ⚠️ 安全
- **风险**: topicId/topicDir 是 agent 输入，若含路径遍历（`../`）可能把 check 脚本指向 `.xyz-harness/` 之外的目录。
- **影响范围**: 所有调 check_*.py 的 gate（plan/clarify/detail/closeout）。
- **缓解方案**: create-topic 时校验 slug 格式（`^[a-z0-9-]+$`）；topicDir 固定解析为 `.xyz-harness/<slug>` 下，reject 含 `..`/绝对路径的输入。
- **残余风险**: 0。

#### ✅ 数据
subprocess 是只读检查（check_*.py 读文件产报告，不写 `_cw.db`），写库仍由 CW handler 在事务内做。

#### ⚠️ 性能
- **预期负载**: 每次 gate 一次 spawn。
- **关键路径延迟**: python 启动 ~100ms + 脚本执行，可接受；超时控制必备。
- **优化方案**: 设 subprocess 超时（如 60s），超时 kill 标 infra-error。

#### ✅ 并发
每次 gate 独立 subprocess，无共享态。

#### ⚠️ 稳定性
- **故障场景**: (1) python 缺失（ENOENT）；(2) 脚本 crash；(3) 超时；(4) verdict 行与 exitcode 矛盾。前三种是 infra-error（throw 中止），第四种也标 infra-error（脚本契约破裂）。
- **降级方案**: 不降级。
- **重试策略**: 不重试。
- **SLA 影响**: 无。

#### ⚠️ 兼容性
- **API 变更**: GateRunner 依赖 check_*.py 的 stdout verdict 行格式（`[check] machine check: N/N passed → PASS/FAIL`）。脚本格式变则解析断。
- **数据兼容**: N/A。
- **客户端影响**: check 脚本与 CW 同仓（`extensions/coding-workflow/scripts/`），版本天然耦合，无跨仓客户端。
- **灰度/回滚**: 解析器对 verdict 行的契约测试 pin 住格式；脚本改格式须同步改解析器。

#### ⚠️ 可观测性
- **日志**: infra-error vs business-fail 在 gate_history 的 result/report 字段可区分（infra 标 `infra-error`，business 标 `fail` + report）。
- **审计**: gate_history。

### #7: review 桩跨 skill 契约 — 方案 A

#### ✅ 安全 / ✅ 数据 / ✅ 性能 / ✅ 并发
文件存在性 stat；不写；快；只读。

#### ⚠️ 稳定性
- **故障场景**: skill 改造（D-007-REVISIT）未完成或 review-fix-loop 未跑 → check_*.py 因缺 review 文件 fail，agent 困惑（不知是设计问题还是文件缺失）。
- **降级方案**: CW 预检 review 文件缺失时返回结构化 hint（"review 文件缺失，请先跑 skill 阶段的 review-fix-loop"），非裸 check 报错。
- **重试策略**: N/A。
- **SLA 影响**: 无。

#### ⚠️ 兼容性
- **API 变更**: CW ↔ skill 跨组件契约——CW 不产 review 文件，依赖 skill 改造批次（D-007-REVISIT）产。两者必须同批发布。
- **数据兼容**: N/A。
- **客户端影响**: 旧 skill（未改造）+ 新 CW → mid clarify/detail gate 必 fail（hint 引导）。
- **灰度/回滚**: CW 与 skill 收口改造同 PR/同 changeset 发布。

#### ✅ 可观测性
hint 本身就是可观测载体（明确告知缺什么文件、下一步做什么）。

### #8: test-orchestrator 内化回归 — 方案 A

#### ✅ 安全 / ✅ 数据 / ✅ 性能 / ✅ 并发 / ✅ 稳定 / ✅ 可观测
judgeByExpected 是纯函数迁移（输入格式无关，expected 是结构化对象），等价性由迁移的测试用例保障；无外部依赖；无并发；纯函数稳定；测试覆盖即观测。

#### ⚠️ 兼容性
- **API 变更**: 删 `src/test-orchestrator/` 整个目录 + `registerTestOrchestratorTool`。需确认全 repo 无外部 import / 无其他扩展 peerDeps 引用。
- **数据兼容**: N/A（test-orch 的 session 数据是运行时内存，无持久化迁移）。
- **客户端影响**: 若有第三方扩展 import test-orchestrator 模块，删除后其 import 断。
- **灰度/回滚**: 删除前 grep 全仓 `test-orchestrator` 引用清单，确认零外部消费方；changeset 标 breaking。

### #9: nextAction 数据结构 — 扁平结构

#### ✅ 全维度无风险
内部返回值数据结构：纯序列化字段（action/skill/guidance/waves/testCases），无 IO、无并发、无外部边界。guidance 字段本身就是可观测性载体。无可观测新增需求。

### #10: 渐进入参数组统一 — 内部循环

#### ✅ 安全 / ✅ 性能 / ✅ 并发 / ✅ 稳定 / ✅ 兼容 / ✅ 可观测
内部循环处理数组，无新外部边界；循环开销可忽略；无共享态；纯逻辑；内部；progress 字段透传。

#### ⚠️ 数据完整性
- **事务边界**: action 级事务包裹整个 task 循环；fail task 不 throw 只记 failureReason，故不触发 ROLLBACK，已成功 task 持久化（等价 per-task 语义，D-005 渐进式）。注：若 store 调用因 sqlite 错误抛异常则整批 ROLLBACK（含已成功 task），这是可接受的——sqlite 错误属基础设施故障非业务 fail。
- **并发场景**: N/A。
- **迁移方案**: N/A。
- **回滚策略**: 单 task 失败不回滚其他 task（与 #3 GitValidator 逐条容错语义一致）。

### #11: schemaVersion 演进 — user_version 迁移

#### ✅ 安全 / ✅ 性能 / ✅ 并发
迁移函数是 CW 内部 DDL，无外部输入；一次性 init 迁移开销可忽略；init 时单连接无并发。

#### ⚠️ 数据完整性
- **事务边界**: ALTER TABLE 迁移须在事务内，失败 ROLLBACK 保留原 schema 数据。
- **并发场景**: N/A（init 时）。
- **迁移方案**: `PRAGMA user_version` 记录版本，CwStore 初始化按版本号顺序跑迁移函数链（user_version 0→1→2...）。
- **回滚策略**: 迁移失败 → 事务 ROLLBACK，db schema 不变；`.xyz-harness/` 受 git 追踪，灾难回滚 = `git checkout` 旧 db（D-016 审计特性）。

#### ⚠️ 稳定性
- **故障场景**: 迁移函数 bug 留下半迁移 db（user_version 改了但 ALTER 没全跑完）。
- **降级方案**: 不降级。
- **重试策略**: 迁移在单事务内，要么全成要么全败，无需重试。
- **SLA 影响**: 无。

#### ⚠️ 兼容性
- **API 变更**: 旧 `_cw.db`（user_version 0）被新 CW（期望 1）打开 → 自动向前迁移。无降级路径（新 db 用新 schema，旧 CW 打不开）。
- **数据兼容**: 向前兼容（旧→新自动迁移），不向后兼容（新→旧需 git checkout 旧 db）。
- **客户端影响**: 用户跨 CW 版本切换时，降级靠 git。
- **灰度/回滚**: git 追踪 `.xyz-harness/` 是回滚兜底（运维流程文档化）。

#### ⚠️ 可观测性
- **日志**: 迁移执行落日志（from version → to version + 耗时），让用户知道 db 被迁移过。
- **审计**: gate_history 不涉及；迁移日志是独立观测面。

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解标「验收方式」：代码测试 = 进⑤test-matrix「NFR 风险→用例映射表」；骨架约束 = ⑤骨架 tsc gate 兜住存在性；性能混沌 = ⑥独立 perf/chaos Wave（不进⑤）；运维项 = 本表记录不进开发 issue。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|----------|------|
| SQL 全量参数化（bind ?，禁字符串拼接） | #1 | 安全 | ⑤代码架构 | store.ts DAO 层 + lint 规则 | 代码测试 | 待落 |
| 多表写事务边界（BEGIN/COMMIT/ROLLBACK） | #1 | 数据 | ⑤时序图 | 各 action handler 时序图标事务边界 | 代码测试 | 待落 |
| DatabaseSync 连接管理 + WAL + busy_timeout | #1 | 并发 | ⑤骨架 | store.ts 连接获取函数 stub | 骨架约束 | 待落 |
| package.json engines 声明 Node ≥22.5 | #1 | 兼容 | 运维项 | package.json engines 字段 | 运维项 | 待落 |
| 事务 COMMIT/ROLLBACK 结构化日志含 topicId | #1 | 可观测 | ⑤test-matrix | 日志断言 | 代码测试 | 待落 |
| guard 错误码区分 illegal-transition / phase-incomplete | #2 | 可观测 | ⑤test-matrix | 错误消息断言 | 代码测试 | 待落 |
| git ENOENT → infra-error 与业务 fail 分离 | #3 | 稳定 | ⑤test-matrix | infra vs business 断言 | 代码测试 | 待落 |
| nextAction 列出 fail 的 task/case + failureReason | #3 | 可观测 | ⑤test-matrix | 返回值断言 | 代码测试 | 待落 |
| JSON 解析前 size guard（reject >1MB） | #5 | 安全/性能 | ⑤test-matrix | 超大 JSON 被拒断言 | 代码测试 | 待落 |
| JSON.parse 深度限制（reject 嵌套 >N 层） | #5 | 安全/性能 | ⑤test-matrix | 深嵌套被拒断言 | 代码测试 | 待落 |
| format !== tier 拒绝（D-003 tier 锁） | #5 | 数据 | ⑤test-matrix | tier mismatch throw 断言 | 代码测试 | 待落 |
| typebox Value.Assert 在 Pi 运行时可用性 | #5 | 稳定 | ⑤骨架 | plan-parser.ts Assert stub | 骨架约束 | 待落 |
| topicId/topicDir 路径遍历校验 | #6 | 安全 | ⑤test-matrix | `..`/绝对路径被拒断言 | 代码测试 | 待落 |
| subprocess 超时 + kill | #6 | 性能 | ⑤test-matrix | 超时被 kill 断言 | 代码测试 | 待落 |
| verdict/exitcode 矛盾 + ENOENT + timeout → infra-error | #6 | 稳定 | ⑤test-matrix | 三种 infra 场景断言（矛盾/ENOENT/timeout），§6 T2.21 拆参数化 3 行 | 代码测试 | 待落 |
| check 脚本 verdict 行格式契约 pin | #6 | 兼容 | ⑤test-matrix | 格式契约测试 | 代码测试 | 待落 |
| infra-error vs business 在 gate_history 可区分 | #6 | 可观测 | ⑤test-matrix | gate_history 字段断言 | 代码测试 | 待落 |
| review 文件缺失预检 + 结构化 hint | #7 | 稳定 | ⑤test-matrix | hint 内容断言 | 代码测试 | 待落 |
| CW 与 skill 收口改造同批发布 | #7 | 兼容 | 运维项 | changeset/PR 协调 | 运维项 | 待落 |
| 删 test-orchestrator 前查无外部引用 | #8 | 兼容 | ⑤test-matrix | grep 零引用断言 | 代码测试 | 待落 |
| 批量渐进式 per-task 事务（部分成功持久化） | #10 | 数据 | ⑤test-matrix | 部分成功持久化断言 | 代码测试 | 待落 |
| user_version 迁移在事务内 + 数据保留 | #11 | 数据/稳定 | ⑤test-matrix | 迁移后数据完整断言 | 代码测试 | 待落 |
| ALTER TABLE 迁移事务可回滚性 | #11 | 稳定 | ⑤骨架 | store.ts migrate 函数 stub | 骨架约束 | 待落 |
| 旧 db 前向迁移 + git 回滚流程 | #11 | 兼容 | 运维项 | 运维文档 | 运维项 | 待落 |
| 迁移执行日志（from→to version） | #11 | 可观测 | ⑤test-matrix | 日志断言 | 代码测试 | 待落 |

> 注：#6 稳定性缓解项承诺三种 infra 场景断言（矛盾/ENOENT/timeout），当前 code-architecture §6 T2.21 只覆盖「矛盾」一种——nfr 承诺范围与 §6 兑现需对齐，交 code-arch 阶段把 T2.21 拆为参数化 3 行。

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| node:sqlite experimental API 在未来 Node 版本签名变更 | CW 存储层可能需调整 | Node 25.7 已 RC，CW 仅用 SQL 标准（CREATE/INSERT/BEGIN/SELECT），不依赖 experimental 语法糖；engines 锁版本 | 升级 Node 时跑 CW 集成测试 |
| 多 session 并发写同一 `_cw.db`（迷雾 #14） | 数据覆盖（理论） | 当前单 agent 串行假设，无并发证据；sqlite WAL+BUSY 比文件方案更可控；⑤骨架验证连接管理 | GUI 多窗口/多 agent 场景出现时加乐观锁 |
| CW ↔ skill 跨组件 review 文件契约 | mid clarify/detail gate 因 skill 未改造而 fail | hint 引导 + 同批发布协调 | changeset 同批 |

## 需⑤骨架验证的副作用（标记登记）

> 不确定性高的副作用不纯脑力推演，stub 方法进⑤骨架，结论回写本节。

### V1: node:sqlite DatabaseSync 多 session 连接管理 + WAL/BUSY（来源 #1 并发 / 迷雾 #14）
- **验证什么**: (1) 每次 action 打开 `DatabaseSync` 后关闭，是否泄漏文件句柄；(2) 同进程两个 session 同时打开同一 `_cw.db` 是否死锁/阻塞；(3) `PRAGMA journal_mode=WAL` 与 `PRAGMA busy_timeout=N` 在 node:sqlite 是否可设置且生效。
- **预期结论方向**: per-action open/close 简单可靠（CW 负载极低，无需连接池）；WAL+busy_timeout 可用，意外并发由 BUSY 重试吸收；若无 WAL 支持，降级为单连接串行（CW 串行假设下可接受）。
- **stub 落点**: `store.ts` 的 `openDb(topicDir)` + `withTransaction(db, fn)` 函数 stub，骨架 tsc 验证签名存在 + 调用链通。

### V2: ALTER TABLE 迁移在 sqlite 事务内的可回滚性（来源 #11 数据/稳定）
- **验证什么**: sqlite 的 ALTER TABLE 能否在 BEGIN/COMMIT/ROLLBACK 事务内运行，迁移函数中途抛错时 ROLLBACK 是否真的不留半迁移 schema。
- **预期结论方向**: sqlite DDL 是事务安全的（社区共识），ROLLBACK 撤销 ALTER；若个别 ALTER（如 RENAME COLUMN）有约束，迁移函数链拆细。
- **stub 落点**: `store.ts` 的 `migrate(db, fromVersion, toVersion)` 函数 stub + user_version PRAGMA 读写 stub。

### V3: typebox Value.Assert 在 Pi 运行时可用性（来源 #5 方案 A 前提）
- **验证什么**: Pi 运行时是否提供 `@sinclair/typebox/value` 的 Value.Assert/Value.Check（#5 方案 A 的运行时校验 API）。issues.md #5 已标注"前提：Pi 运行时提供 typebox/value，否则降级方案 B"。
- **预期结论方向**: 若可用 → 方案 A 落地；若不可用 → 降级方案 B（手写校验函数，3 套 schema 体量可接受）。
- **stub 落点**: `plan-parser.ts` 的 `assertLitePlan/AssertMidClarify/AssertMidDetail` 函数 stub，骨架验证 import 可解析。
