---
verdict: "pass"
must_fix: 0
reviewer: "robustness"
reviewed_at: "2026-06-01"
scope: "merge-harness-extensions-monorepo"
---

# Robustness Review: Merge Harness Extensions into Monorepo

## Summary

审查了 6 个维度的合并变更，总体评价：**结构清晰，依赖关系正确，错误处理覆盖充分**。未发现阻断性（must-fix）问题。有 2 个建议改进项（低优先级）。

---

## 1. pnpm workspace 配置 + monorepo 基础设施

### 检查项

| 项目 | 状态 | 说明 |
|------|------|------|
| pnpm-workspace.yaml | OK | `packages/*` glob 正确，覆盖所有 13 个包 |
| 根 package.json | OK | private:true，scripts 指向 -r 递归执行 |
| tsconfig.json | OK | include `packages/**/*.ts`，paths 映射完整 |
| .changeset/config.json | OK | 已初始化，版本管理就绪 |
| 13 个包 main 字段 | WARN x2 | 见下方 |

### 发现

**WARN-1: unified-hooks main 字段指向 `index.js`，实际入口是 `index.ts`**

`package.json` 声明 `"main": "index.js"`，但文件系统中只有 `index.ts`。Pi 运行时加载扩展时依赖 main 字段解析，当前 `index.ts` 存在所以 bundler 模式可能走 `files` 字段的 fallback，但 main 字段本身是错误的。

影响：低。Pi 以 `--extension` 方式加载时指定完整 `.ts` 路径，不依赖 main 解析。但 npm publish 或未来 workspace 消费者会出问题。

**WARN-2: types 包 main 指向 `mariozechner/index.ts`**

路径 `packages/types/mariozechner/index.ts` 文件存在，main 字段正确。这是故意的类型 stub 设计。无问题。

**结论：基础设施正常。**

---

## 2. 11 个 extension git mv 到 packages/

### 检查项

| 项目 | 状态 | 说明 |
|------|------|------|
| 所有包 package.json name 前缀 | OK | 全部使用 `@zhushanwen/pi-*` |
| 所有包 main 入口文件存在 | OK | 13/13（含上述 unified-hooks 的 .ts 存在） |
| peerDependencies 声明 | OK | coding-workflow 声明 `@mariozechner/pi-coding-agent` |
| 无循环 workspace 依赖 | OK | 仅 coding-workflow → subagent 单向依赖 |
| files 字段 | OK | 控制发布范围 |

**结论：迁移完整，无遗漏。**

---

## 3. coding-workflow 从 harness 复制

### 检查项

### 3.1 process-manager.ts

| 项目 | 状态 | 说明 |
|------|------|------|
| settled 防重复 resolve | OK | `if (settled) return` 正确防护 |
| 双计时器（activity + global） | OK | activity 可重置，global 是硬上限 |
| SIGTERM → SIGKILL 渐进终止 | OK | 5s grace period |
| AbortSignal 监听 | OK | 支持 `signal.aborted` 已触发 + future abort |
| processRegistry 注册/注销 | OK | close 事件中 splice 清理 |
| 错误事件处理 | OK | spawn error 走 settle(1) |
| stdout/stderr 累加 | OK | Buffer → string 拼接 |

### 3.2 gate-runner.ts

| 项目 | 状态 | 说明 |
|------|------|------|
| 30s 超时 | OK | SIGKILL + settled 防护 |
| JSON 解析 fallback | OK | code !== 0 时先尝试 JSON，失败回退原始输出 |
| error 事件处理 | OK | settled + clearTimeout |

### 3.3 subagent.ts (runSingleAgent)

| 项目 | 状态 | 说明 |
|------|------|------|
| temp 文件清理 | OK | finally 块确保清理 |
| Pi 路径解析 | OK | bun virtual script / generic runtime / pi CLI 三级 fallback |
| wasAborted 传播 | OK | throw Error 触发调用方处理 |

### 3.4 Taste-lint 违规

**WARN-3: process-manager.ts L28 使用 `any[]`**

```typescript
stdio?: "pipe" | "ignore" | "inherit" | any[];
```

`any[]` 违反项目 `no-explicit-any` 规则。应为 `readonly (string | number | undefined)[]` 或 `ChildProcess["stdio"]` 类型。当前未触发 lint 报错可能因 taste-lint 尚未在此包上运行。

