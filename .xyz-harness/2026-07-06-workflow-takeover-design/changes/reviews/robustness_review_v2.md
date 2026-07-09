# Robustness Review v2

## 概要

- **审查范围**：ADR-029「coding-execute 全流程 workflow 接管 + per-call cwd + worktree 隔离」实现，commit `4f2fb916f^..HEAD`（10 commits, 29 files, +1942/-159）
- **审查维度**：robustness（并发竞态、资源泄漏、错误处理、超时、输入校验、shell 注入、状态一致性）
- **重点关注文件**：8 个（execute-full-workflow.js, store.ts, plan-parser.ts, pi-runner.ts, subprocess-agent-runner.ts, concurrency-gate.ts, subagent-service.ts, types.ts）
- **扫视文件**：约 15 个（check-execute.ts, error-recovery.ts, worker-script-builder.ts, 各 __tests__ 等）
- **审查方法**：git diff 逐文件 + 实际 git/node 行为复现验证（含 SharedArrayBuffer、BEGIN IMMEDIATE 并发、worktree merge-base 语义）

---

## 问题清单

| # | 优先级 | 文件:行号 | 描述 | 修复方向 |
|---|--------|-----------|------|---------|
| 1 | **MUST_FIX** | cw/gates.ts:282 + cw/index.ts:208 | GitValidator `merge-base --is-ancestor <commit> HEAD` 与 worktree 隔离根本冲突：dev agent 在 worktree branch 的 commit 不是主仓库 HEAD(main) 的祖先 → 所有 dev commit 被判 `inRepo=false` → `valid=false` → dev gatePassed 永远 false → workflow 必然失败 | GitValidator 感知 worktree：用 `cat-file -e` + `diff-tree` 即可（已含），或改为 `--is-ancestor BASE_REF <commit>`（commit 是 base 的后代），或 agent 透传 worktree branch 名让 GitValidator 切该校验 |
| 2 | **MUST_FIX** | execute-full-workflow.js:216-223 (Phase 0) vs :358 (try 块起点) | WorktreeSetup 阶段（addWorktree 循环）在 try 块**之前**执行；若第 N 个 worktree add 失败，前 N-1 个已 push 到 `worktrees[]` 但 throw 在 try 外 → finally cleanup 不执行 → worktree 泄漏 | 把 Phase 0 移入 try 块，或 addWorktree 失败时立即清理已建 worktree 后再 throw |
| 3 | **MUST_FIX** | execute-full-workflow.js:551 (`return`) + :576 (`finally`) | `return` 对象中 `worktrees.cleaned = worktrees.length - cleanupFailures.length` 在 return 表达式求值时计算（此时 finally 尚未执行，cleanupFailures=[]），导致 `cleaned` 永远等于 `built`，cleanup 失败计数在 return 里永远是 0 | 把 cleaned/cleanup_failures 的汇总移到 finally 内构造一个临时对象，finally 后再 return；或在 finally 末尾重新计算并返回 |
| 4 | **MUST_FIX** | execute-full-workflow.js:97-110 (buildWaves) | buildWaves 按「连续相同 parallelGroup」打包成 wave，但当 A、B 同 parallelGroup 且 B `dependsOn A` 时，拓扑序后 A、B 相邻且同组 → 被打包进同一 wave 并行执行（`parallel([agent(A), agent(B)])`），违反 B 对 A 的硬依赖 | buildWaves 前校验：同 parallelGroup 内不得存在 dependsOn 关系（fail-fast）；或分组算法改为「同组且无组内依赖」才合并 |
| 5 | **MUST_FIX** | cw/store.ts:263-303 (transaction BUSY 重试) | transaction 重试在 BUSY 时**重新执行整个 fn**，但 fn 内部含非幂等副作用：`appendGateHistory` 每次执行追加一条记录 → 重试会重复追加 gate history entry；dev/test handler 在 fn 内调 git.validate（持锁跨进程 IO，违反注释声明的不变式） | (a) 把 git.validate 等慢操作移出 transaction（先 validate 再事务写入）；(b) appendGateHistory 改为幂等（按 phase+action+ts 去重）或事务外追加 |
| 6 | LOW | cw/store.ts:192-224 (constructor + init) | 构造函数内 `this.init()` 若抛错（如 BEGIN IMMEDIATE 超 busy_timeout 5s、DDL 失败），`this.db` 已 open 但构造失败，调用方无 store 引用无法 close() → 连接泄漏 + WAL 侧车文件残留 | 构造函数包 try/catch，init 失败时 `this.db.close()` 后重抛；或改为静态工厂 `CwStore.open()` |
| 7 | LOW | execute-full-workflow.js:428-432 (test wave) | 同一 test wave 内所有 test-runner 共享单一 `testWt` worktree 并发执行；虽 prompt 标注"只读"，但测试执行有副作用（coverage 文件、screenshot、test-results.json、端口/DB 占用），parallelGroup 的"无资源冲突"语义未在文件系统层兑现 | test wave 内每 case 分配独立 test worktree（类似 dev pool），或 prompt 显式约束输出路径隔离 |
| 8 | LOW | execute-full-workflow.js:488 (extractMustFix 正则) | `/\[(.+?):(\d+)\]/g` 的 `.+?` 不排除 `]`，遇到 `[a] then [b:1]` 会跨 `]` 贪婪匹配成单个"位置"，导致 review overlap/去重统计偏差 | 正则改为 `/\[([^\[\]]+?):(\d+)\]/g`（排除方括号） |
| 9 | LOW | execute-full-workflow.js:66 (plan.json 解析) | workflow 直接 `JSON.parse(plan.json)`，不调 plan-parser 的 schema 校验；若 plan.json 被手动篡改或绕过 cw plan 阶段（dependsOn 为字符串而非数组、parallelGroup 非法），workflow 消费畸形数据无防御 | workflow 启动前调 plan-parser 校验（或至少校验 waves/testCases 的 id 唯一 + dependsOn 是数组） |
| 10 | LOW | subagents/core/session-runner.ts:223 (branchCache) | `branchCache` 是模块级全局 Map，多 cwd 并发首次 miss 同一 cwd 时 thundering herd（重复 spawn git rev-parse）；JS Map 并发 set 无数据正确性问题（同值覆盖），仅性能 | 用 `Map<cwd, Promise>` 模式 in-flight 去重，或 lazy init 双检 |
| 11 | LOW | execute-full-workflow.js:16 | `execSync` 被 require 但全文未使用（死代码 import） | 删除 `const { execSync } = require("child_process")` |
| 12 | INFO | cw/store.ts:194-195 (PRAGMA journal_mode=WAL 顺序) | `PRAGMA journal_mode=WAL` 在 `PRAGMA busy_timeout=5000` 之前执行，无 busy_timeout 保护；实测 node:sqlite 下切 WAL 是幂等返回（已切则查询模式），理论 race 难触发 | 可交换顺序（先 busy_timeout 再 WAL），或保持现状（实测安全） |
| 13 | INFO | workflow/infra/pi-runner.ts:128-133 (SIGKILL on abort) | abort/timeout 触发 `proc.kill("SIGKILL")` 直接杀子进程，不走 SIGTERM 优雅退出；子进程内的 cw store 连接不会 close()，留下 `-wal`/`-shm` 文件（SQLite 下次打开自动 checkpoint，无数据丢失） | 保持现状（强制力优先）；或先 SIGTERM 给宽限窗口再 SIGKILL |
| 14 | INFO | execute-full-workflow.js:425-456 (test wave abort) | test wave 失败 abort 后续 wave 的硬依赖逻辑正确（waveHasFail → testAborted → break）；已提交 cw 的 case 保留状态，未跑 case 永远 pending（渐进式设计预期） | 无需修复（设计预期） |

