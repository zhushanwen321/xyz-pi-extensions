---
verdict: CONSISTENT
stage: mid-detail-plan Step 5 (round 2 修复后更新)
reviewer: fresh consistency-check subagent + main-agent 修复核实
---

# 一致性终检报告 — CW (Coding Workflow Orchestrator)

> fresh context 全文档一致性检查。覆盖 6 份 deliverable + decisions.md + 5 份 review-loop 报告 + machine-check 报告。
> 检查方法：逐对核对（req↔arch / arch↔issues / issues↔nfr / issues↔code-arch / nfr↔code-arch / code-arch↔execution）+ 决策溯源 + 测试闭环 + 反哺核实 + 新 issue 跨文档影响。

## Verdict: CONSISTENT（round 2 修复后）

round 1 报 1 MUST_FIX + 5 SHOULD_FIX。round 2 修复：
- MF1（execution 遗漏 #15/#16）→ 新增 Wave 5.5 承接 ✓
- SF1（§9 表 3 处标注）→ 对齐骨架实际 ✓
- SF2（T2.21 三场景）→ 拆 T2.21a/b/c ✓
- SF5（深嵌套用例）→ 新增 T2.29 ✓
- SF3（Wave 归属说明）→ Wave 3 补说明 ✓
- SF4（review 文件命名）→ Step 6 补 review-nfr/code-arch/execution.md ✓

execution 清单同步 59 条（+T2.21b/c +T2.29）。4 份文档机器检查全 PASS。

原 round 1 报告正文保留于下（历史记录）。

---

## 原始报告：Verdict: INCONSISTENT

**1 项 MUST_FIX**（execution-plan 遗漏 #15/#16 跨文档实施编排）+ **5 项 SHOULD_FIX**（§9 表标注 / T2.21 三场景 / Wave 归属 / machine-check 命名 / nfr 计数差 1）。

不满足 CONSISTENT 判定条件中的「新 issue 跨文档已含」——#15/#16 在 issues.md 定义为 P1，但 execution-plan Wave 0-6 完全未承接它们的实施。

---

## MUST_FIX（1 项）

### MF1 [跨文档 gap] execution-plan 遗漏 #15（skill 收口批次）+ #16（coding-execute 适配 CW）的实施编排

- **位置**：
  - `issues.md` L475 `### #15: skill 收口改造批次`（P1）+ L534 `### #16: coding-execute skill 适配 CW`（P1）
  - `execution-plan.md` Wave 0-6 的「包含的功能/issue」段（L66/99/126/160/186）+ 「后续迭代」段（L53-55）
- **事实**（grep 核实）：
  - execution-plan.md 全文 grep `#15|#16|skill 收口|coding-execute skill|入口 skill` → **零匹配**
  - execution-plan 各 Wave Issue 号仅含 `#1/#2/#3/#4/#5/#6/#7/#8/#9/#10` + 后续迭代段 `#12(P3)/#13(Won't)`
  - **#15/#16 完全未出现在 execution-plan 任何 Wave 或后续迭代段**
- **原因**：
  - #15 是 requirements §1 G2 的 **MVP 验收项**（"agent 工具箱中只有 coding-workflow tool + 新增入口 skill coding-workflow"）。execution-plan 不含 #15 = MVP 验收项无实施规划 = G2 验收风险。
  - #16 是 dev/test 核心路径（UC-3/UC-4）。execution-plan Wave 5 仅含 #16 AC-16.1（删 coding-execute.js），缺 AC-16.2~16.5（skill 指导重建 / 数据契约 / check_execute.py 复用 / trace）。
  - execution-plan 隐含 scope 是 code-arch §8 的 CW 扩展代码模块（src/cw/），但 #15/#16 的 skill 改造（SKILL.md）也在 extensions/coding-workflow/ 内（code-arch §13.2 确认 skills/coding-execute/ 路径），属同一交付包。execution-plan 既未将 #15/#16 纳入任何 Wave，也未在「后续迭代」段或交接说明中解释它们由哪个独立 plan 承接。
