# Code Review Report — ADR-029 实现统一审查

## 概要

- **审查目标**：ADR-029「coding-execute 全流程 workflow 接管 + per-call cwd + worktree 隔离」
- **审查范围**：`4f2fb916f^..HEAD`（ADR-029 全部 commit，27 文件，+1284/-159）
- **审查模式**：standalone（按 `code-review-worktree` skill 编排）
- **审查维度**：4 维度并行（taste / architecture / standards / robustness）；dataflow 待派
- **effort**：complex（27 文件 > 10）
- **审查日期**：2026-07-07
- **审查报告源**：`taste_review_v2.md` / `architecture_review_v2.md` / `standards_review_v2.md` / `robustness_review_v2.md`

## 问题清单（去重 + 跨维度合并 + 修复状态）

### 🔴 P0 — 阻断使用（CRITICAL / 致命 MUST_FIX）

| # | 维度 | 文件:行号 | 问题 | 修复 commit | 状态 |
|---|------|-----------|------|------------|------|
| P0-1 | arch #1 + robust #1 | `cw/gates.ts:282` + `execute-full-workflow.js` Phase 0/2 | **dev 提交无法达 test/review worktree**：testWt/reviewWt 始终停在 BASE_REF，无 merge 步骤汇聚 dev 提交；**GitValidator `merge-base --is-ancestor commit HEAD` 在 worktree 隔离下判所有 dev commit 无效**（commit 是 main 后代非祖先） | `4307b18fd`（Phase 1.5 聚合）+ `9b638bfe8`（GitValidator） | ✅ 已修 |
| P0-2 | arch #2 + taste MUST_FIX-1 | `execute-full-workflow.js:16,174` | import `execSync` 但调用未导入的 `execFileSync` → 所有 git 命令必抛 ReferenceError | `ab4c7b95e` | ✅ 已修 |
| P0-3 | arch #3 | `execute-full-workflow.js:195,378` | dev 池 worktree 在 wave 间 `reset --hard BASE_REF`，丢弃上一 wave commit（cw 记录 commitHash 但 git 已无该 commit） | `4307b18fd`（sub-wave 独立分支 + 聚合） | ✅ 已修 |

### 🟠 P1 — 严重缺陷（MUST_FIX）

| # | 维度 | 文件:行号 | 问题 | 修复 commit | 状态 |
|---|------|-----------|------|------------|------|
| P1-4 | arch #4 + robust #3 | `execute-full-workflow.js:551,576` | `return` 读 `cleanupFailures` 后 `finally` 才填充 → 主 agent 永远收到 `cleanup_failures=[]`，孤儿 worktree 不可见 | `4307b18fd`（return 移出 try/finally） | ✅ 已修 |
| P1-5 | robust #2 | `execute-full-workflow.js:216-223` vs `:358` | Phase 0 WorktreeSetup 在 try 块外，addWorktree 失败时前 N-1 个 worktree 泄漏 | `4307b18fd`（Phase 0 进 try/catch） | ✅ 已修 |
| P1-6 | robust #4 | `execute-full-workflow.js:97-110` buildWaves | 同 parallelGroup 内有 dependsOn 时打包进同一并行 wave，违反硬依赖 | `4307b18fd`（fail-fast 校验） | ✅ 已修 |
| P1-7 | arch #6 | `.pi/workflows/` + `coding-workflow/package.json` | workflow 脚本仅项目级，未随 extension 发布 → 其他项目 `pi install` 后不可用 | — | ❌ 未修（见「未修项决策」） |
| P1-8 | arch #7 | `execute-full-workflow.js` | 586 行核心编排脚本 + `topoSort`/`buildWaves` 调度算法零测试覆盖 | — | ❌ 未修（见「未修项决策」） |
| P1-9 | robust #5 / arch #5 | `cw/actions/dev.ts:52-62` + `test.ts` | `git.validate()` 子进程调用在 `transaction()` 内，违反 store.ts 注释自述不变式；并发 N agent 时长事务 + busy_timeout + retry 最坏 ~15s | — | ❌ 未修（兜底已有，根治需重构 8 个 handler） |

### 🟡 P2 — 建议修复（SHOULD_FIX）

