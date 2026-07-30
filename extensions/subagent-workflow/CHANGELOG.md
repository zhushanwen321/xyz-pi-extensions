# @zhushanwen/pi-subagent-workflow

## 0.4.3

### Patch Changes

- 486746a: Fix: all built-in workflows (parallel/chain/map-reduce/scatter-gather) crashed with "Worker exited with code 1".

  Two root-cause bugs in `worker-script-builder.ts` (the generator of Worker-thread source code), both slipped through because existing tests were pure string `toContain` assertions that never executed the generated code:

  1. **`_safePost` scope bug**: `_safePost` was declared inside the async IIFE but used in the outer `.then()`/`.catch()` return/error handlers (outside the IIFE scope). Every script `return` triggered `ReferenceError: _safePost is not defined` → Worker exit 1. Fix: hoist `_safePost` (and the `parentPort`/`workerData` handles) to module scope.

  2. **`parallel()` Promise-array bug**: CC-compatible scripts write `parallel([agent({...}), ...])` passing an array of already-instantiated Promises. The implementation passed each Promise back into `agent()` as opts → `postMessage` `DataCloneError` → all agents rejected. Fix: thenable duck-type check at the top of the `parallel()` map callback to return in-flight Promises directly.

  Also adds a three-layer test strategy (documented in `docs/extensions/subagents/testing.md`):

  - **L2 runtime tests** (`worker-script-builder-runtime.test.ts`): spin up a real `node:worker_threads` Worker to execute the generated code, covering return/throw/agent/abort/workflow/execute paths plus the Promise-array regression.
  - **L3 workflow E2E** (`workflows-e2e.test.ts`): run all 4 built-in workflows through the real `runAndWait` orchestration (real Worker thread + real scripts + real JsonlRunStore), mocking only the LLM `AgentRunner`. All 4 workflows now pass.

## 0.4.2

### Patch Changes

- 83da227: Change parallel builtin workflow aggregate output shape from object to string.

  The `parallel` workflow's aggregate phase no longer calls an LLM with a `{overallScore, topIssues, consensus}` object schema. Instead it produces a pure-code concatenation of per-perspective findings as a single string (`[perspective] finding1; finding2\n...`). The `aggregate` field of the workflow result is now a plain string rather than the previous structured object.

  Rationale: removing the LLM aggregate call makes the parallel workflow deterministic and cost-bounded; downstream consumers of `aggregate` must read it as a string.

## 0.4.1

### Patch Changes