- **违反检查项**：新 issue #15/#16 跨文档影响未闭合（issues.md 定义 → execution-plan 未承接）。
- **修复建议**：二选一。
  - (a) 在 execution-plan 新增 Wave（如 Wave 3.5 或独立 Wave 7）承接 #15/#16 的 skill 改造，含 AC-15.1~15.5 / AC-16.1~16.5 的实施任务。
  - (b) 在 execution-plan「后续迭代」段或交接说明明确标注"#15/#16 skill 改造由独立 plan 承接"，并引用该 plan（当前无此说明）。

---

## SHOULD_FIX（5 项，非阻塞但需关注）

### SF1 [§9 表标注 vs 骨架实际] code-arch §9 表 3 处标注与骨架 throw 叶子/真实查询状态不符（review-loop3 M1/S6/S7 未修）

- **位置**：`code-architecture.md` §9 骨架覆盖核验表
  - L560 `| store.CwStore.updateGatePassed | ... | ✅ 接线完整 | db.prepare().run() |`
  - L565 `| store.CwStore.updateTestCase | ... | ✅ 接线完整 | db.prepare().run() |`
  - L570 `| gates.lookupGateTier | ... | ✅ 签名(叶子throw) | 查 GATE_REGISTRY |`
- **事实**（骨架核实）：
  - `code-skeleton/src/cw/store.ts` L197-204 `updateGatePassed` 体 = `throw new Error("not implemented: updateGatePassed JSON 读改写（⑥Wave 落地）")` — 是 **throw 叶子**，但 §9 标"✅ 接线完整"。review-loop3 M1 指出后**未修**。
  - `updateTestCase` 骨架只 `SET status = ?`（review-loop3 S7 指出 patch 的 actual/screenshotPath/commitHash 字段未持久化），是**部分叶子**，§9 标"✅ 接线完整"高估。
  - `lookupGateTier` 骨架是真实查询 `return findRule(tier, phase).gateTier`（review-loop3 S6 指出），应标"✅ 接线完整"，§9 却标"✅ 签名(叶子throw)"——方向相反的标注错误。
- **影响**：§9 表是 ⑥execution-plan Wave 编排的输入（Wave planner 据此判断方法就绪度）。虚报"接线完整"会让 Wave 误判 throw 叶子已就绪、不分配实现工时。
- **修复**：§9 表三行标注对齐骨架实际状态（updateGatePassed/updateTestCase → `签名(叶子throw)` 或 `签名(部分叶子)`；lookupGateTier → `接线完整`）。注：这些是骨架过渡态标注，Wave 落地时实际代码会替换 throw 叶子，但定稿时 §9 表应诚实反映骨架当前状态。

### SF2 [nfr→code-arch 承诺未兑现] T2.21 三种 infra 场景承诺 vs 单一场景覆盖

- **位置**：
  - `non-functional-design.md` 缓解表行「verdict/exitcode 矛盾 + ENOENT + timeout → infra-error（#6 稳定）」承诺**三种** infra 场景断言
  - `non-functional-design.md` 缓解表底部注释「交 code-arch 阶段把 T2.21 拆为参数化 3 行」
  - `code-architecture.md` §6 来源 B T2.21（L| 异常 | mock | verdict/exitcode 矛盾→infra-error | exit0 但 verdict FAIL | ...）——**只覆盖「矛盾」一种**
- **事实**：nfr 侧已诚实标注 GAP（底部注释），但 code-arch §6 T2.21 **未实际拆为参数化 3 行**。timeout 被 T2.20 顺带覆盖，**ENOENT（python 缺失）场景完全缺独立用例**。
- **影响**：nfr 承诺范围与 code-arch 兑现端有精度差。三种场景代码出口相同（都 throw infraError），但 nfr 既承诺"三种"就应兑现，否则指针声明的验收范围是部分 PHANTOM。
- **修复**：code-arch §6 T2.21 拆为参数化用例（3 行输入：矛盾 / ENOENT / timeout → 同一 infra-error 出口），或新增 T2.21b 专测 ENOENT。

### SF3 [Wave 归属不一致] retrospect/closeout handler：code-arch §8 建议 W5 vs execution-plan 归 W3

