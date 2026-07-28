# @zhushanwen/pi-quota-providers

## 0.5.2

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

## 0.5.1

### Patch Changes

- 00fb8bd: Add cache hit ratio display and session name to statusline

## 0.5.0

### Minor Changes

- Add Mimo (Xiaomi) token-plan provider with cookie auth, fix cache to respect providers.json enabled flag

## 0.4.1

### Patch Changes

- Fix statusline alignment, add speed display, add 76 tests

## 0.4.0

### Minor Changes

- 045ade1: statusline 渲染层重构 + 声明式 provider 配置

  **statusline**：

  - 5 行新布局：目录 / model / ctx+时间 / 搜索工具 / token-plans
  - 进度条全部去除，改用纯文本 + 颜色百分比
  - 新增 `/setup-statusline` 命令（LLM 引导生成 demo 配置文件，i18n zh/en）
  - 配置文件位置：`~/.pi/agent/config/{providers,secrets}.json`

  **quota-providers**：

  - `QuotaProvider` 接口加 `category` 字段（`"token-plan" | "search-tool"`）
  - 新增 `loadProvidersConfig()` / `loadSecrets()` / `buildRuntimeProviders()`
  - 路径工具全部走 `getAgentDir()` 派生
  - 3 个 provider label 重命名：`zhipu-coding-plan` / `kimi-coding-plan` / `minimax-token-plan`
  - `secrets.json` 支持 `${ENV_VAR}` 环境变量引用

## Unreleased

### Minor Changes

- **QuotaProvider 接口加 `category` 字段**：`"token-plan" | "search-tool"`
- **新增声明式配置加载器**：`loadProvidersConfig()` / `loadSecrets()` 读取 `~/.pi/agent/config/{providers,secrets}.json`
- **新增 `buildRuntimeProviders()`**：合并 providers.json 声明 + 内置 fetcher 实现
- **新增路径工具**：`getConfigDir()` / `getProvidersConfigPath()` / `getSecretsPath()` / `getCachePath()` / `getSpeedDir()` 全部走 `getAgentDir()` 派生，无老路径 fallback
- **新增 `resolveEnvRef()`**：secrets.json 支持 `${ENV_VAR}` 引用，缺失静默返回空串
- **`cache.ts` 改用 `getAgentDir()`**：删除 `~/.pi/statusline_cache.json` 和 `~/.pi/token-stats/` 硬编码
- **3 个 provider label 重命名**：`Z.ai` → `zhipu-coding-plan`，`kimi-coding` → `kimi-coding-plan`，`minimax-token` → `minimax-token-plan`

## 0.1.2

### Patch Changes

- model-switch v2 redesign: provider-keyed config, deterministic recommend, clear prompt labels. quota-providers: normalize IDs to kebab-case.

## 0.1.1

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
