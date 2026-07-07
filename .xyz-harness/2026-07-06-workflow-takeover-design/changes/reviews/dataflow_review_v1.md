# Dataflow Review v1

## 概要

- **审查范围**：ADR-029（`4f2fb916f^..HEAD`，15 commits）
- **审查重点**：端到端数据流一致性（dev → merge 聚合 → test/review → cw 渐进式写入 → workflow return → 主 agent 读取）
- **已知 4 维度发现**：见 `CODE_REVIEW_REPORT_v1.md`（32 项，16 已修）
- **本报告定位**：补 4 维度未发现的数据流断裂/竞态，或评估已修项的残留数据流风险。**不重复**已诊断并修复的问题（GitValidator merge-base 移除、execFileSync 导入、Phase 1.5 聚合等）。

### 审查方法

逐条追踪 8 个审查重点项的数据流路径，验证：①数据生产 → 落盘 → 消费三方契约；②跨进程/跨事务边界的一致性；③并发与失败路径下的不变式。

---

## 问题清单

| # | 优先级 | 数据流路径 | 文件:行号 | 描述 | 与 4 维度发现重叠 |
|---|--------|-----------|-----------|------|------------------|
| D1 | 🟠 MUST_FIX | worktree cwd → cw db 路径解析 | `index.ts:205` + workflow prompt | agent 在 worktree 里调 cw，若漏传 `workspacePath`，cw 用 `process.cwd()`（worktree 路径）→ `encodeCwd` 出 worktree 专属编码 → **打开一个空的、独立于主项目的 `_cw.db`**。topic not found 抛错，agent 不知所措；更坏情况是 topic 被「create」到错误的 worktree db，主 agent 读主项目 db 看不到，数据**永久隔离**。防护仅 prompt 文字（认知层），无机器强制。 | 无（P2-11 触及但未诊断此数据流断裂） |
| D2 | 🟠 MUST_FIX | GitValidator cwd 与 worktree object store | `gates.ts:264` + workflow `gitArgs` | `GitValidator.validate()` 用 `this.workspacePath` 作为 `git -C <cwd>` 参数。主 agent 调 cw 时 workspacePath=项目根（正确）。但 **agent 渐进式调 cw 时若传了 workspacePath=项目根，GitValidator 在项目根跑 `cat-file -e`**——worktree 与主仓库共享 object store，dev commit 确实可达（✓）。但 D1 若发生（workspacePath 退化成 worktree 路径），GitValidator 仍能找到 commit（worktree 也共享 object store），**db 路径错了但 git 校验通过**——数据被写入错误 db 的 topic，而该 topic 在错误 db 里不存在 → 抛 topic not found。D1 的次生故障。 | 无 |
| D3 | 🟠 MUST_FIX | merge 冲突 → review worktree 审部分代码 | `execute-full-workflow.js:415-420` | merge 失败时 `reviewWt` 仍从 `aggregateBranch` 建（含已 merge 的部分分支），reviewer 跑 `git diff BASE_REF...HEAD` 审的是**部分 dev 改动**，但 review 报告无任何标记区分「全量审」vs「部分审」。主 agent 收到 `review.clean=false` + `dev.merge_failures` 两个字段，需主 agent **自己关联**才能知道「这个 review 漏审了未 merge 的分支」——但 return 的 `next_hint` 在 merge 冲突分支**提前 return**（`!devMergeClean` 分支），**根本不进入 review 语义提示**。实际代码：merge 冲突时仍跑 review，但 next_hint 说的是 merge 冲突，review 结果被「吞」。 | 部分（P2-12 触及语义但未发现 review 被吞） |
| D4 | 🟡 SHOULD_FIX | cw store close vs WAL flush vs 主 agent 读 | `index.ts:223` `finally { deps.store.close() }` + workflow return | 每个 agent 渐进式调 cw 后，`execute()` 的 finally 调 `deps.store.close()`。WAL 模式下 `close()` 会 checkpoint + truncate（SQLite 文档保证 close 时 WAL 内容落盘）。**但**：agent 子进程的 cw 调用与主 agent 读 cw 是**不同进程**。主 agent 读发生在 workflow return 之后（此时所有 agent 子进程已退出，其 cw 已 close）。正常路径无问题。**异常路径**：agent 子进程被 SIGKILL（超时 abort）→ cw 子进程的 `finally` 不执行 → WAL 未 checkpoint → `-wal` 文件残留。下次主 agent 打开同 db 时 SQLite 自动 recovery（checkpoint on open），**数据不丢**但首次打开延迟。INFO 级实际风险，但 workflow 超时是设计内事件（`timeoutMs=30min`），需确认 SIGKILL 路径。 | 无（P4-30 触及 WAL race 但非此路径） |
| D5 | 🟡 SHOULD_FIX | mid `isAncestorOfAny` 在 aggregateBranch 语义下失效 | `gates.ts:330` + workflow merge | mid test gate 校验 `submission.commitHash` 是某 dev wave commit 的后裔。dev agent 在 sub-wave 分支 commit，cw 记录的 `committed` 是该分支 HEAD。test-runner 跑在 testWt（aggregateBranch），agent 传的 `commitHash` 倾向于传 **aggregateBranch HEAD**（它 `git rev-parse HEAD` 得到的）。问题：aggregateBranch HEAD 是所有 sub-wave merge 的最新点，**它是每个 sub-wave commit 的后裔**（merge --no-ff 把它们变成祖先）→ `isAncestorOfAny` 对**任意** dev commit 都返回 true。校验**恒通过**，退化为只查 `cat-file -e`。agent 即便传一个与本次任务无关但已在 aggregateBranch 历史里的 hash（如 BASE_REF 本身），也通过。 | 无（新发现） |
| D6 | 🟡 SHOULD_FIX | sub-wave 分支名唯一性 | `execute-full-workflow.js:170` `newSubWaveBranch` | 分支名 = `cw-<topic>-dev-w{waveIdx}s{subBatchIdx}p{slotIdx}-{runStamp}`。同一 runStamp 内唯一（waveIdx/subBatchIdx/slotIdx 三元组唯一）。**但**：`slotIdx` 来自 `for (let j = 0; j < subWave.length; j++)`，而 subWave 是 `wave.slice(start, start+subBatchSize)`——**不同 sub-batch 的 j 都从 0 开始**。例 wave=3 cases, pool=2：sub-batch0=[c0,c1] (j=0,1), sub-batch1=[c2] (j=0)。分支名 `...w0s0p0` 和 `...w0s1p0` 的 subBatchIdx 不同（0 vs 1），**唯一性成立**。✓ 但这是隐式依赖 subBatchIdx 区分，代码注释未声明此不变式，未来若有人改 subBatch 循环去掉 sb 维度会破坏唯一性。LOW 级。 | 无 |
| D7 | 🟡 SHOULD_FIX | aggregateBranch 清理在 finally 但 merge commit 不可达 | `execute-full-workflow.js:410-420` + `removeWorktree` | Phase 1.5 建 aggregateBranch + aggregateWt。finally 块 `removeWorktree` 对每个 worktree 做 `worktree remove --force` + `branch -D <branch>`。aggregateWt 在 worktrees 数组里（`role:"aggregate"`），会被清理。**但**：aggregateBranch 上 merge 的 sub-wave 分支（`devSubWaveBranches`）**不在 worktrees 数组**（它们是 dev pool worktree 里 checkout 的分支，pool worktree 的 `branch` 字段记的是初始 `dev-poolN` 分支，不是 sub-wave 分支）。sub-wave 分支**永远不会被 `branch -D`**，成为孤儿 ref。下次 workflow run 用新 runStamp 不冲突，但 ref 累积。LOW（git gc 最终清理，但可观测性差）。 | 无（P1-5 触及 worktree 泄漏但非此分支泄漏） |
| D8 | 🟡 SHOULD_FIX | test-runner 共享 testWt 的 commit_hash 语义 | workflow `buildTestRunnerPrompt` + test.ts mid 分支 | testWt 所有 test-runner 共享。mid 路径要求传 `commitHash`（测试基于的 dev commit）。agent 在 testWt 里 `git rev-parse HEAD` 得到 aggregateBranch HEAD——所有 case 传同一个 hash。语义上 commitHash 应表示「本 case 测试覆盖的 dev 改动」，但实际是「聚合点」。配合 D5，校验退化为恒真。lite 路径用 `actual` 对比 `expected`，读 testWt 文件——**所有 dev 改动已在 aggregateBranch**（merge 成功时），文件状态正确 ✓。但 merge 失败时 testWt 不建（跳过 test），无此问题。 | D5 关联 |
| D9 | 🟢 LOW | review 报告 file:line 引用在主 agent 修复后失效 | `execute-full-workflow.js:471` review-merged | review 报告引用 `file:line`，主 agent 回阶段 A 修复时会改代码 → 行号漂移。review-merged.md 的 `[HIGH-CONFIDENCE]` 段引用的是**修复前**的行号。主 agent 需自行重新定位。这是 review 工具的通病，非数据流 bug，但 return contract 未提示此特性。 | 无 |
| D10 | 🟢 LOW | extractMustFix 正则跨 `]` 匹配 | `execute-full-workflow.js:476` | `/\[(.+?):(\d+)\]/g` 的 `.+?` 会跨多个 `]` 匹配（如 `[a.ts:1] foo [b.ts:2]` 可能匹配成 `a.ts:1] foo [b.ts:2`）。CODE_REVIEW_REPORT P2-19 已记为未修 LOW。dataflow 影响：overlap 统计偏差 → `[HIGH-CONFIDENCE]` 段漏报或误报 → 主 agent 漏修 must_fix。**与 review 准确性直接相关**，建议提级。 | P2-19（确认 dataflow 影响） |
| D11 | 🟢 LOW | return 无 schema 兜底 | workflow return 对象 | return 字段 `dev.merge_failures`/`test.failures`/`review.merged_file` 在所有路径填充情况：正常路径全填 ✓；异常路径 catch 块填 `dev/test` 但 `review.merged_file=null`、无 `review.correctness/quality`（正常路径有）。主 agent 若无条件读 `result.review.correctness.must_fix` 在异常路径会 NPE。next_hint 是字符串无结构。 | P4-26/27（确认字段缺失路径） |
| D12 | 🔵 INFO | transaction 内 git.validate 的 WAL 隔离 | `dev.ts:52` + store.ts WAL | WAL 模式下 reader（`loadTopic`）读不到未 commit 的 writer 数据（WAL 的 read isolation：reader 看到的是最后一个 checkpoint 的快照）。dev.ts 在 transaction 内先 `loadTopic`（读旧快照）→ loop `git.validate` + `setWaveCommitted` → 重读 `loadTopic`。**重读在事务内**：同一连接的事务内 read 能看到自己的 write（SQLite 同连接内 read-uncommitted 语义成立）✓。但**并发其他 agent 的 loadTopic** 看不到本事务未 commit 的 write——这是期望行为（渐进式语义：每个 agent 提交后才可见）。P1-9 已记 transaction 内 git 调用问题，dataflow 确认无隔离错误，仅长事务风险。 | P1-9（确认无新数据流问题） |
| D13 | 🔵 INFO | cw user_version migration 并发首次初始化 | `store.ts:189` `BEGIN IMMEDIATE` | 并发 N agent 首次打开同 db，N 个 `BEGIN IMMEDIATE` 串行化（IMMEDIATE 立即获写锁）。败者 busy_timeout 等 5s，获锁后重读 user_version 发现已迁移，跳过。✓ 数据一致。**但**：MIGRATIONS 的幂等 check-then-add（`PRAGMA table_info` 检测列存在）在 BEGIN IMMEDIATE 保护下无 TOCTOU ✓。确认无问题。 | P3-23（确认无数据流问题） |