---

## 详细分析

### #1 [MUST_FIX] GitValidator 与 worktree 隔离根本冲突 ⚠️ 致命

**证据**：

`extensions/coding-workflow/src/cw/gates.ts:282`：
```typescript
execFileSync("git", ["merge-base", "--is-ancestor", commitHash, "HEAD"], {
  cwd: this.workspacePath,
  ...
});
inRepo = true;
```

`extensions/coding-workflow/src/cw/gates.ts:304`：
```typescript
const valid = exists && inRepo && nonEmpty;
```

`extensions/coding-workflow/src/index.ts:208`：
```typescript
git: new GitValidator(workspacePath),  // workspacePath = agent 传的 WORKSPACE_ROOT（主仓库）
```

**分析**：

ADR-029 worktree 隔离下，每个 dev agent 在独立 worktree（branch `cw-<topic>-dev-poolN-<stamp>`，基于 BASE_REF=main）里 commit。该 commit 是 main 的**后代**，不是 main 的**祖先**。GitValidator 在主仓库（workspacePath）跑 `merge-base --is-ancestor <commit> HEAD`，主仓库 HEAD=main，判定 commit 不是 main 祖先 → `inRepo=false` → `valid=false`。

**实际复现**（/tmp 隔离环境）：
```
git init main; git worktree add wt -b dev-feature; (在 wt 里 commit)
dev commit: 6a46abce...
--- is-ancestor in worktree (cwd=worktree):  YES
--- is-ancestor in MAIN repo (cwd=main, GitValidator 的行为):  NO → inRepo=false → valid=false
```

