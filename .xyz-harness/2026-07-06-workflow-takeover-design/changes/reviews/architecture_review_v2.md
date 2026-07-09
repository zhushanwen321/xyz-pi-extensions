# 架构审查报告 v2 — ADR-029「coding-execute 全流程 workflow 接管 + per-call cwd + worktree 隔离」

- **审查维度**：architecture（分层职责 / 模块边界 / 状态机一致性 / 数据流 / 可演进性）
- **基准点**：`4f2fb916f^`（ADR-029 首个 commit 父提交）
- **HEAD**：`2417444b6`
- **审查范围**：27 文件，+1284 / -159 行
- **审查日期**：2026-07-07

---

## 一、问题汇总表

| # | 级别 | 类别 | 位置 | 问题 | 决策项 |
|---|------|------|------|------|--------|
| 1 | 🔴 **CRITICAL** | 数据流断裂 | `.pi/workflows/execute-full-workflow.js` Phase 0/2 | test/review worktree 始终停在 BASE_REF，无 merge 步骤汇聚 dev 提交 → test-runner 测旧码、reviewer 审空 diff | 决策 2 |
| 2 | 🔴 **CRITICAL** | 运行时崩溃 | `.pi/workflows/execute-full-workflow.js:16,174` | import `execSync` 但调用 `execFileSync`（未 import）→ 所有 git 命令必抛 ReferenceError | 决策 2 |
| 3 | 🔴 **CRITICAL** | worktree 语义错误 | `.pi/workflows/execute-full-workflow.js:195,378` | dev 池 worktree 在 wave 间 `reset --hard BASE_REF`，丢弃上一 wave 的 commit（cw 已记录 commitHash 但 git 已无该 commit） | 决策 2 |
| 4 | 🟠 **MUST_FIX** | JS 语义缺陷 | `.pi/workflows/execute-full-workflow.js:551,569-582` | `return` 读 `cleanupFailures` 后 `finally` 才填充 → 主 agent 永远收到 `cleanup_failures=[]`、`cleaned=built`，孤儿 worktree 不可见 | 决策 2 |
| 5 | 🟠 **MUST_FIX** | 并发安全 | `extensions/coding-workflow/src/cw/actions/dev.ts:52-62` | `git.validate()` 子进程调用在 `transaction()` 内，违反 store.ts 注释自述的不变式；WAL+busy_timeout+retry 是兜底而非根治 | 决策 6 |
| 6 | 🟠 **MUST_FIX** | 模块边界 | `.pi/workflows/execute-full-workflow.js` + `extensions/coding-workflow/package.json` | workflow 脚本仅存在于项目级 `.pi/workflows/`，未随 `@zhushanwen/pi-coding-workflow` 发布 → 其他项目 `pi install` 后脚本不存在，SKILL 机器强制链断裂 | 决策 3 |
| 7 | 🟠 **MUST_FIX** | 测试缺失 | `.pi/workflows/execute-full-workflow.js` | 586 行核心编排脚本 + `buildWaves`/`topoSort` 调度算法零测试覆盖（`parallel` mock 困难不构成豁免理由） | 全局 |
| 8 | 🟡 **SHOULD_FIX** | 状态机冗余 | `extensions/coding-workflow/src/cw/checks/check-execute.ts` 与 `src/cw/store.ts` | 两套独立 test 状态校验（机器门读 test-results.json vs cw 状态机），ADR-029 后 workflow 场景 test-results.json 不再落盘，机器门冗余且维护负担 | 决策 5 |
| 9 | 🟡 **SHOULD_FIX** | 依赖声明 | `extension-dependencies.json` | `@zhushanwen/pi-coding-workflow` 新增对 `@zhushanwen/pi-subagents`（per-call cwd）的隐式运行依赖未声明；`pi-workflow` 的 `peerDependencies` 未加 `pi-subagents` | 决策 1 |
| 10 | 🟡 **SHOULD_FIX** | 契约不一致 | `SKILL.md` Step 3 vs `execute-full-workflow.js` return | SKILL 称 `test.failures` 含「infra 失败」、逻辑 fail 须读 cw；但 workflow 的 test wave 在 `status==='fail'` 时也 `testAborted=true` 而不区分逻辑/infra，主 agent 按 SKILL 处理会漏判 | 决策 3 |
| 11 | 🟡 **SHOULD_FIX** | 前向兼容 | `docs/adr/029` vs `docs/adr/025` | ADR-025 进程内迁移时 Chain B（spawn cwd）需改为 Chain A（createAgentSession cwd），ADR-029 已说明但未给迁移检查清单 | 决策 1 |
| 12 | 🟢 **LOW** | 数据契约 | `.pi/workflows/execute-full-workflow.js` return | workflow return 无 JSON Schema 兜底（SKILL.md 给的是示例 JSON，非 typebox 校验），主 agent 误读字段无防护 | 决策 3 |
| 13 | 🟢 **LOW** | 文档漂移 | `.xyz-harness/2026-07-06-workflow-takeover-design/design.md` | design.md §3.6 return 仍含 `commits/testResults`，与 ADR-029 决策 3 修订（不含，已在 cw）和实现不一致 | 文档 |
| 14 | 🟢 **INFO** | 可观测性 | `.pi/workflows/execute-full-workflow.js` | 主 agent 仅靠 `return.next_hint` 字符串决策，无机器可读的状态码（如 `status: "dev_failed"|"test_failed"|"review_blocked"|"complete"`），AI 解析自然语言有逃逸面 | 决策 3 |