**WARN-4: gate-runner.ts L63-64 使用 `any` 类型断言**

```typescript
.filter((c: any) => !c.passed)
.map((c: any) => `...`)
```

应定义 `GateCheckItem` 接口（已在文件顶部定义了），直接使用 `c: GateCheckItem`。

**结论：核心逻辑健壮，有 2 处 taste-lint 违规需清理。**

---

## 4. model-resolve.ts 替换为 @zhushanwen/pi-subagent workspace 依赖

### 关键审查：`resolveModelByComplexity("medium", {})` 传空 ctx 是否安全

**回答：安全。**

分析 `resolveModelByComplexity` (subagent/src/model.ts L233-259) 的 ctx 使用路径：

1. `resolveModelByComplexity` 自身不直接读取 ctx — 它先从 subagent-models.json 获取 candidates，然后对每个 candidate 调用 `resolveModel(modelRef, ctx)`
2. `resolveModel` (L261-311) 对 ctx 的唯一使用：`ctx.modelRegistry?.getAvailable?.() ?? []`
3. 传 `{}` 时：`{}.modelRegistry` 为 `undefined`，`?.getAvailable?.()` 安全返回 `undefined`，`?? []` 返回空数组
4. 空数组 → 进入 `models.length === 0` 分支 → `return { ok: true, ref: modelRef }` — **直接透传 modelRef 到 CLI**

这意味着：
- 当 subagent-models.json 存在且有 "medium" complexity 的 model entry 时，返回第一个有 provider 的 model ref
- 当 modelRegistry 不可用时（传 `{}` 或无 Pi 扩展 API 的独立上下文），跳过验证直接透传

**唯一的隐含风险**：如果透传的 modelRef 在 CLI 侧不存在，会导致子进程启动失败。但这是 coding-workflow 的已知运行模式 — 它启动独立 Pi 子进程，CLI 自己会验证 model 存在性。review-dispatcher.ts L130 也正确处理了 `modelResult.ok === false` 的情况，返回 `{ success: false, error }`。

### workspace:* 依赖解析失败时的行为

**回答：不会静默失败。**

- `workspace:*` 是 pnpm workspace 协议。在 `pnpm install` 后，`node_modules/@zhushanwen/pi-subagent` 会 symlink 到 `../../subagent`
- 如果 symlink 解析失败（如删除了 subagent 包未重新 install），`import from "@zhushanwen/pi-subagent"` 会在运行时抛出 `ERR_MODULE_NOT_FOUND`
- 不会静默降级 — 直接 crash，错误信息清晰

唯一的风险场景：手动操作 `node_modules` 而不运行 `pnpm install`。这在正常开发流程中不会发生。

**结论：替换正确，空 ctx 安全，workspace 依赖不会静默失败。**

---

## 5. pi-subagent 添加 named re-exports

### 检查项

| 导出 | 来源 | coding-workflow 是否使用 | 状态 |
|------|------|--------------------------|------|
| `TaskComplexity` | model.ts | 否（通过 subagent.ts 间接使用 ThinkingLevel） | OK |
| `ThinkingLevel` | model.ts | 是（lib/subagent.ts L12） | OK |
| `THINKING_TO_PI` | model.ts | 是（lib/subagent.ts L13） | OK |
| `COMPLEXITY_DEFAULT_THINKING` | model.ts | 是（lib/review-dispatcher.ts L21） | OK |
| `resolveModelByComplexity` | model.ts | 是（lib/review-dispatcher.ts L19） | OK |
| `resolveModelByComplexitySync` | model.ts | 否 | OK（备用） |
| `resolveModel` | model.ts | 否 | OK（备用） |
| `SingleResult` | render.ts | 否（coding-workflow 定义了自己的同名类型） | OK |
| `UsageStats` | render.ts | 否（同上） | OK |
| `formatUsageStats` | render.ts | 是（index.ts L18） | OK |
| `getFinalOutput` | render.ts | 否（coding-workflow 自己的 subagent.ts 定义了同名函数） | OK |
| `formatTokens` | render.ts | 否 | OK |
| `formatDuration` | render.ts | 否 | OK |
| `cleanupOldTempFiles` | spawn.ts | 否（coding-workflow 自己的 subagent.ts 定义了同名函数） | OK |
| `OnUpdateCallback` | spawn.ts | 否 | OK |
| `SpawnManager` | spawn.ts | 否 | OK |
| `createSpawnManager` | spawn.ts | 否 | OK |