- **位置**：
  - `code-architecture.md` §8 下游衔接表：`actions/{retrospect,closeout}.ts + index.ts dispatch | Wave 5 | 全部 handler`
  - `execution-plan.md` Wave 3「文件影响」：`创建: src/cw/actions/{create,plan,clarify,detail,retrospect,closeout}.ts`（含 retrospect/closeout）
  - `execution-plan.md` Wave 5「文件影响」：仅 `index.ts dispatch + tool 注册 + 遗留物清理`（不含 retrospect/closeout handler 创建）
- **事实**：execution-plan 把 6 个 single-shot handler（含 retrospect/closeout）全归 Wave 3，code-arch §8 建议 retrospect/closeout 归 Wave 5（与 index.ts dispatch 一起）。两种编排都可行（Wave 3 时依赖已就绪），但 execution-plan 调整了 code-arch §8 建议**未说明理由**。
- **影响**：Wave 编排文档不一致，实施者据 code-arch §8 或 execution-plan 会得到不同归属。非阻塞（handler 创建在 Wave 3 或 Wave 5 都能跑通），但应统一。
- **修复**：execution-plan Wave 3 或 code-arch §8 二选一对齐，并在调整处加一句说明。

### SF4 [gate 兼容性] machine-check-code-arch / machine-check-execution 标 FAIL（review-{phase}.md 命名缺失）

- **位置**：
  - `changes/machine-check-code-arch.md` Verdict: FAIL（"review-code-arch 存在 | ❌ FAIL | 文件不存在"）
  - `changes/machine-check-execution.md` Verdict: FAIL（"review-execution 存在 | ❌ FAIL | 文件不存在"）
  - `changes/` 目录实际 review 文件：`review-clarity.md` / `review-architecture.md` / `review-issues.md`（mid-plan 阶段产物）+ `review-loop1-issues-coverage.md` ~ `review-loop5-redteam.md`（mid-detail-plan round 1-5 产物）
- **事实**：mid-detail-plan 的 review-fix-loop 产出按 `review-loopN-{topic}.md` 命名，machine-check 脚本期望 `review-{phase}.md`。缺 `review-code-arch.md` / `review-execution.md` / `review-nfr.md`。
- **影响**：machine-check 标 FAIL 会触发 gate 硬阻断（"review subagent 必须 CHANGES_REQUESTED，不许 APPROVED"）。这不是 .md 内容矛盾，是 review 文件命名约定与 machine-check 脚本期望不兼容。
- **修复**：补 `review-code-arch.md` / `review-execution.md` / `review-nfr.md`（可从 review-loop3/4/2 提炼 verdict: APPROVED + MUST_FIX 已修声明），或让 machine-check 脚本适配 `review-loopN` 命名。

### SF5 [计数差 1] nfr 代码测试项（19 条）vs code-arch §6 来源 B 用例（18 条）

- **位置**：
  - `non-functional-design.md` 缓解表「验收方式=代码测试」实际 19 条（含「JSON.parse 深度限制」独立行，review-loop2 S4 已让 nfr 侧单列）
  - `code-architecture.md` §6 来源 B 用例 T2.11~T2.28 = 18 条（自检称"17 条"，计数本身也不准）
  - 差异：「JSON.parse 深度限制（reject 嵌套 >N 层）」在 nfr 缓解表独立成行，但 code-arch §6 无对应独立用例（T2.17 只测 size guard >1MB）
- **事实**：review-loop2 S4 已让 nfr 侧把深嵌套防护独立成条，但 code-arch §6 未补对应独立用例。深嵌套 JSON 即使 <1MB 也能爆栈（JSON.parse 递归深度），与 size guard 是不同风险源。
- **影响**：nfr 缓解表与 code-arch §6 来源 B 的指针完整性有 1 条 gap。深嵌套防护无独立测试覆盖。
- **修复**：code-arch §6 来源 B 新增 T2.29（深嵌套 JSON 被拒），或 T2.17 扩展为参数化 2 行（size + depth）。

---

## 已核实通过的检查项

### 1. 跨文档核心定义一致 ✓

