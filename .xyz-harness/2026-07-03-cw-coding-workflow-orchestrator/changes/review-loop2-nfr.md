---
verdict: pass
reviewer: review-fix-loop 第 2 路（nfr 副作用 + 回燃指针）
cognitive_frame: 对齐（正向）
upstream_reviewed: non-functional-design.md
cross_checked: code-architecture.md §6 来源 B / decisions.md D-016 / issues.md #1-#11
---

# NFR Review — 副作用 + 回燃指针（第 2 路）

## verdict: pass（5 SHOULD_FIX，0 MUST_FIX）

NFR 文档整体质量高：11 issue × 7 维度全覆盖；18 条代码测试缓解项全部回燃到 code-architecture §6 来源 B（T2.11~T2.28），无 PHANTOM 指针；D-016 node:sqlite 三维度（数据/并发/兼容）核心风险都分析且不确定性诚实标注（V1/V2/V3 骨架验证 + 残余风险表 3 条）；24 条缓解方案均具体可执行，无「加强检查」空话。问题集中在「承诺范围与下游兑现的精度差」与「D-016 同步 API 的并发语义辨析」，均不阻塞。

---

## SHOULD_FIX

### S1. nfr#14「三种 infra 场景」承诺与 §6 T2.21 单一场景覆盖有 GAP
- **位置**: 缓解表行「verdict/exitcode 矛盾 + ENOENT + timeout → infra-error」（#6 稳定），对应 code-architecture §6 来源 B T2.21。
- **原因**: nfr 项明确「三种 infra 场景断言」（矛盾 / ENOENT / timeout），但 §6 T2.21 只断言了「exit0 但 verdict FAIL」（矛盾）一种。timeout 被 T2.20（超时 kill）顺带覆盖，**ENOENT 场景（python 缺失）完全缺独立用例**。三种场景的代码出口相同（都 throw infraError），但 nfr 既承诺「三种」就应兑现，否则指针声明的验收范围是部分 PHANTOM。
- **建议**: T2.21 拆为参数化用例（3 行输入：矛盾 / ENOENT / timeout → 同一 infra-error 出口），或在 §6 来源 B 新增 T2.21b 专测 ENOENT。nfr 侧无需改，问题在 §6 兑现端（交 code-arch reviewer 跟进；本 review 仅记指针 GAP）。

### S2. D-016 并发维度：同步 API 死锁 vs BUSY 重试未辨析
- **位置**: #1 并发控制章节「锁策略: 无显式锁，依赖 sqlite WAL + BUSY 重试」。
- **原因**: node:sqlite `DatabaseSync` 是**同步阻塞** API。sqlite 的 BUSY 重试机制解决的是**跨进程**文件锁竞争；而同进程多 session 的连接竞争，在同步阻塞调用栈下可能形成**死锁**（两个连接在各自同步栈里互相等待），不是 BUSY 回调能吸收的。当前描述把两者混在「WAL + BUSY 重试」，低估了同进程并发风险。V1 骨架验证虽登记了「死锁/阻塞」待验，但分析层应先点明这个语义区分，让骨架验证有明确假设可证伪。
- **建议**: 并发维度「锁策略」字段补一句区分：「跨进程竞争靠 BUSY 重试；同进程同步 API 连接竞争需串行化（per-topic 单连接或连接池），否则有死锁风险——V1 骨架验证哪条路径成立」。

### S3. D-016 兼容性维度：node:sqlite import 的 flag 版本边界未完整说清
- **位置**: #1 兼容性章节「客户端影响: 用户 Node 版本 < 22.5 时 CW 无法加载」。
- **原因**: node:sqlite 的可用性边界比「22.5+」更细：v22.5 引入但需 `--experimental-sqlite` flag，**v23.4 才免 flag**，v25.7 RC。当前描述把 22.5-23.3 这段「能加载但需 flag」的区间略过了——用户在 Node 22.5-23.3 启动 Pi 若没传 flag，CW 会加载失败，错误信息可能不直观。`package.json engines.node` 锁 ≥22.5 并不能消除 flag 需求。
- **建议**: 兼容性「客户端影响」字段改为三层：「<22.5 不可用；22.5-23.3 需 `--experimental-sqlite` flag（文档提示用户）；≥23.4 免 flag」。engines 字段锁 ≥22.5 之外，README 或 catch 块给 flag 缺失的明确错误提示。