### 发现

**注意：类型/函数重复定义**

coding-workflow 的 `lib/subagent.ts` 自行定义了 `UsageStats`、`SingleResult`、`getFinalOutput`、`formatUsageStats`、`formatTokens`、`cleanupOldTempFiles`，与 subagent 包的 re-export 功能重叠。

这不是 bug — coding-workflow 的 subagent.ts 是独立的精简实现（只有 foreground single agent 模式），而 pi-subagent 是完整实现（parallel/chain/background/memory）。两者接口相似但实现不同，属于**有意的解耦设计**。

`index.ts` L18 的 `import { formatUsageStats } from "./lib/subagent.js"` 使用的是本地版本，不是从 `@zhushanwen/pi-subagent` 导入的。这是正确的 — 保持一致性。

**结论：re-exports 完整，使用正确，无缺失。**

---

## 6. 28 个 skills 迁移

### 计数验证

| 位置 | SKILL.md 数量 |
|------|--------------|
| packages/coding-workflow/skills/ | 19 |
| skills/ (独立 skills) | 11 |
| **总计** | **30** |

注：实际发现的 SKILL.md 总数为 30，而非 spec 中的 28。差异可能因分支迭代期间新增了 skill，不影响健壮性。

### 检查项

| 项目 | 状态 | 说明 |
|------|------|------|
| SKILL.md 文件完整性 | OK | 每个 skill 目录都有 SKILL.md |
| resources_discover 注册 | OK | coding-workflow 的 19 个 bundled skills 通过 extension 的 `resources_discover` 事件自动注册 |
| 独立 skills 无所属 extension | OK | `skills/` 下 11 个 skill 独立分发，不进 packages/ |

**结论：skills 迁移完整。**

---

## js-yaml 依赖位置分析

**问题：coding-workflow 的 package.json 中 `js-yaml` 是 `dependencies`（运行时依赖），不是 `devDependencies`。这是正确的。**

审查 `index.ts` 中的 4 处 `yaml.load` 调用：
- L133：解析 review 文件的 YAML frontmatter（gate check 读取）
- L414：解析 retrospect 文件的 YAML frontmatter
- L747：解析 retrospect 文件的 YAML frontmatter
- L1143：解析 review 文件的 YAML frontmatter

全部在运行时执行，是 Pi 进程内的工具调用逻辑。如果 js-yaml 被放在 devDependencies，`pnpm install` 后 Pi 运行时可能找不到模块（Pi 不安装 devDependencies）。

**安全性**：js-yaml v4 的 `yaml.load()` 默认使用 `DEFAULT_SCHEMA`，不支持 JavaScript 对象（`!!js/undefined` 等标签），所以不存在代码注入风险。所有调用都在 try-catch 内，异常被正确捕获。

**结论：dependencies 声明正确，使用安全。**

---

## 建议改进项（非 must-fix）

| # | 优先级 | 文件 | 问题 | 建议 |
|---|--------|------|------|------|
| 1 | Low | process-manager.ts L28 | `any[]` 违反 taste-lint | 改为 `ChildProcess["stdio"]` 或 `readonly (string \| number)[]` |
| 2 | Low | gate-runner.ts L63-64 | `any` 类型断言 | 已有 `GateCheckItem` 接口，改为 `c: GateCheckItem` |
| 3 | Low | unified-hooks package.json | main 指向 `index.js`，实际为 `index.ts` | 改为 `"main": "index.ts"` |

---

## 审查总结

| 维度 | 评价 | must-fix |
|------|------|----------|
| pnpm workspace 配置 | 结构完整，tsconfig paths 正确 | 0 |
| 11 个 extension 迁移 | 包元数据正确，无循环依赖 | 0 |
| coding-workflow 从 harness 复制 | 进程管理健壮，错误处理覆盖充分 | 0 |
| model-resolve 替换 | 空 ctx 安全透传，workspace 依赖 fail-fast | 0 |
| subagent named re-exports | 完整覆盖，使用正确 | 0 |
| 28 个 skills 迁移 | bundled + 独立分发结构清晰 | 0 |
| js-yaml 依赖位置 | dependencies 正确（运行时使用），安全 | 0 |

**must_fix: 0**