---

## 详细分析

### D1/D2 — worktree cwd → cw db 路径隔离（MUST_FIX，核心数据流断裂）

**数据流追踪图**：
```
主 agent (cwd=项目根)
  └─ workflow run(workspaceRoot=项目根)
       └─ Worker 线程 spawn agent(cwd=worktree路径)
            └─ agent 子进程 (process.cwd()=worktree路径)
                 └─ agent 调 cw(topicId, workspacePath=???, ...)
                      ├─ 若传 workspacePath=项目根 → encodeCwd(项目根) → ~/.pi/agent/cw/<proj-enc>/_cw.db ✓
                      └─ 若漏传 → process.cwd()=worktree → encodeCwd(worktree) → ~/.pi/agent/cw/<wt-enc>/_cw.db ✗
                           └─ 空 db → topic not found 抛错
                           └─ 或 agent 自作主张 create topic → 写入错误 db，主 agent 永远看不到
```

**根因**：`index.ts:205` `workspacePath = rawParams.workspacePath ?? process.cwd()`。fallback 是认知层约束（prompt 文字），不是机器层强制。

**为何 4 维度未发现**：
- architecture #11（P2-11）触及 `extension-dependencies.json` 声明，未追踪 cwd→db 路径的数据流。
- robustness 聚焦 worktree 生命周期，未触及 cw db 路径解析。
- ADR-029 决策 3 的「关键设计点 1」明确说了此风险（「agent 调 cw 必须显式传 workspacePath」），但**只在 ADR 文字里，未在代码层落地防护**。

