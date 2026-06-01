---
verdict: pass
must_fix: 2
review_metrics:
  files_reviewed: 14
  boundaries_checked: 7
  issues_found: 5
  must_fix_count: 2
  low_count: 2
  info_count: 1
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-01 21:30
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：7
- 模拟数据验证路径数：4

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | 问题 |
|---------|--------|------------|------------|------------|------|
| UC-1 | coding-workflow → pi-subagent (model) | ✅ | ✅ | ✅ | — |
| UC-1 | coding-workflow → local subagent.ts (spawn) | ⚠️ | ✅ | ❌ | SingleResult 接口分歧（#2） |
| UC-1 | coding-workflow → local process-manager.ts | ✅ | ✅ | ⚠️ | ProcessManager 与 subagent 重复（#2） |
| UC-2 | pnpm workspace → coding-workflow | ✅ | ✅ | ✅ | — |
| UC-4 | Pi skill discovery → coding-workflow/skills/ | ❌ | ✅ | ❌ | SkillResolver 无 bundled path（#1） |
| UC-4 | Pi skill discovery → evolve-daily/skills/ | ❌ | ✅ | ❌ | 无注册机制（#3） |
| UC-3 | eslint.config.mjs → taste-lint | ✅ | ✅ | ✅ | — |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | MUST_FIX | UC-4 | Pi→coding-workflow/skills/ | D1+D3 | SkillResolver 的 fallback 只检查 `~/.pi/agent/skills/` 和 `.pi/skills/`，不检查扩展自身的 `skills/` 目录。npm 安装场景下 bundled skills 不可发现 | `packages/coding-workflow/lib/skill-resolver.ts` | L31-41 | `#findFallbackPath` 增加 `path.join(__dirname, "..", "skills", name, "SKILL.md")` 作为第一优先级 fallback（在 user-level path 之前）。`__dirname` 解析自扩展入口文件的父目录，始终指向已安装的包根目录 |
| 2 | MUST_FIX | UC-1 | coding-workflow→local subagent | D1+D3 | SingleResult 接口与 pi-subagent 已分歧：coding-workflow 的定义缺少 `agent`、`agentSource`、`task`、`thinkingLevel`、`step` 五个字段。共享类型 `UsageStats` 目前一致，但维护两份拷贝将在未来漂移。ProcessManager 145 行与 pi-subagent/spawn.ts 重复 | `packages/coding-workflow/lib/subagent.ts`, `packages/coding-workflow/lib/process-manager.ts` | 全文件 | 策略：(a) 将 `ProcessManager` 和 `runSingleAgent`（单进程简化版）贡献到 pi-subagent 包作为公开 API；(b) coding-workflow 删除这两个文件，改为 `import { runSingleAgent, ProcessManager } from "@zhushanwen/pi-subagent"`；(c) 共享类型（UsageStats, SingleResult）统一从 pi-subagent 导入 |
| 3 | LOW | UC-4 | Pi→evolve-daily/skills/ | D1 | evolve-daily 无 `resources_discover` 或 `before_agent_start` 处理器。3 个 bundled skills（evolve, evolve-apply, evolve-report）不在 Pi 的 skill 发现列表中。当前通过手动 symlink 到 `~/.pi/agent/skills/` 绕过 | `packages/evolve-daily/src/index.ts` | 全文件（34行） | 添加 `pi.on("session_start")` 中的 resources_discover 处理器，或添加 before_agent_start 事件处理器扫描 `skills/` 子目录并注册 |
| 4 | LOW | UC-1 | coding-workflow state 持久化 | D3 | `reconstructState` 使用 `(entry as any).customType` 和 `(entry as any).data` 类型断言，违反项目 no-any 规则。这是 Pi ExtensionAPI 的类型定义不完整导致的 workaround | `packages/coding-workflow/index.ts` | L229, L231 | 添加类型守卫函数 `isCodingWorkflowEntry(e: unknown): e is { customType: string; data: WorkflowState }`，替代 `as any` 断言 |
| 5 | INFO | UC-4 | skills/ 目录 | — | 独立 skills 目录包含 9 个 skill（均含 SKILL.md）。BLR #1 已记录 remove-worktree 缺失，此处不重复计为独立问题 | `skills/` | 目录级 | — |