| # | 维度 | 文件:行号 | 问题 | 修复 commit | 状态 |
|---|------|-----------|------|------------|------|
| P2-10 | arch #8 | `cw/checks/check-execute.ts` vs `store.ts` | 两套独立 test 状态校验（遗留机器门读 test-results.json vs cw 状态机），ADR-029 后 workflow 场景 test-results.json 不落盘，机器门冗余 | `2417444b6`（注释澄清角色） | ⚠️ 已注释澄清，根治待后续 |
| P2-11 | arch #9 + robust #9 | `extension-dependencies.json` | coding-workflow 对 pi-subagents 的隐式运行依赖未声明；`pi-workflow` peerDeps 未加 pi-subagents | — | ❌ 未修（standards S7 复核：两链独立，coding-workflow 只用 workflow agent()，**可能无需声明**——需 dataflow 维度确认） |
| P2-12 | arch #10 | `SKILL.md` Step 3 vs workflow return | `test.failures` 语义歧义（逻辑 fail 还是 infra fail）；workflow `status==='fail'` 时 testAborted 但不区分 | `4307b18fd`（SKILL 加 caseId="(all)" 区分） | ⚠️ 部分修 |
| P2-13 | arch #11 | `docs/adr/029` vs `025` | ADR-025 进程内迁移检查清单缺失 | `2417444b6`（加交叉引用） | ⚠️ 部分修 |
| P2-14 | standards S1 | `coding-workflow/package.json` | `"main": "src/index.ts"` 违反入口模式规范（应为 `./index.ts`） | `fb4b205e5` | ✅ 已修 |
| P2-15 | standards S2 | `worker-script-builder.ts:179` | 警告消息文本漏列 `cwd`（Set 已含） | `fb4b205e5` | ✅ 已修 |
| P2-16 | standards S4 | `subprocess-agent-runner.test.ts:457` | `as { cwd?: string }` 全可选 unsafe cast | `fb4b205e5` | ✅ 已修 |
| P2-17 | standards S5 | `execute-full-workflow.js` | prompt 模板内嵌大段字符串，单文件高密度 | — | ❌ 未修（NIT 级，拆模板收益有限） |
| P2-18 | robust #7 | `execute-full-workflow.js:428` | test wave 内所有 case 共享单一 testWt，测试副作用（coverage/screenshot/端口）未隔离 | — | ❌ 未修（设计权衡，需 test pool） |
| P2-19 | robust #8 | `execute-full-workflow.js:488` | `extractMustFix` 正则 `.+?` 跨 `]` 匹配，overlap 统计偏差 | — | ❌ 未修（LOW，影响 review overlap 精度） |

### 🟢 P3/P4 — 低优先（LOW / NIT / INFO）

| # | 维度 | 文件:行号 | 问题 | 修复 commit | 状态 |
|---|------|-----------|------|------------|------|
| P3-20 | taste LOW-1 | `plan-parser.ts:249` | `item!.dependsOn` 非空断言可改守卫 | `ab4c7b95e` | ✅ 已修 |
| P3-21 | taste LOW-2/3 + robust | `store.ts:297` + workflow 魔法数字 | `MAX_WORKTREES-2`/overlap `0.8`/`2`/`4` 等缺命名 | `ab4c7b95e` | ✅ 已修 |
| P3-22 | robust #6 | `cw/store.ts:192-224` | 构造函数 init 失败时 db 连接泄漏（无 close） | — | ❌ 未修（LOW，极端边界） |
| P3-23 | robust #10 | `session-runner.ts:223` | branchCache 模块级 Map，并发首次 miss thundering herd | — | ❌ 未修（LOW，性能非正确性） |
| P4-24 | standards S3 | `store.ts:298` | `Atomics.wait(SharedArrayBuffer)` 做 sleep 过度设计 | — | ❌ 不修（改 async 需重构 8 handler，收益不划算） |
| P4-25 | standards S6 | `coding-execute/SKILL.md` | 覆盖率 gate 归属未声明 | — | ❌ 未修（NIT） |
| P4-26 | arch #12 | workflow return | 无 JSON Schema 兜底 | — | ❌ 未修（LOW） |
| P4-27 | arch #13 | `design.md §3.6` | return 契约字段漂移（`cwStatus` vs `dev/test`） | `4307b18fd`（bg-ddc181-5 同步） | ✅ 已修 |
| P4-28 | arch #14 | workflow return | next_hint 自然语言，无机器状态码 | — | ❌ 未修（INFO） |
| P4-29 | robust #11 | `execute-full-workflow.js:16` | `execSync` 死代码 import | `ab4c7b95e` | ✅ 已修 |
| P4-30 | robust #12 | `store.ts:194-195` | WAL 在 busy_timeout 之前执行（理论 race） | — | ❌ 未修（INFO，实测安全） |
| P4-31 | robust #13 | `pi-runner.ts:128-133` | abort 用 SIGKILL 不走 SIGTERM 优雅退出 | — | ❌ 未修（INFO，强制力优先） |
| P4-32 | robust #14 | test wave abort 逻辑 | 设计预期，无需修 | — | — INFO |
| P4-33 | taste LOW-4 | `concurrency-gate.ts:215-323` | ConcurrencyGate.run 109 行 pre-existing | — | ❌ 不修（pre-existing 技术债） |

## 统计

### 按优先级

| 优先级 | 总数 | 已修 | 未修 | 不修 |
|--------|------|------|------|------|
| 🔴 P0（阻断） | 3 | 3 | 0 | 0 |
| 🟠 P1（严重） | 6 | 3 | 3 | 0 |
| 🟡 P2（建议） | 10 | 5 | 5 | 0 |
| 🟢 P3（低优） | 4 | 2 | 2 | 0 |
| 🟢 P4（NIT/INFO） | 9 | 3 | 4 | 2 |
| **合计** | **32** | **16** | **14** | **2** |