**机器层强制方案**（建议）：
1. **cw tool schema 把 `workspacePath` 改为必填**（去掉 Optional）——但这破坏非 workflow 场景（主 agent 单独调 cw 依赖 cwd fallback）。
2. **cw 检测 cwd 是否在 `.cw-wt/` 下**（worktree 父目录约定），若是则拒绝用 process.cwd() fallback，强制要求显式 workspacePath 或从父目录推断。`if (cwd.includes('/.cw-wt/')) throw new Error("worktree cwd detected, workspacePath required")`。
3. **workflow spawn agent 时注入环境变量** `CW_WORKSPACE_ROOT=项目根`，cw 优先读 env 再 fallback process.cwd()。这是最干净的机器层方案——主 agent 调 cw 无 env（走 cwd fallback，兼容旧路径），workflow spawn 的 agent 有 env（强制对齐）。

**影响面**：一旦 agent 漏传（prompt 遵守率非 100%），渐进式 cw 写入全部进错 db，workflow return 后主 agent 读 cw 显示 topic 无任何 dev/test 记录 → 判定全失败 → 重跑 → 同样失败。**无恢复路径**（除非人工发现错误的 db 文件）。

---

### D3 — merge 冲突时 review 审部分代码但 next_hint 吞掉 review 语义（MUST_FIX）