**统计**：CRITICAL 3 / MUST_FIX 4 / SHOULD_FIX 4 / LOW 2 / INFO 1 = **14 项**

---

## 二、分层职责（审查项 1）

### 主 agent / workflow / cw store / subagent runtime 职责划分

**结论：分层意图清晰，但实现把 workflow 的「纯执行器」职责做坏了。**

| 层 | ADR-029 期望职责 | 实现现状 | 评价 |
|----|------------------|----------|------|
| 主 agent | 调 workflow + 读 return + 决策（不手拆 subagent） | SKILL.md §阶段 A+B 严格约束，自由度表「建/删 worktree 禁止」 | ✅ PASS（指导层到位） |
| workflow script | worktree 生命周期 + dev/test wave 调度 + review + cleanup | 实现 4 phase 框架在，但 **Phase 0 建的 test/review worktree 永远停在 BASE_REF，无 merge 步骤**（见问题 #1） | 🔴 职责未完成 |
| cw store | 状态机 + 持久化 | store.ts WAL+busy_timeout+migration v4 到位 | ✅ PASS |
| subagent runtime | 进程内 agent 执行 | subagents Chain A per-call cwd 完整落地 + 契约测试 | ✅ PASS |

**跨层调用检查**：
- workflow script 通过 prompt 注入让 agent 调 cw tool（不直接 import cw store）→ ✅ 符合 ADR-029 决策 3 修订
- 主 agent 不再手动组装 cw dev/test 入参 → ✅ 符合
- **但**：workflow 内 agent 调 cw 时 `workspacePath` 靠 prompt 文字注入（`buildImplementerPrompt`/`buildTestRunnerPrompt`），agent 若不遵守则打开错误 `_cw.db`。这是文字约束不是机器强制，与 ADR-029「机器层强制」的初衷有张力（见问题 #12）。

---

## 三、ADR-029 六项决策的实现一致性（审查项 2）

### 决策 1：per-call cwd（两条链）— ✅ PASS（实现最完整的一项）

| 链 | 文件 | 实现 | 测试 |
|----|------|------|------|
| Chain A (subagents) | `subagent-service.ts:545`、`types.ts:354`、`subagent-actions.ts:55`、`subagent-tool.ts:107` | `opts?.cwd ?? this.cwd` 全链路透传 | ✅ `execute-integration.test.ts` 3 个契约测试（缺省回退 / 显式覆盖 / 并发隔离） |
| Chain B (workflow) | `pi-runner.ts:81`(RunPiProcessOptions)、`subprocess-agent-runner.ts:80`、`concurrency-gate.ts:263`、`worker-script-builder.ts:166`、`error-recovery.ts:64` | `spawn({cwd})` 透传 + worker `knownFields` 加 cwd | ✅ `subprocess-agent-runner.test.ts` 2 个契约测试 |

**亮点**：`runPiProcess` 从位置参数重构为 `RunPiProcessOptions` 对象，避免参数膨胀，是好的 API 演进。Chain A/B 都有契约测试，是本次改动质量最高的部分。

**遗留**：两条链设计同构但实现独立，未来 ADR-025 进程内迁移时 Chain B 要改回 Chain A 路径（见问题 #11）。