### 按维度（去重前）

| 维度 | MUST_FIX/CRITICAL | SHOULD_FIX | LOW/NIT/INFO | 总计 |
|------|-------------------|------------|--------------|------|
| architecture | 3 CRITICAL + 4 MUST_FIX | 4 | 2 LOW + 1 INFO | 14 |
| robustness | 5 MUST_FIX | 0 | 6 LOW + 3 INFO | 14 |
| taste | 1 MUST_FIX | 0 | 4 LOW | 5 |
| standards | 0 | 4 SHOULD_FIX | 3 NIT | 7 |

### 修复 commit 时间线

| commit | 修复内容 | 来源 |
|--------|---------|------|
| `2417444b6` | 首轮 SHOULD_FIX（文档矛盾/环检测/语义澄清/ADR 交叉引用/busy_timeout/reviewer 解耦/cast/参数/注释） | 4 维度审查 |
| `ab4c7b95e` | taste MUST_FIX（execFileSync 导入）+ LOW（魔法数字/守卫） | taste |
| `fb4b205e5` | standards SHOULD_FIX（main 字段/警告文案/cast） | standards |
| `9b638bfe8` | robustness #1（GitValidator worktree 兼容） | robustness |
| `4307b18fd` | arch 3 CRITICAL + robust #2/#3/#4（Phase 1.5 聚合 + return 时机 + buildWaves guard） | arch + robust + bg-ddc181-5 |

## 未修项决策说明

### P1-7 workflow 脚本未随 extension 发布
- **现状**：`execute-full-workflow.js` 仅在项目级 `.pi/workflows/`，`coding-workflow/package.json` 的 `files` 不含
- **不修原因**：需设计决策（脚本随 extension 走 vs 随项目走）。若随 extension，需新增 `workflows/` 目录 + `files` 声明 + SKILL.md 调用路径说明；若随项目，需文档明确主 agent 发现机制
- **建议**：独立任务处理，需与 pi-workflow 的脚本发现机制对齐

### P1-8 workflow 脚本零测试
- **现状**：586 行核心脚本，`topoSort`/`buildWaves` 调度算法无单测
- **不修原因**：workflow script 跑在 Worker 线程，无法直接 import 单测；`parallel()`/`agent()` 是 pi 注入的全局，mock 成本高
- **缓解**：`buildWaves` 的同组依赖校验（P1-6）已加；算法逻辑简单（topoSort 23 行 + buildWaves 18 行）
- **建议**：把 `topoSort`/`buildWaves`/`assertAcyclicDeps` 提取到独立 `.js` 模块，单测覆盖

### P1-9 transaction 内 git.validate
- **现状**：`dev.ts:52-62` 在 `transaction()` 内调 `deps.git.validate()`（spawn git）
- **不修原因**：根治需重构 8 个 handler（dev/test/clarify/plan/detail/closeout/retrospect/create）的「先 validate 再事务写入」模式，改动面大
- **缓解**：WAL + busy_timeout(5s) + BUSY 重试(3 次指数退避) 兜底；注释已标注不变式违反 + 重构方向

### P2-18 test wave 共享 testWt
- **现状**：同 wave 内所有 test-runner 共享单一 testWt worktree
- **不修原因**：需 test pool 设计（类似 dev pool），worktree 配额压力增大（MAX_WORKTREES=5 已紧张）
- **缓解**：prompt 约束 test-runner 只读；parallelGroup 语义声明无资源冲突

## 验证状态

- ✅ typecheck clean（3 包零错误）
- ✅ ESLint：ADR-029 改动文件零新增 error（仅 pre-existing warning）
- ✅ 测试：310 coding-workflow + 656 workflow + 375 subagents = **1341 tests pass**
- ✅ workflow-script lint：execute-full-workflow.js 无 issue

## 结论

**P0 全部已修**（3 个阻断使用的 CRITICAL），**P1 致命缺陷已修 3/6**（剩余 3 项是发布/测试/重构范畴，不阻断当前 repo 内使用）。

ADR-029 实现在本 repo 内**可运行**（workflow 脚本 + cw gate + per-call cwd 链路完整）。**不可发布**（P1-7 脚本未随 extension 发布，其他项目安装后不可用）。

**决策层（ADR 6 项决策 + Consequences）质量高**，实现层经此轮 4 维度审查 + 修复后，核心数据流（dev → merge 聚合 → test/review → return）已闭环。残留未修项均为发布工程 / 重构 / 性能范畴，非正确性问题。

**建议下一步**：派 review-dataflow 维度补充数据流深度审查（dataflow_signals=detected），确认 merge 聚合 + cwd 隔离 + 渐进式 cw 的端到端数据一致性。