**数据流追踪**：
```
Phase 1.5: merge sub-wave 分支到 aggregateBranch
  ├─ 分支 A merge 成功 ✓
  ├─ 分支 B merge 冲突 → abort → 记 devMergeFailures → continue
  └─ 分支 C merge 成功 ✓
  → aggregateBranch HEAD 含 A + C 的改动，不含 B

Phase 2: reviewWt 从 aggregateBranch 建
  └─ reviewer 跑 git diff BASE_REF...HEAD
       → diff 只含 A + C 的改动（B 未 merge）
       → review.must_fix / should_fix 反映的是 A+C 的代码质量
       → review 报告无标记「这是部分审」

workflow return:
  dev.merge_clean=false
  dev.merge_failures=[B]
  review.total_must_fix=N  (基于 A+C)
  review.clean = (N===0)
  next_hint = "dev 聚合有 merge 冲突..."  ← !devMergeClean 分支，完全不提 review
```

**问题**：
1. 主 agent 看到 `next_hint` 只说 merge 冲突，**不知道 review 已经跑了**（且审的是部分代码）。
2. 主 agent 若只读 `next_hint` 决策（SKILL 鼓励如此），会忽略 `review` 字段。
3. 即便主 agent 读 `review`，也无法知道「review 漏审了 B 分支的代码」——需自己关联 `dev.merge_failures` 的 branch 名与 review 报告的文件范围。