### 决策 2：worktree 生命周期归 workflow — 🔴 CRITICAL（实现有致命缺陷）

| 子项 | 期望 | 实现 | 评价 |
|------|------|------|------|
| 原生 git 不依赖 .bare | `git worktree add` | `gitArgs(WORKSPACE_ROOT, "worktree", ["add", wtPath, "-b", branch, BASE_REF])` | ✅ 用 execFileSync(shell:false) 避注入 |
| 4 phase 生命周期 | setup → dev → test+review → cleanup | 框架在 | ⚠️ 但 `execFileSync` 未 import（问题 #2） |
| dev 池化复用 | ADR-029 开放问题 1+2（上限 5、独占） | 实现「池+reset 复用」 | 🔴 reset 丢 commit（问题 #3） |
| test/review 看到 dev 改动 | 隐含前提 | **无 merge 步骤** | 🔴 test/review worktree 停在 BASE_REF（问题 #1） |
| cleanup finally 必跑 | 失败也清 | try/finally 包裹 | ⚠️ 但 return 读不到 cleanupFailures（问题 #4） |

### 决策 3：渐进式 cw — 🟡 SHOULD_FIX（设计好，但与 return 契约有矛盾）

- 每个 agent 完成后立即调 cw：✅ prompt 模板注入 `cw(action=dev/test, ...)` + `workspacePath` 显式传项目根
- workflow return 不含 commits/testResults：✅ return 只有 review 汇总 + failures + cw_hint
- **矛盾点**（问题 #10）：SKILL Step 3 说「逻辑 fail 不在 `test.failures` 里，主 agent 须读 cw」，但 workflow `testWaves2d` 在 `r.status==='fail'` 时设 `testAborted=true` 并把该 case 当 infra 失败处理逻辑（虽然没 push 到 `testFailures`，但 abort 行为与 SKILL 描述的「逻辑 fail 由 cw 管」语义混淆）。主 agent 按 SKILL 文字处理时区分边界模糊。

### 决策 4：test 调度字段进 plan.json — ✅ PASS（实现对称、有环检测）

- `LitePlanSchema` / `MidDetailSchema` 加 `dependsOn` + `parallelGroup`（对称于 dev wave）✅
- `types.ts` `TestCase` + `TestCaseSeed` 加字段 ✅
- store migration v3→v4（`depends_on`/`parallel_group` 列 + 幂等 check-then-add）✅
- `plan-parser.ts` 加 `assertAcyclicDeps`（DFS 三色标记环检测 + 未知 id 检测）→ **fail-fast 在 plan 阶段而非 execute 阶段**，这是优秀的防御设计 ✅
- `buildWaves`/`topoSort` 算法实现 ✅（但**零测试**，见问题 #7）

**亮点**：plan-parser 层做环检测，让 workflow 的 `topoSort` 不会在 worktree 建好之后才发现坏 plan，节省资源。

### 决策 5：砍 pending-env — ✅ PASS（简化到位，文档全同步）

- 状态简化为 `pass`/`fail`/`user-skipped` ✅
- 6 文件同步：`execution-flow.md`、`test-case-schema.md`、`subagent-dispatch.md`、`SKILL.md`、`selftest_check_execute.py`、`check-execute.ts` 注释 ✅
- selftest 负例 `pending_env_terminal` → `real_fail_terminal`（`pending-env` → `fail` + `no env:` evidence）✅

**遗留**（问题 #8）：`check-execute.ts` 仍保留 `manual`/`blocked` 拒绝逻辑，与 cw 状态机（已无这些态）形成两套独立校验，文档自称「遗留机器门」但维护负担真实存在。

### 决策 6：store WAL + busy_timeout — 🟡 SHOULD_FIX（实现到位但根治点在别处）

- `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000` ✅
- `init()` 用 `BEGIN IMMEDIATE` 串行化并发首次初始化（解 TOCTOU）✅ 这是审查 robustness MUST_FIX 的修复，质量高
- `transaction()` 加 SQLITE_BUSY 指数退避重试（最多 3 次）✅
- 契约测试：`store.test.ts` 验证 journal_mode + busy_timeout + dependsOn round-trip ✅