- 9169119: Migrate all Pi SDK references from the deprecated `@mariozechner/pi-*` namespace to the active `@earendil-works/pi-*` namespace. This eliminates the five deprecation warnings emitted during `pnpm install` (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, transitive `@mariozechner/pi-agent-core`, and transitive `node-domexception`).

  **Changes:**

  - **package.json**: all `peerDependencies` / `peerDependenciesMeta` referencing `@mariozechner/pi-*` updated to `@earendil-works/pi-*` (versions unchanged: `*`)
  - **TypeScript sources**: all `import ... from "@mariozechner/pi-*"` updated to `import ... from "@earendil-works/pi-*"` across 98 files (438 import occurrences including `declare module` and dynamic `import()` types)
  - **`tsconfig.json` paths**: removed `@mariozechner/pi-*` dual-alias entries; kept only `@earendil-works/pi-*`
  - **`vitest.config.ts` aliases**: removed `@mariozechner/pi-*` entries; updated stub path targets to `./shared/types/earendil-works/index`
  - **`shared/types/mariozechner/` → `shared/types/earendil-works/`**: stub directory renamed, `declare module` names updated, `shared/types/package.json` `main` and `files` fields updated
  - **Monorepo cross-package references**: `extensions/ask-user` (`@zhushanwen/pi-subagent-workflow`) and `extensions/subagent-workflow` (`@zhushanwen/pi-structured-output`) switched from `*` to `workspace:*` so local development uses the just-edited sources instead of pulling deprecated versions from npm
  - **`pnpm.allowedDeprecatedVersions.node-domexception = "1.0.0"`**: silences the remaining unavoidable transitive deprecation (`@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios@7` → `node-fetch@3` → `node-domexception`); `node-domexception` is a Node 22+ redundant polyfill, not a functional issue

  **No functional changes** to extension behavior, types, or APIs. `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test` all pass cleanly with zero deprecation warnings.

  **Follow-up hardening (no functional impact):**

  - **`.githooks/validate-no-mariozechner-pi`** (new): standalone grep-based scanner that errors when `@mariozechner/pi-` appears in staged files or in workspace path checks. Can also be called manually for ad-hoc audits (`bash .githooks/validate-no-mariozechner-pi [<files>]`).
  - **`.githooks/pre-commit`** (`-0.` namespace check): wired `validate-no-mariozechner-pi` as a pre-manifest gate. Any staged file in `extensions/` or `shared/` (including `package.json`, `vitest.config.ts`, `.d.ts`) containing the deprecated namespace blocks the commit. `SKIP_NAMESPACE_CHECK=1` hotfix bypass must be justified in the PR description and tracked with an issue.
  - **`.githooks/pre-commit`** (`0b` peerDep check): the package.json deep check now requires `@earendil-works/pi-coding-agent` and explicitly rejects `@mariozechner/pi-coding-agent` (was incorrectly accepting the deprecated name as the success signal).
  - **AGENTS.md** new section "禁止使用已废弃的 Pi SDK namespace [MANDATORY]": documents the namespace rule, the gate script location, and what to do if Pi renames the namespace again.
  - **docs/standards.md / docs/monorepo-conventions.md / docs/quality-gates.md**: updated example `package.json`, import snippets, and `peerDependencies` descriptions to use `@earendil-works/pi-*`. Old historical docs (`docs/evolution/`, `docs/third-party-extensions/`, `docs/research/`) retain the deprecated references as factual record of past investigations.
  - **Bonus fix**: `pre-commit` had a latent bash bug `${#TEST_PKGS[@]:-}` (not a valid parameter expansion). Fixed to `${#TEST_PKGS[@]}` while validating the new gate.

- Updated dependencies [9169119]
  - @zhushanwen/pi-structured-output@0.3.5

## 0.4.0

### Minor Changes

- a090b61: > **版本口径**：本包处于 0.x 阶段。按 SemVer §6「0.x 可能在任何次版本引入破坏性变更」，minor bump 允许含 breaking。下方标注的 **Breaking** 是改动性质说明，不对应 major bump。

  重构 subagent-workflow tool 面，提升弱模型调用正确率：

  **Breaking** — `workflow` tool 删除 `retry-node` / `skip-node` 两个 action（7 → 5 action：run/status/pause/resume/abort）。这两个 action 语义尴尬（retry-node 重跑失败节点但不改脚本输出；skip-node 注入零 usage 占位结果），删除后 `node-ops.ts` 整文件移除。共享基础设施 `executeAgentCall` / `postBudgetUpdate` 仍由主路径使用，无死代码。`callId` schema 字段随之移除。

  **Feat** — subagent ID 从纯 UUID 改为 `sa-<uuid>` 前缀格式，与 workflow runId 的 `wf-` 前缀风格统一。前缀是视觉辅助（所有消费方零格式校验，不进入程序逻辑判别），帮助 LLM/人眼通过 ID 区分 subagent 与 workflow。`shortId` 显示层加 `sa-` 感知分支保持信息量。向后兼容：旧纯 UUID ID 可正常反序列化。

  **Refactor** — `subagent` tool 的 `startParam` 13 字段（task/slug/agent/model/thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/fork/worktree/cwd）从嵌套 envelope 拍平到顶层 schema。解决 flat JSON Schema 无法表达条件必填导致弱模型（GLM/DeepSeek）把 task/slug 平铺到顶层的痛点。删除 `hasFlattenedStartFields` runtime guard（拍平后语义反转）+ `hasStartParam` helper。`listParam` / `cancelParam` 保留嵌套（字段少，保留隔离）。`description` TDD 重写（432 词），正例改平铺。service 层契约（`ExecuteOptions`）不变，改动收敛在 tool 层。

  不新增统一管理 tool（保持 3 tool：subagent / workflow / workflow-script）。