**为何是 MUST_FIX**：review 的核心价值是「审真 diff」。merge 冲突时 diff 不完整，review 结论（`review.clean`）**不可信**。但 return 的 `review.clean` 字段无任何「partial」标记，主 agent 可能据此判定 review 通过。

**修复建议**：
- merge 冲突时**跳过 review**（与 test 同策略：「审部分代码不如不审」）。或
- return 加 `review.partial=true` 标记 + `review.partial_reason="dev merge failures: N branches not merged"`，next_hint 明确说「review 仅覆盖部分改动，修复 merge 后需重跑 review」。

---

### D5 — mid `isAncestorOfAny` 在 aggregateBranch 语义下退化为恒真（SHOULD_FIX）

**数据流追踪**：
```
dev agent 在 sub-wave 分支 commit → cw 记录 wave.committed = sub-wave HEAD
Phase 1.5: merge --no-ff 所有 sub-wave 分支到 aggregateBranch
  → aggregateBranch HEAD 是所有 sub-wave commit 的后裔（merge commit 有多个 parent）

test-runner 在 testWt (aggregateBranch) 跑：
  agent 传 commitHash = aggregateBranch HEAD（git rev-parse HEAD）
  cw judgeMid 调 isAncestorOfAny(aggregateBranch HEAD, devCommits)
    → git merge-base --is-ancestor <devCommit> <aggregateBranch HEAD>
    → 对每个 devCommit 都返回 0（是祖先）→ 返回 true
  → 校验通过，信 claimedStatus
```

**问题**：校验本意是「commitHash 必须是某 dev wave commit 的后裔，证明测试覆盖真实 dev 工作」。但 aggregateBranch HEAD 是**所有** dev commit 的公共后裔，校验对任意 dev commit 恒真。**防不住** agent 传 BASE_REF（也是 aggregateBranch 祖先，但不是 dev commit）——等等，BASE_REF 不是 dev commit，`isAncestorOfAny(BASE_REF, devCommits)` 会查「BASE_REF 是某 devCommit 的祖先吗」→ BASE_REF 是所有 dev commit 的祖先 → 返回 true → **BASE_REF 也能通过校验**。

**根因**：ADR-029 前，dev agent 在主仓库 commit，test agent 也在主仓库，传的 commitHash 是 dev commit 本身（一对一）。ADR-029 后引入 aggregateBranch，commitHash 语义变成「聚合点」，原校验逻辑失效。

**影响**：mid tier 的 medium-coverage gate 退化，agent 可提交任意合法 commit hash（包括与任务无关的）蒙混。实际风险有限（agent 仍需跑测试并声称 passed），但破坏了 gate 的设计意图。

**修复建议**：
- test-runner prompt 明确要求传「本 case 测试覆盖的 dev wave 的 waveId」，cw 据 waveId 查 `topic.waves.find(w=>w.id).committed` 拿真实 dev commit，再校验 submission.commitHash **等于**该 commit（而非后裔）。但 test 跨 wave 时无法单一对应。
- 或：接受 aggregateBranch 语义，把 mid commitHash 校验改为「commitHash 在 aggregateBranch 历史里且 != BASE_REF」+ 依赖 test-runner 真跑测试（actual evidence）。

---

### D7 — sub-wave 分支孤儿（SHOULD_FIX，可观测性）

**数据流追踪**：
```
Phase 1 dev wave:
  for each sub-batch:
    for each slot j:
      branch = newSubWaveBranch(devWtPool[j], ...)  // 在 pool worktree 里 checkout 新分支
      devSubWaveBranches.push(branch)
    → parallel(agent...)  // agent 在该分支 commit

Phase 1.5:
  aggregateBranch merge 每个 devSubWaveBranches 分支

finally cleanup:
  for wt in worktrees:  // worktrees 只含 dev-poolN + aggregate + test + review
    worktree remove --force wt.path
    branch -D wt.branch  // 删的是 dev-poolN 初始分支，不是 sub-wave 分支
```