**问题 #5**：store.ts 注释自述「fn 内不得持锁跨进程 IO」，但 `dev.ts:52-62` 的 `handleDev` 在 `transaction()` 内调 `deps.git.validate()`（子进程 git）。WAL+busy_timeout+retry 是兜底，持锁跨 git 调用的根因未除。并发 N 个 agent 同时 dev 提交时，长事务（git 慢）+ busy_timeout 5s + retry 3 次 = 最坏 ~15s 延迟，且仍可能失败。注释承认「后续应重构为先 git.validate 再事务写入」，但这是 SHOULD_FIX 不是 INFO，因为 ADR-029 决策 3 修订**正是引入了这种并发模式**。

---

## 四、模块边界（审查项 3）

### 依赖方向

```
coding-workflow ──(runtime)──> workflow ──(spawn pi 子进程)──> [pi 加载所有 extension]
                     │                                          ▲
                     └──────────────────────────────────────────┘
                          (子进程内 agent 调 cw tool，非编译期依赖)
```

- coding-workflow **不**代码级 import workflow 或 subagents ✅（`path-encoding.ts` 仅注释引用）
- workflow 通过 `spawn("pi")` 启动子进程，子进程加载所有已安装 extension，agent 调 cw tool → 运行时耦合，非编译期 ✅
- workflow 不 import subagents ✅

### extension-dependencies.json 同步 — 🟡 SHOULD_FIX（问题 #9）

当前 `extension-dependencies.json` 声明：
```json
"@zhushanwen/pi-coding-workflow" dependsOn [
  { "package": "@zhushanwen/pi-workflow", "type": "runtime" }  // ✅
]
```

**缺失**：
1. `@zhushanwen/pi-coding-workflow` 对 `@zhushanwen/pi-subagents` 的依赖未声明。ADR-029 决策 1 Chain A 的 per-call cwd 是 workflow 内 agent 的隔离前提，虽经 spawn 子进程，但子进程加载 subagents extension 提供 `subagent` 工具 + cwd 隔离语义。应声明为 `runtime` 或 `optional`。
2. `@zhushanwen/pi-workflow` 的 `peerDependencies` 未加 `@zhushanwen/pi-subagents`（Chain B 的 cwd 透传虽不依赖 subagents 代码，但 workflow agent 调 subagent 工具时需 subagents 已安装）。

违反 AGENTS.md「新增/修改依赖 → 更新 dependsOn 数组」强制规范。

---

## 五、状态机一致性（审查项 4）

### cw 状态机 vs SKILL.md

| 维度 | cw store.ts | SKILL.md | 一致性 |
|------|-------------|----------|--------|
| test status 取值 | `pass`/`fail`/`user-skipped`（+ `pending` 初始态） | `pass`/`fail`/`user-skipped` | ✅ |
| dev gate | 全 wave committed=true | 「nextAction.waves 全 committed=true」 | ✅ |
| test gate | 全 testCase passed=true（user-skipped 当 pass） | 「nextAction.testCases 全 passed=true」 | ✅ |
| pending-env | 已砍 | 已砍 | ✅ |

### workflow return contract vs SKILL Step 3 — 🟡 SHOULD_FIX（问题 #10）

SKILL Step 3 决策逻辑：
- `dev.all_ok=false` → 回阶段 A
- `test.all_ok=false` → **两类**：infra 失败（`test.failures`）vs 逻辑 fail（读 cw）
- `review.total_must_fix>0` → 读 review-merged.md

workflow return 实现：
- `test.aborted` / `test.failures` / `test.all_ok`

**不一致点**：workflow 的 test wave 处理（`.pi/workflows/execute-full-workflow.js:440-456`）：
```js
} else if (r.status === "fail") {
  log("  ✗ test " + caseId + " = fail...");
  waveHasFail = true;   // ← 逻辑 fail 也触发 abort
}
```
逻辑 fail（agent 已调 cw 提交 status=fail）被当作 wave 失败信号 `testAborted=true`，但**不** push 到 `testFailures`（只有 infra 失败 push）。结果：
- `allTestOk = !testAborted && testFailures.length===0` → 逻辑 fail 时 `testAborted=true` → `allTestOk=false`
- SKILL 说「逻辑 fail 不在 test.failures，主 agent 须读 cw」，但 `test.all_ok=false` 会触发主 agent 读 `test.failures`（为空！），主 agent 困惑：all_ok=false 但 failures=[]？