## 模拟数据验证详情

### UC-1: 扩展开发者跨仓库改动 — 边界 coding-workflow → pi-subagent (model)

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "修改 subagent model resolve 策略，增加 'ultra' complexity 级别",
  "input_data": {
    "changed_file": "packages/subagent/src/model.ts",
    "change_type": "add 'ultra' to TaskComplexity union + COMPLEXITY_DEFAULT_THINKING"
  }
}
```

**执行路径推演：**
```
修改 packages/subagent/src/model.ts (TaskComplexity, THINKING_TO_PI, resolveModelByComplexity)
  → review-dispatcher.ts L18-21: resolveModelByComplexity, COMPLEXITY_DEFAULT_THINKING
    → 从 "@zhushanwen/pi-subagent" 导入 ← workspace:* 解析 ✅ 自动获得更新
  → review-dispatcher.ts L13-17: runSingleAgent, getFinalOutput, cleanupOldTempFiles
    → 从 "./subagent.js" 本地导入 ← ❌ 不受 model.ts 变更影响（但不应该从这里导入）
  → coding-workflow/lib/subagent.ts L12-13: ThinkingLevel, THINKING_TO_PI
    → 从 "@zhushanwen/pi-subagent" 导入 ← ✅ 自动获得更新
  → coding-workflow/lib/subagent.ts L131-204: getPiInvocation + runSingleAgent 本地逻辑
    → 不依赖 model.ts ← 无影响
```

**结论：** model resolve 链路正确去重，spawn 链路仍走本地副本。主数据路径（model → review dispatch）无问题。

### UC-4: 维护者迁移 harness skill — 边界 Pi discovery → coding-workflow/skills/

**模拟数据：**
```json
{
  "uc_id": "UC-4",
  "scenario": "用户通过 npm 安装 pi-coding-workflow，无预装 skills",
  "input_data": {
    "install_method": "npm install @zhushanwen/pi-coding-workflow",
    "skill_request": "xyz-harness-gate-reviewer"
  }
}
```

**执行路径推演：**
```
Pi 启动，加载 extension: codingWorkflowExtension(pi)
  → Pi 执行 skill discovery:
    → 扫描 ~/.pi/agent/skills/ → 未安装 bundled skills ← 空
    → 扫描 .pi/skills/ → 项目级未配置 ← 空
  → before_agent_start 触发:
    → skillResolver.setSkills(event.systemPromptOptions.skills) ← 空列表
  → Gate 通过后 dispatchReviewSubagent():
    → skillResolver.resolve("xyz-harness-gate-reviewer")
    → #skills.find("xyz-harness-gate-reviewer") ← 不在注入列表
    → #findFallbackPath("xyz-harness-gate-reviewer")
      → ~/.pi/agent/skills/xyz-harness-gate-reviewer/SKILL.md ← 不存在
      → .pi/skills/xyz-harness-gate-reviewer/SKILL.md ← 不存在
      → ❌ 抛出 Error "not found"
  → Gate review 失败 ← 核心功能不可用
```

**异常路径（当前部署模式）：**
```
维护者预装 skills（symlink 到 ~/.pi/agent/skills/）
  → Pi discovery 发现 skills ← 注入列表非空
  → skillResolver.resolve() 在注入列表中找到 ← ✅
  → 当前可用，但这是外部安装而非自动注册
```

**结论：** MUST_FIX。SkillResolver 缺少 bundled path fallback。修复方案：在 `#findFallbackPath` 的候选列表头部添加 `path.join(__dirname, "..", "skills", name, "SKILL.md")`。`__dirname` 由 `import.meta.url` 解析（已在 index.ts L77 中使用相同模式），指向已安装的包根目录。

### UC-4: evolve-daily skill 注册 — 边界 Pi discovery → evolve-daily/skills/

**模拟数据：**
```json
{
  "uc_id": "UC-4",
  "scenario": "用户尝试 /evolve-report",
  "input_data": {
    "command": "/evolve-report",
    "skill_name": "evolve-report"
  }
}
```