### S4. nfr#5 深嵌套 JSON 爆栈：分析提到但缓解表未单列
- **位置**: #5 安全章节提到「禁用 `JSON.parse` 递归深度异常的输入」；缓解表行「JSON 解析前 size guard（reject >1MB）」。
- **原因**: size guard 拒 >1MB 防的是内存撑爆，但**深嵌套 JSON 即使 <1MB 也能爆栈**（`JSON.parse` 递归深度）。分析层识别了这个风险，缓解表却只回燃了 size guard 一项，深嵌套防护没独立成条 → 下游 §6 T2.17 只测了「>1MB 被拒」，没测「深嵌套被拒」。这是分析层与缓解表的不一致。
- **建议**: 缓解表新增一行「JSON.parse 深度限制（reject 嵌套 >N 层）」，回燃 §6（与 T2.17 同源，可参数化扩展）。或在 size guard 行的「落地为」标注「size guard + 深度限制双检」。

### S5. nfr#2 安全维度：第三重 guard（缓存篡改）未在安全维度点出
- **位置**: #2 状态机 guard 的安全维度一行理由「入参已由 typebox schema 在 tool 接口层校验」。
- **原因**: D-009 引入的第三重 guard（`checkCacheConsistency`，防 `topic.gatePassed` 缓存字段被篡改）实质是**安全维度的内部状态篡改防护**。code-architecture §3 已落 `checkCacheConsistency` 方法，但 nfr#2 安全维度一行理由只提了「入参校验」（第一重 input validation），漏了「缓存篡改」（第三重）。这是 nfr 撰写时序早于第三重引入导致的时间差遗漏，但定稿应回填对齐。
- **建议**: #2 安全维度从一行拆为两句：「入参 typebox 校验（注入防护）+ 第三重 checkCacheConsistency 防缓存字段篡改（内部状态完整性）」。或维持一行但补「+ 缓存一致性 guard 防篡改」。

---

## OK（已验证达标项）

1. **7 维度全覆盖（任务 1）**: 11 个 issue（#1-#11）每个都覆盖了安全/数据/性能/并发/稳定/兼容/可观测 7 维。✅ 维度合并一行（如 #4「全维度无风险」、#9「全维度无风险」）合规——nfr-dimensions.md 明文「分析矩阵标 ✅ 的维度只写一行理由」。无「不适用未给理由」的维度。
2. **回燃指针无 PHANTOM（任务 2）**: nfr 缓解表 18 条「验收方式=代码测试」项，全部在 code-architecture §6 来源 B 有对应用例（T2.11~T2.28，18 条）。「来源 nfr 缓解项」列双向可查。唯一精度差见 S1（场景覆盖不全，非指针缺失）。
   - 注：§6 自检称「17 条 nfr 代码测试项」与实际 18 条不符（§6 计数错误，归 code-arch reviewer；nfr 侧计数正确）。
3. **D-016 三维度分析充分（任务 3）**:
   - **数据完整性**: 原子性下沉 sqlite 事务（BEGIN/COMMIT/ROLLBACK），崩溃不污染（D-016 实测），回滚策略清晰，迁移归 user_version。✅
   - **并发**: 迷雾 #14 单 agent 串行假设诚实标注，V1 骨架验证登记完整（见 S2 待加强辨析）。
   - **兼容**: experimental 风险登记在残余风险表，engines 锁版本 + SQL 标准用法 + 升级跑集成测试的监控方式齐全（见 S3 待补 flag 边界）。
4. **缓解方案具体性（任务 4）**: 24 条缓解项全部具体——每条都有明确「落地为」（DAO 层 / lint 规则 / 时序图 / stub / 日志断言 / grep 断言等），无「加强检查」「完善校验」类空话。残余风险表 3 条（experimental API / 多 session 并发 / review 文件契约）均含影响+接受理由+监控方式四字段，诚实标注。

---

## 一句话总结

NFR 文档达标（pass）：7 维全覆盖、18 条代码测试缓解项无 PHANTOM 回燃、D-016 三维度核心风险诚实分析、24 条缓解均具体；5 个 SHOULD_FIX 集中在「nfr#14 三场景承诺 vs §6 单场景兑现」「同步 API 死锁 vs BUSY 重试辨析」「node:sqlite flag 版本边界」「深嵌套 JSON 防护未单列」「第三重 guard 未在 #2 安全维度点出」，均为精度加强非阻塞。