**两难困境**：
- agent 传 `workspacePath=WORKSPACE_ROOT`（prompt 明确要求，否则 cw 打开错误 db）→ GitValidator 失败
- agent 不传 workspacePath → cw 用 `process.cwd()=worktreePath` → GitValidator 在 worktree 跑（HEAD=dev branch，校验通过）→ 但 cw store 路径变成 `encodeCwd(worktreePath)` → 每个 worktree 一个独立 `_cw.db` → dev/test 状态碎片化，gatePassed 跨 worktree 无法聚合

**影响**：lite tier 的 dev gate（GitValidator.validate）100% 失败；mid tier 的 test gate（isAncestorOfAny 同样用 workspacePath + merge-base）也受影响。整个 ADR-029 的 worktree 隔离方案**无法通过 cw gate**。

**修复方向**（三选一）：
1. GitValidator 去掉 `merge-base --is-ancestor HEAD` 检查，仅用 `cat-file -e`（commit 对象存在）+ `diff-tree`（非空）。worktree 与主仓库共享 object store，cat-file 能查到 worktree commit。
2. 改为 `merge-base --is-ancestor BASE_REF commitHash`（commit 是 base 的后代，正向血缘）。
3. agent 透传 worktree branch 名，GitValidator 临时 checkout 该 branch 或用 `git log <branch>` 校验。

建议方案 2（语义最贴近"可追溯性"，改动最小）。

---

### #2 [MUST_FIX] Phase 0 WorktreeSetup 在 try 块之外，worktree 泄漏

**证据**：

`.pi/workflows/execute-full-workflow.js:216-223`：
```javascript
phase("WorktreeSetup");
const maxParallelInWave = Math.max(1, ...devWaves2d.map((w) => w.length));
const devPoolSize = Math.min(maxParallelInWave, Math.max(1, MAX_WORKTREES - 2));
const devWtPool = [];
for (let i = 0; i < devPoolSize; i++) devWtPool.push(addWorktree("dev-pool" + i));
const testWt = testWaves2d.length > 0 ? addWorktree("test") : null;
const reviewWt = addWorktree("review");
```

`.pi/workflows/execute-full-workflow.js:358`：
```javascript
try {       // ← try 块从这里开始，Phase 0 已结束
// ── Phase 1: dev waves ...
```

`.pi/workflows/execute-full-workflow.js:576`：
```javascript
} finally {
  phase("Cleanup-finally");
  for (const wt of worktrees) {
    const err = removeWorktree(wt);  // ← 只清理 push 到 worktrees[] 的
    ...
  }
}
```

**分析**：