| 检查维度 | 一致性 | 核实点 |
|---------|--------|--------|
| 状态机（状态集/转换表/跨阶段级联） | ✓ 一致 | requirements §4/§7 ↔ architecture §4.1/§4.2 ↔ issues #2 AC ↔ code-arch §3 state-machine。lite(created→planned→developed→tested→retrospected→closed) + mid(created→clarified→detailed→developed→...) 两路状态集、9 行转换表、两重 guard（线性+级联）跨文档一致 |
| 模块划分（src/cw/ 目录结构） | ✓ 一致 | architecture §3 ↔ code-arch §1 ↔ issues 上游覆盖表。7 个 cw 模块（types/state-machine/store/gates/plan-parser/actions/+ index.ts）+ actions/ 8 handler 跨文档一致 |
| gate 注册表（11 行 tier×phase→checker） | ✓ 一致 | architecture §5.2 ↔ code-arch §3 GATE_REGISTRY ↔ issues #4。11 行映射 + 4 档 gateTier（weak-structural/medium-git/medium-coverage/strong-recompute）跨文档一致 |
| gateTier 4 档定义 | ✓ 一致 | requirements §7 ↔ architecture §5.1/§8.2 GateTier 类型 ↔ nfr 矩阵 ↔ code-arch §3 |

### 2. decisions.md 决策溯源完整 ✓

D-001~D-017（含 D-007-REVISIT）每条 confirmed 决策在对应 .md 有真实章节，source 溯源不断：

| 决策 | 落点章节 | 溯源 |
|------|---------|------|
| D-001 CW 作为 tool | req §6/§7, arch §2, code-arch §3 registerCodingWorkflowTool | ✓ |
| D-002 CW 上层编排器 | req §2, arch §11 | ✓ |
| D-003 tier 锁定 | req UC-2 AC-2.1, arch §7, issues #5 AC-5.2, code-arch parseLitePlan | ✓ |
| D-004 test-orch 内化 | req §6, arch §9, issues #8, code-arch §7 | ✓ |
| D-005 渐进式提交 | req UC-3/UC-4, arch §4.3, issues #10 | ✓ |
| D-006 plan JSON | req UC-2, arch §12, issues #5/#15 | ✓ |
| D-007 → superseded by D-007-REVISIT | decisions.md 标注正确（status: superseded） | ✓ |
| D-007-REVISIT 降级 | req §1 G2, arch §10, issues #15 AC-15.5 | ✓ |
| D-008 lite 重算/mid 信声明 | req UC-4, arch §5.1, issues #8 AC-8.2, code-arch handleTest | ✓ |
| D-009 状态机主强制点 | req §2, arch §4, issues #2 | ✓ |
| D-010 MVP lite+mid | req §2, arch §8.2, issues #13 | ✓ |
| D-011 skill 改名推迟 | req §1 G2, arch §10.4, issues #12 | ✓ |
| D-012 DESIGN-IT-TWICE | issues #1/#2 方案 A，changes/dit-agent-{1,2,3}.md | ✓ |
| D-013 P2 维持 | issues #9/#10/#11 均 P2 | ✓ |
| D-014 迷雾 #14 不展开 | issues #14, nfr #1 并发维度 | ✓ |
| D-015 full Won't | issues #13 | ✓ |
| **D-016 node:sqlite** | req §2/§4/§5, arch §6/§8, issues #1, nfr #1, code-arch §1/§3 | ✓ 跨文档一致应用 |
| **D-017 第三重 self-check** | decisions D-017 + code-arch §3 签名表/§6 T2.6/§9 表均已改描述 + nfr #2 安全维度不点出 | ✓ 跨文档一致应用 |

- **§TBD 残留检查**：grep 全文档无真实 §TBD/TODO/FIXME 残留（requirements/architecture 提"占位符"是描述 weak-structural gate 检查内容，非 §TBD）。✓
- **D-016（node:sqlite）跨文档**：存储层从文件改为 sqlite 关系表（4 表 DDL），在 requirements/architecture/issues/nfr/code-arch 五份文档一致体现。✓
- **D-017（第三重 self-check）跨文档**：从"防篡改"重新定位为"数据完整性 self-check"，code-arch 三处描述（§3/§6/§9）已改，nfr #2 安全维度未宣传为安全机制。✓

### 3. 测试闭环（56 条用例两端一致）✓