### Patch Changes

- b5f53fd: 修正内置 agent 模板的 `tools:` 字段与 body 描述：

  - `researcher`：tools 由 `read` 改为 `read, bash`（tavily-web-search 是 CLI 类型 skill，必须 bash 执行）。body 重写 skill 调用方式——Pi 没有 `Skill` 工具，skill 通过 `<available_skills>` 注入，LLM 用 `read` 读 SKILL.md 再用 `bash` 跑命令。同时 body 收窄了 read-only 范围（仅禁止改源文件，不禁止跑 tavily CLI）。
  - `explorer`：tools 增 `find, ls`（结构化文件/目录查询工具，优于 shell `find`/`ls`）。body free-to-run 列表移除 `find`/`grep`/`ls` 字眼（避免与 Pi 工具语义混淆），新增工具优先级提示。
  - `orchestrator`：tools 增 `ask_user`（扩展工具，由 `@zhushanwen/pi-ask-user` 提供）。body 提示该工具在未装 ask-user 扩展的 pi 环境中静默兼容（Pi 端 `_rebuildSystemPrompt` 静默过滤未注册工具，subagent-workflow 不做特殊处理，纯透传 `--tools` 参数）。新增「遇到需求歧义时反问用户」指引。
  - 测试断言补齐：原 `arrayContaining(["worker", ...7 个])` 改为全部 9 个 agent 精确断言 + 每个 agent 的 `tools` 字段精确匹配 frontmatter（`worker`/`general-purpose` 为 `undefined`、其余为具体数组）。未来改 frontmatter 会立即报错。

  未变更：`worker` / `general-purpose` 模板保持工具全开 + prompt 软约束（按用户要求不增加 Tool scope 风险标注）。

## 0.3.3

### Patch Changes

- 72e6a61: Fix non-deterministic loss of subagent completion notifications.

  Subagent completion notifications are delivered via a detached microtask
  calling `sendMessage({ triggerTurn: true, deliverAs: "steer" })`. When this
  microtask lands inside the main agent's `agent_end` → `finishRun` race window
  (`isStreaming` still `true`), pi's `sendCustomMessage` takes the steer branch:
  the message is enqueued into `steeringQueue`, but the run loop has already
  ended and nothing drains the queue — the notification is silently dropped and
  the main agent never produces a follow-up turn.

  Fix: add an `isIdle()` gate in `BgNotifier.flushPendingNotifications`. When the
  main agent is still streaming, flush backs off (`setTimeout` 100ms) and retries
  until idle, then sends synchronously. Because `isIdle()` and `sendMessage`
  share the same synchronous read of `agent.state.isStreaming` (host.sendMessage
  does not await), once `isIdle` returns `true` the subsequent `sendMessage` is
  guaranteed to hit the `triggerTurn` branch and start a new turn. A backoff cap
  (50 × 100ms = 5s) forces a fallback send to avoid notification starvation when
  the main agent stays busy for a long turn.

  `isIdle` is injected from `ctx.isIdle()` in `session_start`, threaded through
  `SubagentService` → `piAdapter()` → `NotifierHost`. It is optional, so legacy
  hosts without it keep the original immediate-send behavior.

## 0.3.2

### Patch Changes

- 4ed62ca: Subagent 子进程镜像主进程的 extension/approve flag

  新增 `mirrorMainProcessFlags(argv)`：从主 pi 进程的 `process.argv` 解析
  `--extension` / `--no-extensions` / `--approve`，透传给 `buildSpawnArgs`，
  让 subagent 子进程的 extension 加载行为与主进程一致（之前子进程完全不继承，
  会加载全局自动发现的 extension 且不信任项目级 .pi/skills）。

  - 数据源是主进程 argv（已运行时验证完整保留启动 flag），非 env 传递
  - 向后兼容：argv 无这些 flag 时 `buildSpawnArgs` 行为完全不变
  - 对任意 pi 宿主通用（不只 xyz-agent），xyz-agent 侧零改动
  - 嵌套 subagent（孙进程）自动继承——镜像后父进程 argv 自带这些 flag

