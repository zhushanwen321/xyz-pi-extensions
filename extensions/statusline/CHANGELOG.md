# @zhushanwen/pi-statusline

## 0.4.6

### Patch Changes

- Fix re-export path from `.js` to `.ts` in index.ts

## 0.4.5

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.5.0

## 0.4.4

### Patch Changes

- 15b68f6: Fix evolve analyzer to find session files in project subdirectories, unify pi.extensions to ./index.ts

## 0.4.3

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.4.2

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions

## 0.4.1

### Patch Changes

- Fix statusline alignment, add speed display, add 76 tests
- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.4.1

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

### Patch Changes

- Updated dependencies [045ade1]
  - @zhushanwen/pi-quota-providers@0.4.0

## Unreleased

### Minor Changes

- **重构状态栏布局**：拆分为 5 行（目录 / model / ctx+时间 / 搜索工具 / token-plans）
- **去进度条**：ctx 和 token-plans 全部去 bar，改用纯文本 + 颜色百分比
- **搜索工具抽象**：tavily 等搜索配额从 line 2 抽到独立 line 4
- **声明式 provider 配置**：新增 `~/.pi/agent/config/providers.json` 和 `secrets.json`
- **新增 `/setup-statusline` 命令**：LLM 引导生成 demo 配置文件（i18n zh/en）
- **3 个 provider label 重命名**：`Z.ai-pro` → `zhipu-coding-plan`，`kimi-coding` → `kimi-coding-plan`，`minimax-token` → `minimax-token-plan`
- **QuotaProvider 接口加 `category` 字段**：`"token-plan" | "search-tool"`
- **路径统一走 `getAgentDir()`**：删老 `~/.pi/` 路径 fallback

## 0.1.3

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.2

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.1
