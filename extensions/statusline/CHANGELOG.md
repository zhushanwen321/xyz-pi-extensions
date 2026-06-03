# @zhushanwen/pi-statusline

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