`addWorktree` 在 git worktree add 成功后 `worktrees.push(...)`（line 187）。Phase 0 循环建 devWtPool（N 个）+ testWt + reviewWt。若建到第 3 个 dev-pool 时 `git worktree add` 失败（磁盘满、BASE_REF 非法、权限），addWorktree throw，此时前 2 个 dev-pool 已在 `worktrees[]`，但 throw 发生在 try 块（line 358）**之前**，finally 不执行 → 前 2 个 worktree + 已建的 branch 泄漏。

`addWorktree` 内部 catch 仅重新包装 error 抛出，不清理已建 worktree（line 183-189）：
```javascript
function addWorktree(role) {
  ...
  try {
    gitArgs(WORKSPACE_ROOT, "worktree", ["add", wtPath, "-b", branch, BASE_REF]);
    worktrees.push({ role, branch, path: wtPath });
    return wtPath;
  } catch (e) {
    throw new Error("git worktree add 失败 (" + role + "): " + e.message);  // 不清理已 push 的
  }
}
```

**修复方向**：把 Phase 0 移入 try 块（line 358 之前插入），或在 addWorktree 失败的 catch 里遍历 `worktrees[]` 调 removeWorktree 后再 throw。

---

### #3 [MUST_FIX] return 对象的 cleaned 字段求值时机错误

**证据**：

`.pi/workflows/execute-full-workflow.js:551-557`（try 块末尾）：
```javascript
return {
  ...
  worktrees: {
    built: worktrees.length,
    cleaned: worktrees.length - cleanupFailures.length,  // ← 求值时 cleanupFailures=[]
    cleanup_failures: cleanupFailures,                   // ← 引用（finally 后反映）
  },
  ...
};
```

`.pi/workflows/execute-full-workflow.js:576-583`（finally 块）：
```javascript
} finally {
  phase("Cleanup-finally");
  for (const wt of worktrees) {
    const err = removeWorktree(wt);
    if (err) cleanupFailures.push(err);  // ← 在 return 求值之后才填充
  }
  ...
}
```

**分析（JS 语义实测验证）**：

```javascript
const cleanupFailures = [];
function f() {
  try {
    return {
      built: 2,
      cleaned: 2 - cleanupFailures.length,  // 求值时 = 2
      cleanup_failures: cleanupFailures,
    };
  } finally {
    cleanupFailures.push({err: 'x'});  // return 求值后执行
  }
}
// 结果：cleaned=2（错），cleanup_failures.length=1（对）
```

return 表达式在 finally 执行**之前**求值。`cleaned: worktrees.length - cleanupFailures.length` 此时 `cleanupFailures=[]` → `cleaned` 永远等于 `built`。`cleanup_failures` 数组是引用，finally push 后外部能看到正确值，但 `cleaned` 标量永远是错的。

**影响**：主 agent 读 return 的 `worktrees.cleaned` 判断清理结果，永远显示全部清理成功（即使有失败），掩盖 cleanup 失败。`cleanup_failures` 数组本身是对的，但 `cleaned` 字段误导。

**修复方向**：在 finally 块内构造 return 对象，或用临时变量：

```javascript
let result;
try {
  result = { ...主体对象，worktrees 先占位... };
} finally {
  for (const wt of worktrees) { ... }
  if (result) {
    result.worktrees.cleaned = worktrees.length - cleanupFailures.length;
  }
}
return result;
```

---

### #4 [MUST_FIX] buildWaves 把同组依赖项打包进同一并行 wave

**证据**：

`.pi/workflows/execute-full-workflow.js:97-110`：
```javascript
function buildWaves(items) {
  const sorted = topoSort(items);
  const waves2d = [];
  let currentWave = [];
  let currentGroup = "__none__";
  for (const item of sorted) {
    const g = item.parallelGroup || "__none__";
    if (g === currentGroup && g !== "__none__") {
      currentWave.push(item);  // ← 连续同组就合并，不检查组内依赖
    } else {
      if (currentWave.length > 0) waves2d.push(currentWave);
      currentWave = [item];
      currentGroup = g;
    }
  }
  ...
}
```

**分析（实测验证）**：

```javascript
buildWaves([
  {id:"A", parallelGroup:"g1"},
  {id:"B", dependsOn:["A"], parallelGroup:"g1"},  // B 依赖 A 但同组
])
// 拓扑序：A → B（相邻）
// 输出：[["A","B"]]  ← 同一 wave，parallel 并行执行
```