## 0.3.1

### Patch Changes

- bb86ee9: Harden 5 tool descriptions + runtime validation against weak-model first-call parameter misuse.

  Triggered by a real session where a flash-tier model (step-3.7-flash) called the `subagent` tool with `task`/`slug` flattened to the top level (missing the `startParam` envelope) and needed a round-trip to self-correct. Root cause analysis found a systemic debt pattern across 5 tools: conditional-required fields expressed as `Type.Optional`, zero JSON call examples in descriptions, no parameter-structure anti-patterns, dry runtime error messages with no Correct example, and no prompt-quality regression tests.

  Three-layer fix applied uniformly to all 5 tools (subagent + workflow + goal_control + todo + ask-user + structured-output):

  - **Runtime friendly correction**: required-field throws now append a copy-pasteable `Correct: {full JSON}` example; common-misuse detectors catch the highest-frequency errors and return a corrected shape (subagent `startParam` flattening; workflow `args` sub-field flattening — a P0 silent failure; todo `text`/`texts` + `id`/`ids` dual-shape trap; ask-user string `options` array).
  - **Description examples + structural anti-patterns**: each tool now ships complete JSON call examples for every high-risk action and a Don't section listing parameter-structure mistakes.
  - **Prompt-quality regression tests**: new source-text assertion test per tool locks the examples / anti-patterns / Correct-usage strings so they cannot silently regress.

  Notable silent-failure closures (worse than the original throw-based failure because they did not error at all):

  - **structured-output**: `schema`/`data` swap detection + keyword-less schema rejection. Previously `Type.Unknown()` + `ajv strict:false` compiled a keyword-less object (e.g. `{}`, `{a:1}`) into an accept-anything validator — swapping schema and data then passed validation and stored garbage silently. Now detected and rejected with a Correct hint.
  - **workflow**: flattened `args` sub-fields (task/items/...) previously fell through to `args = params.args ?? {}`, silently launching a run missing its parameters.

  Other changes:

  - **subagent + workflow**: `slug` `maxLength` relaxed 20 → 35 (single source `SLUG_MAX_LENGTH`; both schemas now reference the constant). Descriptive kebab-case slugs like `fix-subagent-wf-tools` (21) no longer collide; over-limit error now suggests a shorter label.
  - **ask-user**: `InputSchema.options` element intentionally loosened to `OptionSchema | string` so a mistyped string-array `options` reaches `validateInput` (friendly Correct error) instead of being killed by the schema layer's raw ajv error before `execute` runs. Internal `Question`/`Option` types stay strict.
  - **structured-output**: extracted `executeStructuredOutput()` for direct unit testing (internal test helper — not re-exported from the package root, so not part of the public API); deleted stale `STRUCTURED_OUTPUT_SCHEMA` env-name + tool_call block tests (0.3.0 changed to unconditional registration, real env name is `PI_WORKFLOW_SCHEMA`).

  Review follow-up (addressed in the same PR after a 6-dimension multi-agent code review):

  - **structured-output**: `SCHEMA_KEYWORDS` completed with the remaining draft-07 validation keywords (`if`/`then`/`else`/`dependencies`/`propertyNames`/`contains`/`$defs`/`definitions`) so a conditional root schema is no longer wrongly rejected as keyword-less; `executeStructuredOutput` return type widened from `Record<string,unknown>` to `unknown` (data may be a primitive/array per its own tests); `getOrCompileValidator` now accepts `object | boolean` (boolean root schemas are valid draft-07), eliminating an unsafe cast; `tool_execution_end` handler uses a runtime type guard instead of a bare cast; `echo()` now tolerates `undefined` (`JSON.stringify(undefined)` returns undefined and previously crashed `.length` — a latent bug surfaced by the new edge-case tests).
  - **subagent-workflow + todo**: detectors (`hasFlattenedStartFields`, workflow `findFlattenedArgKeys`, todo `handleAdd`/`handleDelete`) now exported to enable behavioural trigger/no-trigger tests — the P0 workflow flatten detector previously had only a fragile source-text lock. Added slug boundary tests (35/36) and a workflow-side runtime slug guard matching subagent's.
  - goal_control `hasGoalDetails` guard tightened to validate the `details` value is an object (not just that the key exists).

  All five packages are bumped `patch`: no breaking API changes, no new public exports forming a supported API contract (the exported detectors are test helpers, not a stable surface), and the ask-user schema loosening + structured-output keyword-less rejection only surface clearer errors for inputs that were already malformed (previously silently corrupted or raw-ajv-rejected). This is defensive hardening + prompt-quality work, conservatively versioned as patch.