主 agent 按 SKILL 处理时会卡在「all_ok=false 但 failures 空，该回 workflow 还是读 cw？」的歧义。建议 workflow return 加显式 `test.logic_fails: [{caseId, ...}]` 字段，或 SKILL 明确「all_ok=false && failures=[] → 必读 cw」。

### check-execute.ts 与 cw 状态机 — 🟡 SHOULD_FIX（问题 #8）

两套独立机制：
- **cw 状态机**（`store.ts` test_case.status）：ADR-029 后 workflow 场景的 source of truth
- **check-execute.ts**（读 test-results.json）：遗留执行收尾机器门

`check-execute.ts` 顶部注释自承「ADR-029 后 workflow 场景下 test-results.json 可能不再统一落盘（渐进式 cw 取代），但本门仍服务于非 workflow 场景」。问题：
1. ADR-029 后主路径是 workflow，test-results.json 不落盘 → 机器门读不到数据 → 阶段 C 收尾机器门 FAIL
2. 两套 test 状态校验逻辑并行维护，`manual`/`blocked` 拒绝在 cw 已无这些态的情况下仍保留
3. SKILL §阶段 C Self-Check 仍要求「执行收尾机器门已跑且 PASS」，但 workflow 场景下该门数据源不存在

这是 ADR-029 未清理的遗留矛盾，应明确：workflow 场景下阶段 C 收尾门改读 cw 状态机，还是 workflow 仍须落盘 test-results.json 供机器门读？

---

## 六、数据流清晰（审查项 5）— 🔴 核心断裂

### 期望数据流
```
plan.json → workflow → dev waves → cw commits → test waves → cw test results → review → return next_hint
```

### 实际数据流（断裂点标注 ❌）

```
plan.json ─✅→ workflow buildWaves/topoSort ─✅→ dev waves
  │
  ├─ dev agent (cwd=devPoolWt) commit → cw(dev, commitHash) ✅
  │     │
  │     ❌ devPoolWt 在下一 wave 被 reset --hard BASE_REF，commit 丢失（问题 #3）
  │
  ├─ test agent (cwd=testWt)
  │     ❌ testWt 自 Phase 0 起停在 BASE_REF，无 dev 改动（问题 #1）
  │     → 测旧码，必然 pass（无改动可测）或报「功能不存在」
  │
  ├─ review agent (cwd=reviewWt)
  │     ❌ reviewWt 停在 BASE_REF，git diff BASE_REF...HEAD = 空diff（问题 #1）
  │     → reviewer 审空码，must_fix=0（虚假全绿）
  │
  └─ return next_hint="全流程全绿" （虚假成功）
```

**这是 ADR-029 实现的最严重缺陷**。design.md 的架构图（Phase 1 → Phase 2）从未画「dev 提交如何汇聚到 test/review worktree」这一步，实现也补不上。根因是 worktree 池化复用 + 独立 test/review worktree 的设计没有 merge 策略：

- dev 池 worktree 各持一个分支（`cw-...-dev-poolN-...`），commit 在各自分支
- test/review worktree 在 `BASE_REF`，没有任何 `git merge`/`cherry-pick`/`reset --hard <dev-branch>` 操作
- 结果：test/review 看不到任何 dev 输出

**修复方向**（不在本审查范围，但指出）：dev wave 全部完成后，须将所有 dev 分支 merge 到一个聚合分支，再 `git -C testWt reset --hard <聚合分支>` + `git -C reviewWt reset --hard <聚合分支>`。或 test/review worktree 在 Phase 0 不建，dev 完成后从聚合分支建。

### 数据格式 schema 兜底

| 环节 | schema | 评价 |
|------|--------|------|
| plan.json → workflow | typebox `LitePlanSchema`/`MidDetailSchema` + `assertAcyclicDeps` | ✅ 有兜底 |
| workflow agent return | `DEV_RESULT_SCHEMA`/`TEST_RESULT_SCHEMA`/`REVIEW_SCHEMA`（JSON Schema） | ✅ structured-output 强制 |
| workflow → 主 agent return | ❌ **无 schema**，SKILL.md 给示例 JSON 但非 typebox 校验 | 🟢 LOW（问题 #12） |
| cw dev/test 入参 | `TestCaseSubmissionSchema` + tool schema | ✅ 有兜底 |

### 渐进式 cw 写入与 return 读取的 race — 🟢 LOW