- **code-arch §6 test-matrix 全量**：来源 A 功能 38 条（T1.1-T5.4）+ 来源 B NFR 18 条（T2.11-T2.28）= **56 条**
- **execution-plan 测试验收清单**：T1.1-T1.5(5) + T2.1-T2.10(10) + T2.11-T2.28(18) + T3.1-T3.9(9) + T4.1-T4.10(10) + T5.1-T5.4(4) = **56 条**
- **集合完全相等**，每条用例 ID 在两端唯一出现，无 PHANTOM（code-arch 有 execution 无）/无 MISSING（execution 有 code-arch 无）。✓
- **per-Wave 覆盖清单与 canonical 验收清单双向一致**（review-loop4 M1/M2/M3 + S1-S4 均已修）：
  - Wave 0 含 T2.28（迁移日志，review-loop4 M1 已补）✓
  - T3.2/T3.3/T3.4 从 Wave 2 移除（review-loop4 M2 已修，canonical 归 W4）✓
  - T4.6 在 Wave 4 显式排除（review-loop4 M3 已修，canonical 归 W1）✓
  - T2.24 在 Wave 3 独立成行（review-loop4 S1 已修）✓
  - Wave 0 幽灵 ID「T8.1」改为来源 0 标注（review-loop4 S2 已修）✓

### 4. 反哺处理核实

| review-loop | MUST_FIX | 状态 |
|------------|----------|------|
| loop1（issues 覆盖） | M1 新增 #15 + M2 新增 #16 + 上游覆盖表修正 | ✓ 已修（issues.md #15/#16 已新增，覆盖表 §10/§12/§13 行已修正） |
| loop1 SHOULD_FIX | S1-S4（覆盖表标注/补行/AC 补全） | ✓ 全修 |
| loop2（nfr） | 无 MUST_FIX（5 SHOULD_FIX） | — |
| loop2 S2/S3/S4 | 死锁辨析/flag 边界/深嵌套单列 | ✓ 全修 |
| loop2 S1 | T2.21 拆参数化 | ✗ 未完全闭合（→ 本报告 SF2） |
| loop2 S5 | nfr#2 安全维度点出第三重 | △ 正确未采纳（与 D-017 决策冲突，主 agent 遵循 D-017 不在安全维度点出，正确） |
| loop3（code-contract） | M1 §9 updateGatePassed 标注 | ✗ 未修（→ 本报告 SF1） |
| loop3 M2/M3/M4 | 骨架 GitValidator/GateRunner/store.ts 代码层 | ▷ 骨架代码层面，属 Wave 落地范畴（非 .md 一致性问题，review-loop3 自述"建议 ⑥execution-plan 前修复"） |
| loop4（wave） | M1/M2/M3 + S1-S4 | ✓ 全修（见检查项 3） |
| loop5（redteam） | M1 第三重 guard | ✓ 已修（D-017 登记 + 描述改，选 review-loop5 建议 b 路线） |

### 5. 新 issue #15/#16 跨文档影响

- **issues.md**：#15（P1，skill 收口 4 子项）+ #16（P1，coding-execute 适配）已定义，含完整 AC（AC-15.1~15.5 / AC-16.1~16.5）。✓
- **上游覆盖表修正**：#15 覆盖 §10 skill 收口批次（原误归 #7）+ §12 JSON skill 产出侧（原只标 #5 CW 解析侧）；#16 覆盖 §13 删 coding-execute.js（原误标 N/A）。✓（review-loop1 M1/M2 已修）
- **execution-plan**：**✗ 未含 #15/#16 实施**（→ 本报告 MF1）

---

## 一句话总结

**INCONSISTENT**：1 项 MUST_FIX（execution-plan 遗漏 #15/#16 跨文档实施编排，前者直接影响 G2 MVP 验收项、后者影响 dev/test 核心路径）+ 5 项 SHOULD_FIX（code-arch §9 表 3 处标注与骨架不符 / T2.21 三场景承诺未兑现 / retrospect-closeout Wave 归属 code-arch↔execution 不一致 / machine-check 因 review-{phase}.md 命名缺失标 FAIL / nfr 代码测试项与 §6 来源 B 用例计数差 1）。状态机/模块/gate 注册表/D-016/D-017 跨文档一致，56 条测试用例两端一致，决策溯源完整，review-loop1/2/4/5 的 MUST_FIX 已修——但 review-loop3 §9 表标注 MUST_FIX 未修，且 #15/#16 未进入 execution Wave 使新 issue 跨文档链条断裂。