**执行路径推演：**
```
Pi 启动，加载 extension: evolveDailyExtension(pi)
  → 注册 session_start 事件（analyzer 执行）
  → 无 resources_discover 注册
  → 无 before_agent_start 注册
  → Pi skill discovery 不包含 evolve/evolve-apply/evolve-report
  → 用户输入 /evolve-report ← Pi 识别为未知命令
  → 功能不可用 ← ❌（除非手动 symlink）
```

**结论：** LOW。当前通过手动 symlink 绕过，但违背 extension-bundled skills 的自动注册设计意图。

### UC-3: eslint taste-lint 路径

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "运行 pnpm lint",
  "input_data": {
    "command": "pnpm -r lint",
    "config_path": "eslint.config.mjs"
  }
}
```

**执行路径推演：**
```
eslint.config.mjs:
  → import tasteConfig from './packages/taste-lint/base.mjs'
  → packages/taste-lint/base.mjs 存在 ✅
  → base.mjs import rules from './rules/*.mjs'
  → packages/taste-lint/rules/ 包含 5 个规则文件 ✅
  → tastePlugin 定义 5 条规则 ✅
  → export default tasteConfig ← 导出 ESLint flat config ✅
```

**结论：** 无问题。路径正确，taste-lint 作为 monorepo 内的本地包通过相对路径引用。

## 结构合规性验证

### 模块边界检查

| 边界 | 类型 | 检查结果 | 说明 |
|------|------|----------|------|
| coding-workflow → pi-subagent (workspace:*) | pnpm workspace | ✅ | package.json 正确声明，resolveModelByComplexity 等已从 pi-subagent 导入 |
| coding-workflow → local subagent.ts | 文件内引用 | ❌ | 284+145 行本地副本，应从 pi-subagent 导入（#2） |
| coding-workflow/skills/ → SkillResolver | 运行时发现 | ❌ | SkillResolver 不搜索 bundled path（#1） |
| evolve-daily/skills/ → Pi discovery | 运行时发现 | ❌ | 无注册机制（#3） |
| eslint.config.mjs → taste-lint | 相对路径导入 | ✅ | `./packages/taste-lint/base.mjs` 路径正确 |
| pnpm-workspace.yaml | workspace 配置 | ✅ | `packages: ["packages/*"]` 覆盖所有包 |
| skills/ (独立) | 目录结构 | ⚠️ | 9/10 skills（缺 remove-worktree，BLR #1 已记录） |

### 包解析链路

```
pnpm-workspace.yaml: packages: ["packages/*"]
  → packages/coding-workflow/
    → dependencies: @zhushanwen/pi-subagent "workspace:*"
      → 解析到 packages/subagent/ ← pnpm link ✅
    → peerDependencies: @mariozechner/pi-coding-agent >=0.1.0
      → 运行时由 Pi 进程提供 ✅
  → packages/evolve-daily/
    → 无内部依赖 ✅
    → peerDependencies: @mariozechner/pi-coding-agent * ✅
  → packages/taste-lint/
    → 被根 eslint.config.mjs 引用（相对路径，非 workspace 依赖）✅
```

## 结论

**Pass — 核心数据链路正确，有 2 个 MUST_FIX 影响功能完整性。**

Monorepo 骨架的模块边界设计正确：pnpm workspace 解析通畅，taste-lint 路径正确，model resolve 去重完成。两个 MUST_FIX 均集中在 skill 发现和 spawn 去重：

1. **SkillResolver bundled path 缺失**（#1）：修复简单，在 `#findFallbackPath` 添加一行候选路径。这是 npm 安装场景的功能性阻断——不修复则非预装用户无法使用 gate review。

2. **subagent spawn 去重不完整**（#2）：修复复杂度较高，需要将 `ProcessManager` + `runSingleAgent` 贡献到 pi-subagent 包。当前功能不受影响（本地副本可工作），但维护成本倍增——每次 pi-subagent spawn 逻辑变更都需要同步两处。建议作为独立 task 处理，不阻塞 monorepo 合并。