workflow return 时调 `cw_hint` 让主 agent 读 cw 确认终态。最后一个 agent 调 cw 到 workflow return 之间是串行（`await parallel` 完成才 return），无 race。但主 agent 读 cw 时若并发有其他 topic 的 agent 在写同一 `_cw.db`（跨 topic 并发），WAL+busy_timeout 覆盖。**实际风险低**，但「主 agent 读 cw 确认 gatePassed」与「workflow 内 agent 渐进式写」之间无显式同步屏障（如 workflow return 前自己读一次 cw 确认），依赖时序。

---

## 七、错误传播（审查项 6）

### workflow 内失败冒泡

| 失败类型 | 处理 | 评价 |
|----------|------|------|
| Phase 0 worktree add 失败 | `throw new Error` → workflow abort | ✅ 但 return 已建清单靠 cleanupFailures，而 cleanupFailures 因问题 #4 读不到 |
| Phase 1 dev wave 失败 | `waveOk=false` → `devAborted=true` → break 后续 wave，继续 test/review | ⚠️ dev abort 后仍跑 test/review 测空码（问题 #1 加剧）|
| Phase 2 test fail | `testAborted=true` → break 后续 test wave | ✅ |
| Phase 3 cleanup 失败 | catch → push cleanupFailures，不 throw | ⚠️ return 读不到（问题 #4） |
| 任意 throw | try/finally 跑 cleanup 后重抛 | ✅ 结构正确 |

### 主 agent 3 轮重试限

SKILL.md 明确「失败循环限 3 轮（超限 Stagnation 暂停）」✅（4 处提及：line 24/90/122/138）。但这是文字约束，主 agent 自己计数，无机器强制（goal 工具不跟踪 workflow run 次数）。

### worktree cleanup 失败影响下一次 run — 🔴 加剧

孤儿 worktree 占磁盘 + 占 git worktree 槽位。问题 #4 导致主 agent 收不到 `cleanup_failures`，不会提示用户清理。下一次 workflow run 在同一 `WORKSPACE_ROOT` 建 worktree 时，若分支名/路径撞上残留（`runStamp=Date.now()` 实际避免路径撞，但 git worktree list 残留条目会累积）。长期跑会 worktree 泄漏。

---

## 八、与 ADR-025 的前向兼容（审查项 7）— 🟡 SHOULD_FIX（问题 #11）

ADR-029 在 Consequences 显式承认「加深 spawn 依赖，ADR-025 迁移更难」，并说明迁移时需改两点：
1. Chain B 的 cwd 机制改为 Chain A 同构的 `createAgentSession({cwd})`
2. 决策 3 的 agent-cw 调用路径不变

**评价**：
- ADR-029 的自我认知诚实 ✅（没有隐藏技术债）
- 但缺迁移检查清单：ADR-025 落地时需同步审查 `worker-script-builder.ts`/`subprocess-agent-runner.ts`/`pi-runner.ts` 的 spawn 路径，ADR-029 未列文件清单
- 隐含假设「workflow 内 agent 调 cw tool」在进程内迁移后仍成立——这个假设**正确**（进程内 createAgentSession 同样加载 cw extension），但 ADR-029 未显式验证

**推测假设的有效性**：
- 「cw 是全局文件非 session 内存」✅ 已在 ADR-029 决策 3 修订说明核实
- 「子进程继承 ~/.pi/agent/settings.json」✅ pi 启动机制保证
- 进程内迁移后 `spawn({cwd})` 失效，需改 `createAgentSession({cwd})` — ADR-029 已说明

---

## 九、可演进性（审查项 8）

### workflow 脚本位置 — 🟠 MUST_FIX（问题 #6）

**现状**：`execute-full-workflow.js` 仅在项目级 `.pi/workflows/`（本 repo），**未**随 `@zhushanwen/pi-coding-workflow` 发布：
- `extensions/coding-workflow/package.json` 的 `files` 字段：`["src/", "index.ts", "lib/", "skills/", "mocks/"]` — 无 `.pi/workflows/` 或 workflow 脚本目录
- `pi.extensions`/`pi.skills` manifest 也无 workflow 声明