- Updated dependencies [bb86ee9]
  - @zhushanwen/pi-structured-output@0.3.4

## 0.3.0

### Minor Changes

- bd68203: Decouple subagent execution record identity from transcript lifecycle (ADR-035):

  - Record id uses `crypto.randomUUID()` for global uniqueness across restarts
  - Atomic manifest persistence (`<uuid>.json`) carrying sessionFile, status, timestamps
  - RPC `get_state` handshake after spawn to resolve sessionFile/sessionId robustly
  - Orphan session detection + tmp residue recovery on startup
  - PID alive timeout narrowed (24h → 1h) to bound stale-record window
  - Manifest write failures surface as errors (no silent swallow)
  - Manifest status enum expanded from 3-state to 4-state (add cancelled; crashed stays as reconstruction-derived state, not persisted in manifest)

### Patch Changes

- 4fe4906: Fix subagent ask_user end-to-end unavailability and generalize UI transit to a two-dimension orthogonal architecture (method interaction model + channel registry).

  Root causes fixed:

  - Protocol format error (expected JSON-RPC 2.0 but Pi emits flattened `{type, method, ...}`)
  - Handler injection completely missing (index.ts session_start did not pass uiRequestHandler)
  - No method/channel dispatch (all UI requests merged into single handler)
  - No TUI/GUI/headless mode dispatch (W4 prompt injected unconditionally)
  - Silent failure when handler missing (no observability)
  - No cross-subprocess concurrency queue (multiple ask_user flood parent UI)

  Architecture (ADR-033): two orthogonal dimensions:

  - Transit + queue strategy determined by method interaction model (dialog classes transit + L2 queue; fire-and-forget not transited under TUI)
  - Business routing determined by channel registry (ask_user / gui_widget / future)

## 0.2.0

### Minor Changes

- ddc1223: Adopt @xyz-agent/extension-protocol@0.2.0 **gui** rendering protocol across three extensions:

  - **subagent-workflow**: migrate local gui-adapter stub to npm package; fix type contract (3 non-existent custom types → protocol primitives: task-list→list-tree, workflow-runs→list-tree, subagent-trace→card); unify isGuiCapable to ctx.mode === 'rpc'; add **gui** output to workflow-script tool; add **gui** field to SubagentToolResult/WorkflowToolDetails/WorkflowScriptToolDetails union types (removes unsafe casts); fix workflow not_found error rendering (danger stats-line instead of success checkmark); enrich subagent start card with slug/agent identity
  - **todo**: replace deprecated \_render with **gui** list-tree (pending→dot, in_progress→circle, completed→check, cancelled→cross)
  - **goal**: add **gui** progress-bar/stats-line output for budget visibility (card variant by status, severity by budget ratio thresholds); complete GoalStatus severity coverage (budget_limited/time_limited/cancelled → danger)

  Note: subagent-workflow's `slug` field is now required (non-optional) on 4 internal domain types (ExecutionRecord, ExecuteOptions, SubagentToolResult start branch, SubagentListItem). These are internal runtime types not constructed by external consumers; deserialization backfills `""` for old persisted records. Tagged minor per internal-types convention.

- 2003e64: Add RPC-mode lifecycle control to /subagents and /workflows command handlers so xyz-agent GUI can trigger cancel/pause/resume/abort via slash command (e.g. `client.prompt("/subagents cancel <id>")`) without LLM round-trip. TUI paths unchanged; headless (print/json) guard tightened from `!ctx.hasUI` to `ctx.mode !== "tui"`.

### Patch Changes

- Updated dependencies [96aed1d]
  - @zhushanwen/pi-structured-output@0.3.3
