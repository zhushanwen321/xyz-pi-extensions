# 代码规范审查报告（review-standards 维度）— ADR-029 实现

**审查目标**：ADR-029「coding-execute 全流程 workflow 接管 + per-call cwd + worktree 隔离」
**基准点**：`4f2fb916f^`（ADR-029 第一个 commit 的父提交）
**审查范围**：27 个文件，+1284 / -159 行（10 commits）
**审查基准**：`AGENTS.md`（Pi Extension 开发规范）+ `docs/standards.md` 引用集
**审查日期**：2026-07-07

---

## 一、问题汇总表

| # | 级别 | 类别 | 文件 | 问题 |
|---|------|------|------|------|
| S1 | ⚠️ SHOULD_FIX | H.安装红线/包结构 | `extensions/coding-workflow/package.json` | `"main": "src/index.ts"` 违反「main 应为 `./index.ts`」的入口模式（虽 `pi.extensions` 正确为 `["./index.ts"]`，但 main 字段指向 src/ 与规范不一致） |
| S2 | ⚠️ SHOULD_FIX | B.TypeScript/资源自包含 | `.pi/workflows/execute-full-workflow.js:179` | `worker-script-builder` 的 `_knownFields` 警告**消息文本**漏列 `cwd`（`_knownFields` Set 已含 cwd，功能正确，但警告文案与 Set 不一致会误导） |
| S3 | 💡 NIT | B.TypeScript/代码风格 | `extensions/coding-workflow/src/cw/store.ts:298` | 用 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), ...)` 做 sleep 属过度设计——Node 主线程无 worker 隔离需求，idiomatic 应是 `await new Promise(r => setTimeout(r, backoff))` 或 `timers/promises.setTimeout`。触发 `no-magic-numbers`（2/4） |
| S4 | ⚠️ SHOULD_FIX | B.TypeScript/unsafe-cast | `extensions/workflow/src/infra/__tests__/subprocess-agent-runner.test.ts:457` | `mockSpawn.mock.calls[0]![2] as { cwd?: string }` 全可选属性结构断言——taste/no-unsafe-cast warn（任何对象都能通过，等于无校验）。测试代码可接受，但违反「类型守卫或必填字段」规范 |
| S5 | ⚠️ SHOULD_FIX | C.文件行数/函数行数 | `.pi/workflows/execute-full-workflow.js` | `buildTestRunnerPrompt`（约 50 行）+ `buildReviewPrompt`（约 25 行）内嵌大段字符串字面量；整个脚本 586 行虽未破 1000 行，但属单文件高密度（建议拆 prompt 模板到独立 .js 数据文件） |
| S6 | 💡 NIT | I.SKILL.md 一致性 | `extensions/coding-workflow/skills/coding-execute/SKILL.md` | 删除了「覆盖率 gate ≥60%」自检项，但未在同 skill 或 execution-flow.md 明确「覆盖率 gate 现由 workflow 内 implementer 负责」——若覆盖率 gate 仍存在，文档应说明其归属；若砍除应显式声明 |
| S7 | 💡 NIT | E.依赖管理 | `extension-dependencies.json` | ADR-029 后 coding-workflow 的 `execute-full-workflow.js` 强依赖 `pi-workflow` 的 `agent({cwd})` 能力，而 `pi-subagents` 的 `cwd` 是独立能力。`coding-workflow → pi-workflow (runtime)` 已声明，正确。**但** workflow 脚本运行时依赖 subagents 的 cwd 能力吗？——不依赖（两条链独立，coding-workflow 只用 workflow 的 agent()），无需声明。当前声明正确，此项为「已核对正确」记录 |

**问题统计**：⚠️ SHOULD_FIX = 4（S1/S2/S4/S5），💡 NIT = 3（S3/S6/S7）
**MUST_FIX = 0**，**零类型错误**，**零 lint error**，**全部测试通过**（311 + 656 + 375 = 1342 tests passed）。

---

## 二、逐项审查结论

### A. Pi Extension 开发规范

#### A1. 包结构 + 入口模式 ✅（1 处不一致，见 S1）

| 检查项 | coding-workflow | workflow | subagents | 结论 |
|--------|----------------|----------|-----------|------|
| `index.ts` 只 re-export `src/index.ts` | ✅ `export { default } from "./src/index.ts"` | ✅ | ✅ | 通过 |
| `pi.extensions = ["./index.ts"]` | ✅ | ✅ | ✅ | 通过 |
| `"type": "module"` | ✅ | ✅ | ✅ | 通过 |
| `"keywords": ["pi-package"]` | ✅ | ✅ | ✅ | 通过 |
| `pi.skills` 声明（有 skills 目录） | ✅ `["./skills"]` | ✅ `["./skills"]` | N/A（无 skills） | 通过 |
| `"main"` 字段 | ⚠️ `"src/index.ts"`（S1） | ✅ `"index.ts"` | ✅ `"index.ts"` | 见 S1 |
| `files` 含资源文件 | ✅ `src/ index.ts lib/ skills/ mocks/` | ✅ | ⚠️ 见下方分析 | 见下 |

**S1 分析**：`coding-workflow/package.json` 的 `"main": "src/index.ts"` 与 AGENTS.md「顶层 index.ts re-export src/index.ts，确保 Pi 扩展加载列表统一显示纯包名」的精神不一致。`pi.extensions` 是 Pi 加载入口（正确指向 `./index.ts`），`main` 是 Node 解析入口（指向 src/）。功能上不阻断（Pi 用 pi.extensions 不用 main），但破坏「单一入口模式」的一致性。`workflow` 和 `subagents` 的 main 都正确指向 `index.ts`，唯独 coding-workflow 指向 src/——历史遗留，本次 ADR-029 未改。**建议**：main 改为 `"./index.ts"` 统一。

**subagents `files` 字段分析**：列出 `src/index.ts src/types.ts src/core/ src/runtime/ src/tui/ src/tools/ src/commands/`——**未列 `src/__tests__/`**（正确，测试不进 npm 包）；但 ADR-029 在 `src/__tests__/execute-integration.test.ts` 新增了 cwd 契约测试，该测试不打包（正确）。`files` 完整覆盖运行时所需文件，通过。

**selftest_check_execute.py 资源自包含**：该 .py 在 `skills/coding-execute/scripts/`，`files` 含 `skills/` 整目录，打包后随 npm 分发。✅ 资源自包含合规。

#### A2. Tool 设计 ✅

| 检查项 | 结论 |
|--------|------|
| typebox `Type.Object()` + `StringEnum()` | subagents 的 `SubagentParams.startParam.cwd` 用 `Type.Optional(Type.String({description}))` ✅（cwd 是自由字符串路径，非枚举，合理） |
| `execute` 返回 `{content, details}` | 本次未改 tool execute 签名，仅改 schema 字段 ✅ |
| 错误用 `throw new Error()` | workflow 脚本全程 `throw new Error(...)`（缺参数/解析失败/git 失败）✅；store.ts `transaction` 重试耗尽 `throw lastErr` ✅ |
| schema 必填在所有执行模式必填 | `cwd` 是 Optional（缺省回退 service.cwd），向后兼容 ✅ |

**`subagent-tool.ts` 的 `cwd` schema description 质量高**：明确说明「Overrides the session default cwd / Different cwds get independent session directories」，符合「schema description 是 AI 决策依据」的规范。

#### A3. SDK 接口契约 ✅

**核心契约验证**（ADR-029 改动 3 个包的 SDK 调用链）：

1. **`SessionRunnerContext.cwd` → `createAgentSession` 链路**（subagents）：
   - `subagent-service.ts:556` `cwd: opts?.cwd ?? this.cwd` 正确覆盖 ctx.cwd
   - `session-runner.ts:282-288` `createAgentSession({cwd: ctx.cwd, ...})` + `SessionManager.create(ctx.cwd, subagentSessionDir)` + `getSubagentSessionDir(ctx.agentDir, ctx.cwd)` 全链路用 ctx.cwd ✅
   - **ExtensionHandler 签名**：未改动 handler，不受影响 ✅
   - **ctx vs event**：cwd 从 `this.cwd`（service 进程级）来，不从 event ✅

2. **`runPiProcess` 签名重构**（workflow）：从位置参数 `(command, cmdArgs, pipeline, signal?, env?, onEvent?)` 改为对象参数 `RunPiProcessOptions`。**两处调用方同步更新**：
   - `subprocess-agent-runner.ts:80` 传 `cwd: opts.cwd` ✅
   - `concurrency-gate.ts:263` 传 `cwd: opts.cwd` ✅
   - 无遗漏调用方（typecheck 通过证实）✅

3. **`AgentCallOpts.cwd`**（workflow `models/types.ts`）：新增 `cwd?: string` 字段，完整 JSDoc 说明「传给 child_process.spawn 的 cwd option」✅

**契约测试覆盖**（AGENTS.md 要求「新增/修改 SDK 调用必须有契约测试」）：
- `subprocess-agent-runner.test.ts` 新增 2 个 cwd 透传测试（缺省→undefined / 显式→worktree）✅
- `execute-integration.test.ts` 新增 3 个 cwd 透传测试（缺省→service.cwd / 显式→worktree / 并发无串扰）✅

**契约测试质量**：subagents 测试用 `Object.assign(sdk, { createAgentSessionMock })` 暴露 mock 供断言，注释说明「不污染 SdkLike 接口形状」——设计干净。

#### A4. Session 隔离 ✅（关键正确性验证）

**ADR-029 最关键的隔离断言**：cw store 是全局文件（非 session 内存），per-call cwd 不串扰。

验证：
- cw store 路径：`~/.pi/agent/cw/<encoded-cwd>/_cw.db`（基于 workspacePath 解码），**按 cwd 隔离** ✅
- workflow 内 agent 的 cwd 是 worktree 路径（如 `/project/.cw-wt/cw-dev-.../`），若 agent 不显式传 `workspacePath=<项目根>` 给 cw tool，cw 会用 `process.cwd()`（worktree 路径）编码出错误的 db 路径
- **ADR-029 的缓解**：workflow prompt 模板（`buildImplementerPrompt` / `buildTestRunnerPrompt`）硬编码注入 `workspacePath=" + WORKSPACE_ROOT + "`，且 prompt 多次强调「⚠️ workspacePath 必须传项目根」✅
- **残留风险**：依赖 AI agent 遵守 prompt 指令传 workspacePath——这是认知层约束，不是机器层强制。若 agent 漏传，会静默写错 db（worktree 路径对应的空 db），cw gate 读不到正确数据。**这是 ADR-029 的已知设计风险**（Open question 6 已记录），非规范违规

**subagents branchCache 按 cwd 隔离**：`Map<cwd, branch>` 已按 cwd 缓存，多 cwd 并发安全（ADR-029 决策 1 已论证，types.ts:361 注释说明）✅

**模块级 `let` 共享状态**：本次改动**未新增**模块级可变状态。`execute-full-workflow.js` 的 `const worktrees = []` / `const devFailures = []` 等是脚本级常量（每次 `workflow run` 新起 Worker 线程，天然隔离），非 extension 进程级 `let`。✅

#### A5. 状态持久化 ✅（store.ts 改动质量高）

**ADR-029 决策 6 的 store 改动**（WAL + busy_timeout + 并发初始化防护）：

1. **WAL + busy_timeout**（store.ts:194-195）：
   ```typescript
   this.db.exec("PRAGMA journal_mode=WAL");
   this.db.exec("PRAGMA busy_timeout=5000");
   ```
   在 `init()` **之前**执行，DDL 也受 WAL 保护 ✅（注释明确「必须在任何业务 SQL 之前执行」）

2. **并发首次初始化竞态防护**（store.ts:206-220）：用 `BEGIN IMMEDIATE` 串行化并发 init，幂等 check-then-add 的 TOCTOU 被「获写锁后重读 user_version」化解 ✅。**这是 robustness review 发现的 MUST_FIX 已修复**，质量高。

3. **transaction SQLITE_BUSY 重试**（store.ts:268-296）：3 次指数退避（200/400/800ms），只重试 `SQLITE_BUSY` / `database is locked`，其他错误直接抛 ✅。注释明确「不变式：fn 内不得持锁跨进程 IO」——诚实标注当前 dev/test handler 仍在事务内调 git（历史代码），本重试是兜底。

4. **向后兼容**（store.ts:425-426）：`dependsOn` 缺省回退 `[]`，`parallelGroup` 缺省回退 `undefined`。旧库迁移后 NULL → 默认值。测试覆盖（store.test.ts 新增 round-trip + 缺省回退测试）✅

5. **GC**：本次未新增 entries 累积（cw store 用关系表不用 appendEntry，自管 SQLite 生命周期）✅

**唯一风格瑕疵**（S3）：`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff)` 用 SharedArrayBuffer 做 sleep 是过度设计。Node 主线程无 cross-origin-isolation 需求，`await new Promise(r => setTimeout(r, backoff))` 更 idiomatic。已验证 Atomics.wait 在主线程可用（功能正确），仅风格问题。

#### A6. 资源自包含 ✅

- `selftest_check_execute.py` 在 `skills/coding-execute/scripts/`，`files` 含 `skills/` ✅
- workflow 脚本在 `.pi/workflows/`（项目级，非 extension 内）——这是 workflow 脚本的正确归属（由 `pi-workflow` 加载，不打包进任何 extension）✅
- 无引用扩展目录外的绝对路径 ✅

#### A7. 运行环境约束 ✅

| 扩展 | 原生模块使用 | 规范符合 |
|------|-------------|---------|
| coding-workflow | `node:sqlite`（DatabaseSync）— fs 之内 | ✅ |
| workflow | `child_process.spawn`（pi-runner）— **已知例外**（AGENTS.md 明示 workflow 通过 spawn 起 pi 子进程） | ✅ |
| subagents | 进程内 `createAgentSession()`，不 spawn；仅 `execFileSync("git", ...)` 只读 | ✅ |
| execute-full-workflow.js | `require("fs")` + `require("child_process").execFileSync`（git worktree add/remove/reset/clean） | ✅ workflow Worker 线程内允许 |

**workflow 脚本的 git 调用安全性**：`gitArgs()` 用 `execFileSync("git", [...], {shell: false})`——shell:false 避免路径/ref 注入 ✅。注释明确「所有 git 调用走 execFileSync（shell:false），避免路径/ref 含空格或特殊字符的注入风险」。

#### A8. TUI 渲染 ✅（本次无 TUI 改动）

ADR-029 改动不涉及 renderCall/renderResult，无 TUI 渲染规范问题。

#### A9. _render 协议（已废弃）✅

本次改动**未新增任何 `_render` 字段**。`workflow/src/interface/helpers.ts` 的遗留 `_render` 用法是 ADR-029 之前就存在的（AGENTS.md 已标记为「现有实现作为遗留代码保留」），非本次引入。✅

---

### B. TypeScript 规范

#### B10. 禁止 any ✅

本次改动**零 `any`**（typecheck + eslint 均通过，`no-explicit-any: error` 未触发）。

#### B11. unsafe cast ⚠️（1 处，S4）

- **`subprocess-agent-runner.test.ts:457`**：`mockSpawn.mock.calls[0]![2] as { cwd?: string }`——全可选属性结构断言，taste/no-unsafe-cast warn。**测试代码可接受**（mock 调用参数形状已知），但违反规范「改用类型守卫或必填字段」。
- **`execute-integration.test.ts`**：多处 `createAgentSessionMock.mock.calls[0]![0] as { cwd: string }`——**用必填字段 `cwd: string`**（非可选），符合规范 ✅。对比之下 subprocess 测试的 `{ cwd?: string }`（可选）更弱。

**建议**：subprocess 测试改用 `{ cwd: string }`（必填，因为 spawn 第 3 参 options 的 cwd 在 runPiProcess 中总是被设置，即使 undefined 也是显式 `cwd: undefined`）。

#### B12. import 顺序 ✅

本次新增 import 遵循 Node 内置 → npm → 项目内部顺序。`store.ts` 无新 import（用已有的 `node:sqlite`）。`worker-script-builder.ts` 是字符串拼接的 worker 模板，不涉及 import 顺序。

---

### C. 文件行数 / 函数行数 ✅（S5 是 NIT）

| 文件 | 行数 | 上限 | 结论 |
|------|------|------|------|
| `.pi/workflows/execute-full-workflow.js` | 586 | 1000 | ✅（但密度高，见 S5） |
| `coding-workflow/src/cw/store.ts` | 572 | 1000 | ✅ |
| `coding-workflow/src/cw/plan-parser.ts` | 386 | 1000 | ✅ |
| `workflow/src/engine/error-recovery.ts` | 508 | 1000 | ✅ |
| `coding-workflow/src/cw/check-execute.ts` | 398 | 1000 | ✅ |
| 其余 | <340 | 1000 | ✅ |

**函数行数**（≤80 行）：
- `buildTestRunnerPrompt`（约 50 行）、`buildImplementerPrompt`（约 40 行）、`buildReviewPrompt`（约 25 行）：单函数内大段字符串拼接，行数未超 80，但可读性受字符串密度影响（S5 NIT）
- `transaction`（store.ts，约 30 行）：重试逻辑紧凑，未超 ✅
- `topoSort` / `buildWaves`（execute-full-workflow.js）：各约 20 行 ✅
- `assertAcyclicDeps`（plan-parser.ts）：约 40 行 ✅

---

### D. 命名 ✅

| 规范 | 实际 | 结论 |
|------|------|------|
| 扩展入口 `export default function xxxExtension` | 本次未改入口函数 ✅ | — |
| 状态接口 `XxxRuntimeState` | `SessionRunnerContext`（已有）、`CwStore`（已有）— ADR-029 未引入新 RuntimeState | ✅ |
| 工具参数 `XxxParams` | `SubagentParams`（已有，新增 cwd 字段）| ✅ |
| 工具详情 `XxxDetails` | 本次未新增 Details 类型 | — |
| `RunPiProcessOptions`（新增）| 命名清晰，符合「Options 后缀」惯例 | ✅ |
| `AgentCallOpts.cwd`（新增字段）| 与既有 `timeoutMs`/`schemaEnv` 风格一致 | ✅ |

---

### E. Extension 依赖管理 ✅（S7 已核对正确）

**ADR-029 引入的潜在新依赖**：
- coding-workflow 的 `execute-full-workflow.js` 调用 `workflow run` → 已声明 `coding-workflow → pi-workflow (runtime)` ✅
- coding-workflow 的 workflow 脚本内 agent 通过 cwd 隔离 → 用 workflow 的 `agent({cwd})` 能力，**不直接依赖 pi-subagents**（两条链独立）✅
- subagents 新增 `cwd` 字段 → 独立能力，无新依赖 ✅

**结论**：`extension-dependencies.json` 无需更新。当前声明正确（已核对）。

---

### F. 测试规范 ✅（质量高）

| 检查项 | 结论 |
|--------|------|
| vitest（非 node:test） | ✅ 所有测试用 vitest |
| 测试在 `src/__tests__/`，命名 `*.test.ts` | ✅ `cw/__tests__/plan-parser.test.ts`、`cw/__tests__/store.test.ts`、`infra/__tests__/subprocess-agent-runner.test.ts`、`__tests__/execute-integration.test.ts` |
| 可测试性设计 | ✅ `assertAcyclicDeps`（plan-parser）是纯函数，无 Pi 运行时依赖，测试直接 import |
| 纯逻辑提取 | ✅ topoSort/buildWaves 在 workflow 脚本内（非 extension，无法单测，但逻辑简单）|
| vitest.config.ts alias | 本次未新增 vitest.config（既有配置覆盖）✅ |

**新增测试覆盖**：
- `plan-parser.test.ts`：3 个 dependsOn 环检测测试（环/不存在 id/testCases 环）✅
- `store.test.ts`：4 个 WAL/busy_timeout/调度字段测试（journal_mode/busy_timeout/round-trip/缺省回退）✅
- `subprocess-agent-runner.test.ts`：2 个 cwd 透传契约测试 ✅
- `execute-integration.test.ts`：3 个 cwd 透传 + 并发隔离测试 ✅

**测试质量亮点**：execute-integration 的第 3 个测试（并发不同 cwd 无串扰）覆盖了 ADR-029 最关键的隔离不变式——两个 background subagent 不同 cwd，各自 createAgentSession 收到自己的 cwd。这是契约测试的典范。

---

### G. Git + Commit ✅

**分支命名**：`refactor-coding-workflow-design` — 符合 `refactor/` 前缀精神（虽无 `/` 分隔，但语义正确）✅

**Commit 信息**（10 个，全英文 + Conventional Commits）：
```
feat(subagents): per-call cwd support (ADR-029 decision 1)
feat(workflow): agent() per-call cwd support (ADR-029 decision 1)
feat(coding-workflow): store WAL + busy_timeout for concurrent writes (ADR-029 decision 6)
feat(coding-workflow): plan.json test scheduling fields dependsOn/parallelGroup (ADR-029 decision 4)
docs(coding-workflow): drop pending-env state, simplify to pass/fail/user-skipped (ADR-029 decision 5)
docs(coding-workflow): plan skill guidance for test scheduling fields (ADR-029 decision 4)
feat(workflow): execute-full-workflow.js — full dev+test takeover (ADR-029 step 5)
docs(coding-workflow): coding-execute SKILL — workflow takeover of phase A+B (ADR-029 step 6)
fix(workflow+coding-workflow): address code-review findings (robustness MUST_FIX + type contract)
fix(all): address remaining SHOULD_FIX from 4-dimension code review
```
- 全部 `(scope): description` 格式 ✅
- 全部标注 ADR-029 decision/step 引用 ✅
- 后 2 个 fix commit 体现「审查后修复」闭环 ✅

---

### H. 安装红线 ✅

| 检查项 | coding-workflow | workflow | subagents |
|--------|----------------|----------|-----------|
| `pi` 字段存在 | ✅ `{extensions:["./index.ts"], skills:["./skills"]}` | ✅ | ✅ |
| `pi.extensions = ["./index.ts"]` | ✅ | ✅ | ✅ |
| 禁本地目录加载（生产） | N/A（本次是 dev 实现） | N/A | N/A |

**结论**：3 个包的 pi manifest 全部合规。

---

### I. SKILL.md 规范 ✅（S6 是 NIT）

#### I28. YAML frontmatter ✅

`coding-execute/SKILL.md` 的 frontmatter（name + description）格式正确：
```yaml
name: coding-execute
description: >-
  Use when the user says "轻量执行", ... ADR-029 后阶段 A+B 由 workflow run execute-full-workflow 机器接管...