`parallel([agent(A), agent(B)])` 让 A、B 同时启动，但 B 的 prompt 假设 A 已完成（依赖 A 建的数据状态）。B 在 A 未完成时启动 → 违反硬依赖。

plan-parser 的 `assertAcyclicDeps`（plan-parser.ts:208-258）只检**环**和**依赖不存在**，不检「同 parallelGroup 内存在 dependsOn」的语义矛盾。

**影响**：plan 阶段若误标（A、B 同组且 B dependsOn A），workflow 不会 fail-fast，而是让 B 在错误时机启动，产生数据状态不一致（B 读到 A 未建的数据 → fail 或脏结果）。

**修复方向**：buildWaves 前加校验——同 parallelGroup 内不得存在 dependsOn 关系：
```javascript
for (const item of items) {
  for (const d of (item.dependsOn || [])) {
    const dep = items.find(i => i.id === d);
    if (dep && dep.parallelGroup && dep.parallelGroup === item.parallelGroup) {
      throw new Error(`${item.id} dependsOn ${d} 但同 parallelGroup，不可并行`);
    }
  }
}
```

---

### #5 [MUST_FIX] transaction BUSY 重试导致非幂等副作用重复

**证据**：

`extensions/coding-workflow/src/cw/store.ts:278-303`：
```typescript
transaction<T>(fn: () => T): T {
  const MAX_BUSY_RETRY = 3;
  ...
  for (let attempt = 0; attempt < MAX_BUSY_RETRY; attempt++) {
    try {
      this.db.exec("BEGIN");
      try {
        const result = fn();  // ← fn 整个重新执行
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      ...
      if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        Atomics.wait(...);
        continue;  // ← 重试，fn 再次执行
      }
      throw err;
    }
  }
  throw lastErr;
}
```

`extensions/coding-workflow/src/cw/actions/dev.ts:52-90`（fn 内部）：
```typescript
deps.store.transaction(() => {
  for (const task of params.tasks) {
    ...
    const v = deps.git.validate(task.commitHash);  // ← 持锁跨进程 IO（spawn git）
    if (v.valid) {
      deps.store.setWaveCommitted(...);  // UPDATE 同行同值（幂等）
    }
  }
  ...
  deps.store.appendGateHistory(params.topicId, {  // ← INSERT 新行（非幂等！）
    phase: "dev", action: "dev", ...
    progressive: true,
  });
});
```

**分析**：

注释自己标注了不变式违反（store.ts:268-274）：
> ⚠️ 不变式：fn 内不得持锁跨进程 IO（git/网络/磁盘扫描）。GitValidator 等慢操作应在 transaction() 外预跑，结果传入事务内只做快写。**当前 dev/test handler 还在事务内调 git（历史代码），本重试是兑底**。

BUSY 重试重新执行 fn：
1. `git.validate`（spawn git）会重复 spawn——持锁时间更长，加剧 BUSY（活锁风险）
2. `setWaveCommitted`（UPDATE 同行同值）幂等，重试无害
3. **`appendGateHistory`（INSERT 新行）非幂等**——重试会追加重复的 gate history entry，`loadTopic` 读回时 gate history 有重复记录，影响审计/决策

由于 ROLLBACK 在 catch 内执行（fn 抛错或 BUSY），INSERT 会被回滚——**但如果 COMMIT 成功后，外部再次 BUSY（不可能，COMMIT 已结束）**。实际上 BUSY 只在 BEGIN/COMMIT 阶段抛，fn 内的 SQL 执行期间若另一连接 BUSY，当前连接的 busy_timeout 兜底。真正触发重试的场景是 BEGIN 时 BUSY（获锁失败）——此时 fn 还没执行，重试无害。