**后果**：
- 其他项目 `pi install @zhushanwen/pi-coding-workflow` 后，SKILL.md 指示调 `workflow run execute-full-workflow`，但脚本不存在 → 机器强制链断裂
- 本 repo 开发时能用（脚本在项目级 `.pi/workflows/`），掩盖了发布缺陷
- 这违反 AGENTS.md「资源自包含」红线：「用户 `pi install <extension>` 后直接可用，无需额外下载」

**修复方向**：将脚本移入 `extensions/coding-workflow/workflows/execute-full-workflow.js`，`package.json` 的 `files` 加 `"workflows/"`，并在 SKILL.md / 文档说明调用路径（项目级 `.pi/workflows/` 优先，extension-bundled 兜底）。或 ADR 记录「脚本随项目走，不随 extension 发布」的决策（但需明确主 agent 如何发现脚本）。

### schema 变动 migration 路径 — ✅ PASS

- v3→v4 migration 有幂等 check-then-add + `BEGIN IMMEDIATE` 并发保护
- `mapTestCaseRow` 缺省回退（`dependsOn=[]`、`parallelGroup=undefined`）向后兼容
- `runMigrations` 链式结构可扩展（v4→v5 追加即可）
- 迁移日志落 stderr（`cw-migration` 事件，含 from/to）

**亮点**：T2.27 测试模拟 v0 旧库 → 新 CwStore 自动迁移 + 数据保留，是扎实的回归保护。

### 新增 test wave 维度可扩展性 — 🟢 INFO

`TEST_RESULT_SCHEMA` 已支持 `status`/`evidence`/`actual`/`screenshot_path`/`commit_hash`/`claimed_status`。新增维度（如性能、安全）只需加 schema 字段 + 对应 cw test 分支，无需改调度算法。但 `buildTestRunnerPrompt` 的 tier 分支（lite/mid）硬编码，新增 tier 需改 prompt 构造器。

---

## 十、文档与代码一致性（审查项 9）

### ADR-029 vs 代码

| ADR-029 决策 | 代码实现 | 一致性 |
|--------------|----------|--------|
| 决策 1 per-call cwd | Chain A/B 完整 | ✅ |
| 决策 2 worktree 原生 git | gitArgs 用 git worktree add | ✅（但执行崩，问题 #2） |
| 决策 3 渐进式 cw | prompt 注入 cw 调用 | ✅ |
| 决策 4 plan.json 调度字段 | schema + store + parser | ✅ |
| 决策 5 砍 pending-env | 6 文件同步 | ✅ |
| 决策 6 WAL + busy_timeout | store.ts + init 并发保护 | ✅ |
| Consequences 承认 spawn 依赖加深 | — | ✅ 诚实 |

### design.md vs 实现 — 🟢 LOW（问题 #13）

`design.md` §3.6 return 契约仍写：
```js
return {
  phase: "complete",
  cwStatus: { devGatePassed, testGatePassed, testProgress },
  reviewMustFix: { mergedFile, totalMustFix, overlap },
  ...
}
```
而 ADR-029 决策 3 修订 + 实际实现 return 是：
```js
return {
  phase: "complete",
  cw_hint: "...",
  dev: { aborted, failures, all_ok },
  test: { aborted, failures, all_ok },
  review: { merged_file, total_must_fix, clean },
  ...
}
```
字段名（`cwStatus` vs `dev/test`）、结构（扁平 vs 分层）都不同。design.md 是 Draft 状态可接受，但应在 ADR-029 落地后同步或标注「以代码为准」。

### SKILL.md / reference docs 互一致性

| 文档 | 一致性 | 备注 |
|------|--------|------|
| `coding-execute/SKILL.md` 与 `execution-flow.md` | ✅ | 顶部都加了 ADR-029 角色变化说明 |
| `SKILL.md` Step 3 与 workflow return | 🟡 | 问题 #10（test.failures 语义歧义） |
| `execution-flow.md` 与 `subagent-dispatch.md` | ✅ | 都标注「workflow 内部行为参考，非操作手册」 |
| `test-case-schema.md` 加 dependsOn/parallelGroup 指导 | ✅ | 含填写指导 + 示例，质量高 |
| `lite-plan` / `mid-detail-plan` SKILL 测试设计步骤 | ✅ | 都加了「测试调度设计」子步骤 |

**亮点**：reference docs 的 ADR-029 角色变化说明（顶部 ⚠️ 块）做得详尽，明确区分「主 agent 入口」vs「workflow 内部行为参考」，降低 AI 误读绕过 workflow 的风险。