**问题**：`worktrees` 数组的 `branch` 字段在 `addWorktree` 时赋值（`dev-poolN`），`newSubWaveBranch` 在 pool worktree 里 checkout 了新分支但**未更新 worktrees 数组的 branch 字段**。cleanup 删的是初始分支，sub-wave 分支（`cw-<topic>-dev-w0s0p0-<stamp>` 等）残留为孤儿 ref。

**影响**：
- git ref 累积（每次 workflow run 产生 N 个孤儿，N=wave 数 × sub-batch 数）。
- `git branch` 输出污染，可观测性下降。
- aggregateBranch 已被 `branch -D`（它在 worktrees 数组里，role=aggregate），其历史 merge 的 sub-wave 分支失去可达 ref 但 object 仍在（git gc 前可 `git reflog` 找回）。

**修复建议**：cleanup 时额外 `branch -D` 所有 `devSubWaveBranches`。

---

## 统计

| 优先级 | 数量 | 说明 |
|--------|------|------|
| 🟠 MUST_FIX | 3 | D1（cwd→db 断裂）、D2（D1 次生）、D3（merge 冲突 review 语义吞没） |
| 🟡 SHOULD_FIX | 5 | D4（WAL SIGKILL）、D5（isAncestor 退化）、D6（分支名隐式不变式）、D7（sub-wave 孤儿 ref）、D8（testWt commit_hash 语义） |
| 🟢 LOW | 3 | D9（review 行号漂移）、D10（正则跨 ] 匹配）、D11（return 字段异常路径缺失） |
| 🔵 INFO | 2 | D12（WAL 隔离确认无问题）、D13（migration 并发确认无问题） |
| **合计** | **13** | 其中 3 个 MUST_FIX 是 4 维度未发现的新数据流断裂 |

### 与 4 维度的关系

- **新发现**（4 维度未触及）：D1、D2、D3、D5、D6、D7、D8、D9 —— 共 8 项，集中在「worktree cwd → cw db 路径」「merge 聚合后 commit 血缘语义变化」两条数据流，这是 ADR-029 引入的新拓扑（worktree + aggregateBranch）带来的、4 维度审查（按文件/职责）难以发现的全局数据流问题。
- **确认/补充**：D4（P4-30 补充 SIGKILL 路径）、D10（P2-19 确认 dataflow 影响）、D11（P4-26/27 确认异常路径）、D12（P1-9 确认无新问题）、D13（P3-23 确认无新问题）。
- **不重复**：GitValidator merge-base 移除（已修）、execFileSync 导入（已修）、Phase 1.5 聚合（已修）、return 时机（已修）、buildWaves guard（已修）——仅评估修复后的残留风险（D5/D7）。

### 修复优先级建议

1. **D1 + D2**（一起修）：cw 检测 worktree cwd 或注入 env，机器层强制 workspacePath 对齐。这是 ADR-029 决策 3「关键设计点 1」的代码层落地，目前仅 prompt 文字。
2. **D3**：merge 冲突时 review 加 partial 标记或跳过 review，next_hint 明确语义。
3. **D5**：重新设计 mid commitHash 校验以适配 aggregateBranch 语义（或接受退化并文档化）。
4. D4/D6/D7/D8/D10/D11 按优先级排期。

### 结论

ADR-029 的核心数据流（dev → merge 聚合 → test/review → cw 渐进式 → return）在**正常路径**下已闭环（4 维度审查 + 修复后）。但**异常/边界路径**存在 3 个 MUST_FIX 数据流断裂：

- **D1/D2**：worktree cwd 导致 cw db 路径隔离，防护仅靠 prompt（认知层），无机器强制——这是 ADR-029 自述的最大风险点（决策 3 关键设计点 1），代码层未落地防护。
- **D3**：merge 冲突时 review 审部分代码但 return 语义未标记，主 agent 可能误判 review 通过。

这 3 项是发布前（对应 CODE_REVIEW_REPORT 的「不可发布」结论）应补的数据流防护。其余 SHOULD_FIX/LOW 为可观测性/语义清晰度改进，不阻断当前 repo 内使用。