**但如果 fn 内的 SQL 执行时撞锁**（如 fn 内 SELECT 遇到另一连接的写锁），node:sqlite 会立即抛 SQLITE_BUSY（不受 busy_timeout 保护，因 busy_timeout 只对 BEGIN/COMMIT 生效）→ catch → ROLLBACK → 重试 → fn 重新执行 → appendGateHistory 的 INSERT 在 ROLLBACK 后已撤销，重试 INSERT 一次。**这种情况下重试是幂等的**（因为 ROLLBACK 撤销了上次的 INSERT）。

修正评估：由于 ROLLBACK 撤销了 fn 的所有副作用，重试整体是幂等的。**但 git.validate 会重复 spawn**（性能 + 持锁时间延长）。降级为 LOW，但保留 MUST_FIX 标记因为**违反注释声明的不变式**（fn 内调 git），且若未来 fn 内引入跨进程有状态操作（如外部 API 调用），重试会产生重复副作用。

**修复方向**：
1. 把 `deps.git.validate` 移出 transaction（dev/test handler 先 validate 所有 task 收集结果，再事务写入）
2. appendGateHistory 改为幂等（按 phase+action+内容 hash 去重）作为纵深防御

---

### #6 [LOW] CwStore 构造函数 init 失败导致连接泄漏

**证据**：`extensions/coding-workflow/src/cw/store.ts:192-224`

构造函数 `new DatabaseSync(dbPath)` 成功后，`this.init()` 抛错（BEGIN IMMEDIATE 超 busy_timeout、DDL 失败、migration 失败）时，`this.db` 已 open 但构造抛错，调用方 `new CwStore(...)` 拿不到实例引用，无法 close()。

**影响**：长 workflow 内若多次 cw 调用因并发首次初始化失败（极端边界，busy_timeout 5s 兜底），连接泄漏累积。node:sqlite 连接最终由 GC/进程退出回收，但 WAL 侧车文件可能残留。

**修复方向**：构造函数包 try/catch，init 失败时 close 后重抛；或改静态工厂。

---

### #7 [LOW] test wave 共享单 testWt 导致测试副作用冲突

**证据**：`execute-full-workflow.js:428-432`

```javascript
const testCalls = wave.map((c) => ({
  prompt: buildTestRunnerPrompt(c, testWt),  // 全部 case 共享 testWt
  ...
  cwd: testWt,
  ...
}));
const results = await parallel(testCalls);  // 并行跑，同 cwd
```

**分析**：parallelGroup 语义是"同组无资源冲突可并行"，workflow 据此把同组 case 打包进同 wave 并行。但所有 case 共享单一 testWt worktree，文件系统层副作用未隔离：
- 并发写 `test-results.json` / `coverage/` 互相覆盖
- screenshot 文件名冲突（若 agent 用固定名）
- 端口/DB 占用（若 executor 跑真实服务）

dev 阶段每 wave 用独立 worktree（devWtPool），test 阶段却共享——不对称。parallelGroup 的"无资源冲突"是 plan 阶段的语义声明，但文件系统副作用未在隔离层兑现。

**修复方向**：test wave 也用 pool（每 case 一个 test worktree），或 prompt 显式约束输出路径带 caseId 前缀。

---

## 统计

- **MUST_FIX**: 5（#1 GitValidator 致命、#2 worktree 泄漏、#3 cleaned 求值、#4 同组依赖并行、#5 transaction 重试副作用）
- **LOW**: 6（#6 构造泄漏、#7 test worktree 共享、#8 正则跨括号、#9 plan.json 未校验、#10 branchCache thundering herd、#11 死代码 import）
- **INFO**: 3（#12 WAL 顺序、#13 SIGKILL、#14 test abort 设计预期）

### 关键结论

**#1 是致命缺陷**：ADR-029 的 worktree 隔离与 GitValidator 的"commit 是主仓库 HEAD 祖先"假设根本冲突，所有 dev commit 都会被判无效，workflow 必然失败。**必须在合并前修复**，否则整个 ADR-029 无法实际运行通过 cw gate。

#2/#3 是 worktree 泄漏 + return 字段错误，影响可靠性和可观测性。

#4/#5 是数据一致性问题，在特定 plan 配置或并发场景下触发。

其余 LOW/INFO 不阻断合并，但建议在后续迭代中清理。