---

## 十一、重复/冗余（审查项 10）

### wave 调度算法重复 — 🟢 INFO

`topoSort` + `buildWaves` 在 workflow 脚本（JS）实现一次，`plan-parser.ts` 的 `assertAcyclicDeps`（TS）实现一次环检测。两者算法同构但语言不同（workflow 是 JS，plan-parser 是 TS），无法直接复用。可接受（workflow 脚本运行在 Worker 线程，不能 import TS 模块）。但 `topoSort` 的环检测在 workflow 运行时是冗余的（plan-parser 已在 cw plan gate 拒环），workflow 的 `topoSort` 抛环错误实际不可达——这是防御性冗余，可接受。

### cwd 透传逻辑 — ✅ 无重复

Chain A（subagents `buildSessionRunnerContext`）和 Chain B（workflow `spawn({cwd})`）是两条独立执行链，cwd 透传逻辑各自实现，无重复（设计上就是独立的）。

### check-execute.ts 与 cw 状态机 — 🟡 SHOULD_FIX（问题 #8，详见第五节）

职责重叠：两套 test 状态校验。ADR-029 后应明确谁是 source of truth。

---

## 十二、亮点总结

尽管有 3 个 CRITICAL，本次改动也有显著亮点，公平记录：

1. **per-call cwd（决策 1）实现质量最高**：Chain A/B 都有契约测试，`RunPiProcessOptions` 重构是好的 API 演进
2. **plan-parser 环检测前置**：`assertAcyclicDeps` 让坏 plan 在 cw plan gate 就被拒，不到 workflow 运行时浪费 worktree
3. **store 并发初始化保护**：`BEGIN IMMEDIATE` 解 TOCTOU，是审查 robustness MUST_FIX 的高质量修复
4. **reference docs 角色变化说明**：顶部 ⚠️ 块详尽区分「主 agent 入口」vs「workflow 内部行为」，降低 AI 逃逸风险
5. **砍 pending-env 文档同步彻底**：6 文件全同步，selftest 负例对应改写
6. **ADR-029 Consequences 诚实**：显式承认加深 spawn 依赖、worktree 副作用风险、引擎 bug 风险，不隐藏技术债

---

## 十三、修复优先级建议

| 优先级 | 问题 | 理由 |
|--------|------|------|
| P0（阻断使用） | #1 test/review worktree 无 merge | 核心数据流断裂，workflow 必产出虚假成功 |
| P0（阻断使用） | #2 execFileSync 未 import | 所有 git 命令必崩 |
| P0（阻断使用） | #3 dev 池 reset 丢 commit | cw 记录的 commitHash 在 git 中已悬空 |
| P1（严重缺陷） | #4 return 读不到 cleanupFailures | 孤儿 worktree 不可见，长期泄漏 |
| P1（严重缺陷） | #6 workflow 脚本未随 extension 发布 | 其他项目安装后不可用 |
| P2（应修） | #5 transaction 内 git.validate | 并发性能 + 正确性 |
| P2（应修） | #7 workflow 脚本零测试 | 586 行核心逻辑无回归保护 |
| P2（应修） | #8 check-execute.ts 遗留冗余 | 维护负担 + 阶段 C 机器门数据源缺失 |
| P2（应修） | #9 extension-dependencies.json 未同步 | 违反强制规范 |
| P3（建议） | #10 #11 #12 #13 #14 | 契约清晰度 / 前向兼容 / 文档漂移 |

---

## 十四、审查结论

**整体评价**：ADR-029 的**决策层**（6 项决策 + Alternatives + Consequences）质量高，分层意图清晰，文档同步彻底。但**实现层**存在 3 个 CRITICAL 缺陷，其中 #1（test/review worktree 无 merge）和 #2（execFileSync 未 import）使 workflow 在当前状态下**完全不可用**——任何执行都会要么崩溃（#2），要么产出虚假的全绿结果（#1）。

**建议**：在合并/发布前必须修复 P0 三项（#1/#2/#3）+ P1 两项（#4/#6）。决策 1（per-call cwd）和决策 4/5/6 的实现可作为后续修复的基础保留。decision 3（渐进式 cw）的设计优秀但需在 #1 修复后才能验证端到端。

**无法通过 architecture 审查**（3 个 CRITICAL 阻断使用）。
