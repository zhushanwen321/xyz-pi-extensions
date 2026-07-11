# ADR-031: 统一资源发现（agent .md 与 workflow .js 共享扫描逻辑）

## Status: Accepted

## Context

ADR-030 将 `pi-subagents` + `pi-workflow` 合并为 `pi-subagent-workflow`。合并前两类资源的发现机制各自独立，存在三方面问题：

### 问题 1：扫描路径不一致

旧 `pi-workflow` 的 agent 发现（`agent-discovery.ts`）硬编码 7 条路径扫描，旧 `pi-subagents` 的 agent 发现（`agent-registry.ts`）只扫 `getAgentDir()` 单目录 + 包内 builtin。两者默认路径覆盖面差异显著：

| 来源 | 旧 workflow agent | 旧 subagents agent |
|------|-------------------|-------------------|
| project `.pi/agents/` | ✅ | ❌ |
| project `.agents/agents/` | ✅ | ❌ |
| user `.pi/agent/agents/` | ✅ | ❌（扫 `~/.pi/agent/*.md`，非 `agents/` 子目录） |
| user `.agents/agents/` | ✅ | ❌ |
| npm global | ✅ 硬扫 `agents/` | ❌ |
| npm project-local | ✅ | ❌ |
| local extensions | ✅ | ❌ |

### 问题 2：路径硬编码，未用 SDK 动态获取

旧 `pi-workflow` 的 user 级路径用 `os.homedir()` 硬编码拼接 `~/.pi/agent/...`，绕过了 Pi SDK 的 `getAgentDir()`。用户设置 `PI_CODING_AGENT_DIR` 环境变量重定向配置目录时，workflow 的 user 级目录指向错误位置。

### 问题 3：npm 包内发现机制不统一

- agent 发现：硬扫每个包的 `agents/` 子目录（约定式，不读 manifest）
- workflow 发现：读 `pi.workflows` manifest 声明的路径，manifest 全失败才 fallback 扫 `workflows/`

两者无法互相发现对方包内提供的资源。例如 `pi-coding-workflow` 声明了 `pi.workflows: ["./workflows"]`，但旧 subagents 的 agent 发现不会扫这个包的任何内容。

### 问题 4：discovery.json 契约的定位问题

ADR-028 引入的 `discovery.json` 是外部宿主写入的可选覆盖文件。extension 代码只读不写，默认（无 discovery.json）时 agent 发现能力收窄为单目录。这导致 extension 在裸 pi（无宿主）场景下 agent 发现能力退化，与"extension 独立可用"的原则冲突。

## Decision

### 1. 新建统一资源发现模块

`src/shared/resource-discovery.ts`，agent .md 与 workflow .js/.mjs 共享同一套扫描逻辑，末级目录名（`agents`/`workflows`）参数化为 `ResourceKind`。

### 2. 统一扫描源（优先级低→高）

| 来源 | 路径 | 获取方式 |
|------|------|---------|
| user `.pi/agent` | `getAgentDir()/{kind}/` | `getAgentDir()` 动态 |
| user `.agents` | `homedir()/.agents/{kind}/` | `os.homedir()` |
| npm global | `getAgentDir()/npm/node_modules/*/<pkg>/` | `getAgentDir()` 动态 |
| npm dev symlink | `getAgentDir()/extensions/*/<pkg>/` | `getAgentDir()` 动态 |
| project `.pi` | `workspaceRoot/.pi/{kind}/` | `findWorkspaceRoot(cwd)` |
| project `.pi/.tmp`（仅 workflow） | `workspaceRoot/.pi/{kind}/.tmp/` | `findWorkspaceRoot(cwd)` |
| project `.agents` | `workspaceRoot/.agents/{kind}/` | `findWorkspaceRoot(cwd)` |

`{kind}` = `agents` 或 `workflows`。所有 user 级路径统一用 `getAgentDir()`，尊重 `PI_CODING_AGENT_DIR` 环境变量。

### 3. npm/dev 包内发现规则（统一）

- **有 `pi.{kind}` manifest**（`pi.agents`/`pi.workflows`）：只按 manifest 声明的路径加载。manifest 条目支持文件和目录两种。**路径存在性校验**：声明的路径不存在 → 该包发现失败（available=false），不 fallback 到约定目录。
- **无 manifest**：扫描约定目录 `{kind}/`（`agents/`/`workflows/`）。

### 4. 废弃 discovery.json

- 删除 `discovery-config.ts`、`DiscoveryConfig` 类型、`DiscoveryConfigLoader`
- `resources_discover` handler 返回空对象（pi 核心 auto-discovery 已覆盖标准 skill 目录）
- 子 session 的 `skillDirs` 固定为空数组，`--skill` 由 `agent({skill})` 调用方显式传入
- 扫描路径完全由代码内 `getAgentDir()` + `findWorkspaceRoot(cwd)` 推导，extension 独立可用

### 5. 包内 builtin agent 走 manifest

`subagent-workflow` 的 `package.json` 新增 `pi.agents: ["./agents"]`，与 npm 包内发现规则一致。`createPackageBuiltinRegistry()` 调用 `processPackageSync(packageRoot, "agents")` 走 manifest 加载。

## Consequences

**优点**

- **路径一致**：agent 和 workflow 扫描相同前缀，仅末级目录名不同，行为可预测
- **动态获取**：所有 user 级路径走 `getAgentDir()`，尊重环境变量重定向
- **跨包发现**：npm/dev 包内资源通过 manifest 互相可发现（agent 包可提供 workflow，反之亦然）
- **manifest 严格校验**：声明了就必须存在，不存在则失败，避免"声明与实际不符"的隐蔽 bug
- **独立可用**：废弃 discovery.json 后，extension 在裸 pi 场景零配置即可工作，扫描路径自洽
- **workspaceRoot 统一**：agent 和 workflow 的 project 级都用 `findWorkspaceRoot(cwd)`，bare+worktree 结构行为一致

**代价**

- **manifest 路径不存在会失败**：包声明了 `pi.agents`/`pi.workflows` 但路径不存在时，该包资源整体不可用。这是有意为之（严格校验），但要求包作者确保 manifest 正确
- **discovery.json 用户需迁移**：原依赖 discovery.json 注入额外 skill/agent 目录的场景，需改为将文件放到标准目录（`.pi/agents/`、`.agents/agents/` 等）
- **同步 + 异步双 API**：agent 发现需 mtime 缓存（hot-reload），workflow 发现需 async（fs/promises），统一模块提供 `discoverResources`（async）+ `discoverResourcesSync`（sync）两套

## 影响的文件

- 新建 `src/shared/resource-discovery.ts`（统一扫描 + manifest 校验）
- 改造 `src/execution/agent-registry.ts`（调用统一扫描，builtin 走 manifest）
- 改造 `src/orchestration/config-loader.ts`（扫描委托给统一模块，保留 meta 提取）
- 改造 `src/execution/model-config-service.ts`（去掉 discoveryLoader，传 cwd）
- 改造 `src/index.ts`（去掉 discoveryLoader，resources_discover 返回空）
- 改造 `src/execution/subagent-service.ts` + `session-runner.ts`（skillDirs 固定空数组）
- 删除 `src/execution/discovery-config.ts` + `DiscoveryConfig` 类型
- `package.json` 新增 `pi.agents: ["./agents"]`
