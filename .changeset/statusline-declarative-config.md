---
'@zhushanwen/pi-statusline': minor
'@zhushanwen/pi-quota-providers': minor
---

statusline 渲染层重构 + 声明式 provider 配置

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