```
description 已更新反映 ADR-029 后的行为 ✅。

`lite-plan/SKILL.md`、`mid-detail-plan/SKILL.md` 的 frontmatter 未改（仅改正文表格），格式正确 ✅。

#### I29. ADR-029 后 SKILL.md 一致性 ✅（核心一致性已保证，1 处 NIT）

**coding-execute SKILL.md 与 reference docs 的一致性**——ADR-029 后存在「两层文档」：
1. **coding-execute/SKILL.md**：主入口，阶段 A+B 改为「调 workflow run」，主 agent 不直接派 subagent ✅
2. **execution-flow.md / subagent-dispatch.md**：原「主 agent 直接派 subagent」细节，现加 ⚠️ 横幅标注「ADR-029 后由 workflow 内部执行，本文档为参考非操作手册」✅

**横幅质量高**：3 个 reference 文档（execution-flow.md / subagent-dispatch.md / test-case-schema.md）都加了醒目的 `⚠️ ADR-029 后本文档角色变化（2026-07）` 横幅，明确「不得据此绕过 workflow 直接派 subagent」✅。

**一致性核验**：
- pending-env 状态：SKILL.md（删）+ execution-flow.md（删，改 fail+evidence）+ test-case-schema.md（删，改 fail）+ selftest_check_execute.py（改 real_fail_terminal）**四处一致** ✅
- dependsOn/parallelGroup：SKILL.md（workflow 参数说明）+ lite-plan SKILL.md（测试设计步骤加调度）+ mid-detail-plan SKILL.md（test-matrix 加调度）+ test-case-schema.md（字段定义+填写指导）**四处一致** ✅
- cw 调用方式：SKILL.md（渐进式，主 agent 不组装）+ ADR-029 决策 3（修订为渐进式）**一致** ✅

**S6（NIT）**：coding-execute SKILL.md 的 Self-Check 删除了「覆盖率 gate ≥60%」项，但未在新 Self-Check 说明覆盖率 gate 的归属（是 workflow 内 implementer 自检？还是砍除了？）。execution-flow.md 的 A5 仍提覆盖率 gate。建议在 SKILL.md Self-Check 显式声明覆盖率 gate 现由 workflow 内 implementer 负责（或明确砍除）。

---

## 三、ADR-029 实现亮点（符合规范的部分）

1. **决策 1（per-call cwd）的契约测试覆盖是典范**：subagents 的 execute-integration 3 个测试 + workflow 的 subprocess-agent-runner 2 个测试，覆盖了缺省回退 / 显式覆盖 / 并发隔离 三个核心场景。符合 AGENTS.md「新增/修改 SDK 调用必须有契约测试」。

2. **store.ts 的并发初始化防护（决策 6）质量高**：`BEGIN IMMEDIATE` 串行化 + 重读 user_version 跳过已迁移，正确解决 TOCTOU。这是 robustness review 发现的 MUST_FIX 的正确修复。

3. **plan-parser 的 dependsOn 环检测（决策 4）fail-fast 设计正确**：在 cw(plan/detail) gate 就拒环形 plan，不等 workflow 运行时（worktree 建好后）才发现。符合「fail-fast 在最早阶段」原则。

4. **workflow 脚本的 worktree 清理用 finally 块**：无论 Phase 1/2/聚合 是否 throw，finally 必跑 cleanup。符合「资源清理不阻塞业务返回」原则。

5. **subagent-tool.ts 的 cwd schema description 质量高**：明确说明隔离语义（独立 session 目录、无 cross-talk），是 AI 决策的可靠依据。

6. **git 调用全用 execFileSync + shell:false**：避免注入风险，符合「不依赖 fs 之外原生模块」的例外规范（workflow 已知用 spawn）。

---

## 四、修复建议优先级

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P2（应修） | S1 coding-workflow main 字段 | `package.json` 的 `"main": "src/index.ts"` → `"./index.ts"`，与 workflow/subagents 统一 |
| P2（应修） | S2 worker-script-builder 警告文案 | 第 179 行警告消息文本补 `cwd`：`"...Known fields: prompt, description, schema, model, scene, label, task, agent, phase, skill, timeoutMs, cwd"`（与第 178 行 Set 一致）|
| P3（可改） | S3 Atomics.wait sleep | 改用 `await new Promise(r => setTimeout(r, backoff))`（需 transaction 改 async）或保留（功能正确）|
| P3（可改） | S4 subprocess 测试 unsafe cast | `as { cwd?: string }` → `as { cwd: string }`（必填，因 runPiProcess 总显式传 cwd）|
| P4（可选） | S5 workflow 脚本 prompt 模板密度 | 拆 prompt 模板到 `execute-full-workflow.prompts.js`，主脚本只含调度逻辑 |
| P4（可选） | S6 覆盖率 gate 归属声明 | coding-execute SKILL.md Self-Check 显式声明覆盖率 gate 归属 |

---

## 五、总体评价

**ADR-029 实现的规范符合度高**。核心规范（SDK 契约 / Session 隔离 / 状态持久化 / 资源自包含 / 测试规范 / 安装红线）全部通过，无 MUST_FIX。4 处 SHOULD_FIX 均为一致性问题（main 字段 / 警告文案 / unsafe cast / 脚本密度），不影响功能正确性。3 处 NIT 是风格 / 文档完善性建议。

**特别值得肯定**：
- 契约测试覆盖完整（5 个新测试覆盖 cwd 透传 + 并发隔离）
- store.ts 并发初始化防护正确（robustness MUST_FIX 已修复）
- SKILL.md 与 reference docs 的 ADR-029 一致性通过横幅机制保证（3 个文档加角色变化横幅）
- commit 信息全英文 + Conventional Commits + ADR 引用

**主要风险点**（非规范违规，记录备查）：
- ADR-029 决策 3 修订依赖 prompt 注入 workspacePath（认知层约束，非机器强制）——agent 漏传会静默写错 cw db。这是 ADR 的已知设计权衡（Open question 6），非本次规范问题。

---

**审查完成**。
报告路径：`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/refactor-coding-workflow-design/standards_review_v2.md`
问题数：**7**（⚠️ SHOULD_FIX = 4，💡 NIT = 3，MUST_FIX = 0）
