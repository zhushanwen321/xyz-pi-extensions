# @zhushanwen/pi-quota-providers

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
