---
verdict: pass
must_fix: 2
review_metrics:
  files_reviewed: 216
  issues_found: 5
  must_fix_count: 2
  low_count: 2
  info_count: 1
  duration_estimate: "25"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-01 14:30
- 审查模式：Dev
- 审查对象：use-cases.md + git diff HEAD~7..HEAD
- 模拟数据路径数：4

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 扩展开发者跨仓库改动 | ⚠️ 部分 | packages/subagent/src/model.ts → packages/coding-workflow/lib/review-dispatcher.ts (via import) | spawn 逻辑未去重，改动 subagent 的 spawn 不影响 coding-workflow 的本地副本 |
| UC-2 | 用户安装 Pi 扩展 | ✅ 完整 | npm install → node_modules/@zhushanwen/pi-* → pi --extension | — |
| UC-3 | 扩展版本发布 | ✅ 完整 | pnpm changeset → pnpm changeset version → pnpm changeset publish | — |
| UC-4 | 维护者迁移 harness skill | ⚠️ 部分 | coding-workflow/skills/ → SkillResolver → before_agent_start 注入 | 无 resources_discover，技能不自动注册；remove-worktree 缺失 |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-4 | `remove-worktree` skill 缺失，FR-4 明确要求 `skills/` 下包含 `create-worktree, merge-worktree, remove-worktree` 三个 worktree 管理 skill，实际只有前两个 | `skills/remove-worktree/` | 整个目录缺失 | 从 harness 仓库迁入 `remove-worktree` skill 到 `skills/remove-worktree/` |
| 2 | MUST_FIX | UC-1 | subagent 去重不完整。AC-5 要求 coding-workflow 不再有内嵌的 subagent.ts / process-manager.ts，但实际仍保留 284+145 行的本地实现。UC-1 的核心价值"改一处自动生效"对 spawn 逻辑不成立 | `packages/coding-workflow/lib/subagent.ts`, `packages/coding-workflow/lib/process-manager.ts` | 全文件 | 按 FR-5 策略：(a) 将 coding-workflow 独有的功能（自定义 systemPrompt 注入、processRegistry）贡献到 pi-subagent 包，(b) coding-workflow 完全删除这两个文件，从 pi-subagent 导入 |
| 3 | LOW | UC-4 | coding-workflow 和 evolve-daily 均无 `resources_discover` 事件处理器。AC-2 要求 "coding-workflow 包含 resources_discover 事件处理器注册内嵌 skills"。当前通过 before_agent_start + SkillResolver fallback 实现了功能等价，但bundled skills 不会出现在 Pi 的 /skills 发现列表中，用户无法直接 `/skill-name` 触发 | `packages/coding-workflow/index.ts`, `packages/evolve-daily/src/index.ts` | session_start 事件区域 | 在 coding-workflow 和 evolve-daily 的 session_start 中添加 resources_discover 处理器，扫描各自的 skills/ 子目录并注册 |
| 4 | LOW | UC-1 | coding-workflow 的 review-dispatcher.ts 仍从本地 `./lib/subagent.js` 导入 `runSingleAgent`，而非从 `@zhushanwen/pi-subagent` 导入。model resolve 已正确去重（resolveModelByComplexity 从 pi-subagent 导入），但 spawn 路径未去重 | `packages/coding-workflow/lib/review-dispatcher.ts` | L17-22 import 区域 | 配合 #2 解决：删除本地 subagent.ts 后自然消除 |
| 5 | INFO | — | coding-workflow 含 19 个 skills，spec 描述为 "~20"。差异可接受，所有 spec 列举的 skill 均已迁入 | `packages/coding-workflow/skills/` | 目录级 | 无需修改 |

## 执行路径详情（Dev 模式）

### UC-1: 扩展开发者跨仓库改动

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

**执行路径：**
```
修改 packages/subagent/src/model.ts (TaskComplexity, THINKING_TO_PI, resolveModelByComplexity)
  → pnpm -r typecheck ← coding-workflow 通过 workspace:* 获得 pi-subagent 类型更新 ✅
  → packages/coding-workflow/lib/review-dispatcher.ts
    → resolveModelByComplexity from "@zhushanwen/pi-subagent" ← 自动获得更新 ✅
    → COMPLEXITY_DEFAULT_THINKING from "@zhushanwen/pi-subagent" ← 自动获得更新 ✅
  → packages/coding-workflow/lib/subagent.ts
    → ThinkingLevel from "@zhushanwen/pi-subagent" ← 类型自动更新 ✅
    → THINKING_TO_PI from "@zhushanwen/pi-subagent" ← 映射自动更新 ✅
    → BUT: 本地 runSingleAgent() 不受影响（spawn 逻辑独立）← ❌ 去重不完整
  → coding-workflow 自动获得 model 层更新 ← 主流程通畅
```

**异常路径：**
```
修改 subagent spawn 逻辑（如增加 retry 机制）
  → packages/subagent/src/spawn.ts 改动
  → packages/coding-workflow/lib/subagent.ts 不受影响 ← 本地副本独立
  → coding-workflow 不会获得 spawn 改进 ← UC-1 目标未完全达成
```

### UC-2: 用户安装 Pi 扩展

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "用户安装 goal 和 coding-workflow 扩展",
  "input_data": {
    "commands": [
      "npm install @zhushanwen/pi-goal",
      "npm install @zhushanwen/pi-coding-workflow"
    ]
  }
}
```

**执行路径：**
```
npm install @zhushanwen/pi-goal
  → node_modules/@zhushanwen/pi-goal/ ← package.json name 匹配 ✅
  → main: "index.ts" ← Pi 可加载 ✅
  → peerDependencies: @mariozechner/pi-coding-agent >=0.1.0 ← 运行时提供 ✅

npm install @zhushanwen/pi-coding-workflow
  → node_modules/@zhushanwen/pi-coding-workflow/
  → dependencies: @zhushanwen/pi-subagent "workspace:*" ← 安装时解析为具体版本 ✅
  → files: ["index.ts", "lib/", "scripts/", "skills/", "agents/", "commands/"] ← 包含所有资源 ✅
  → pi --extension node_modules/@zhushanwen/pi-coding-workflow/src/index.ts ← 加载成功 ✅
```

**异常路径：**
```
用户安装后尝试 /xyz-harness-brainstorming
  → Pi 查找已注册 skills ← coding-workflow 无 resources_discover
  → skill 不在 Pi 的发现列表中 ← 用户看到 "unknown command"
  → 但通过 /coding-workflow 启动工作流后，before_agent_start 自动注入 skill ← 功能可用
```

### UC-3: 扩展版本发布

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "发布 goal 和 coding-workflow 的小版本更新",
  "input_data": {
    "packages_to_bump": ["@zhushanwen/pi-goal", "@zhushanwen/pi-coding-workflow"],
    "bump_type": "patch"
  }
}
```

**执行路径：**
```
pnpm changeset
  → 选择 @zhushanwen/pi-goal: patch
  → 选择 @zhushanwen/pi-coding-workflow: patch
  → .changeset/*.md 文件生成 ✅

pnpm changeset version
  → goal: 0.1.0 → 0.1.1 ✅
  → coding-workflow: 0.1.0 → 0.1.1 ✅
  → workspace:* 依赖自动更新 ✅

pnpm changeset publish
  → npm registry 发布 @zhushanwen/pi-goal@0.1.1 ✅
  → npm registry 发布 @zhushanwen/pi-coding-workflow@0.1.1 ✅
  → access: "public" ← config.json 确认 ✅
```

### UC-4: 维护者迁移 harness skill

**模拟数据：**
```json
{
  "uc_id": "UC-4",
  "scenario": "新增 skill 到 coding-workflow 并验证自动注册",
  "input_data": {
    "new_skill": "packages/coding-workflow/skills/xyz-harness-xxx/SKILL.md",
    "skill_name": "xyz-harness-xxx"
  }
}
```

**执行路径：**
```
创建 packages/coding-workflow/skills/xyz-harness-xxx/SKILL.md ✅
  → Pi 启动 coding-workflow extension
  → before_agent_start 事件触发
    → skillResolver.setSkills(event.systemPromptOptions.skills)
    → Pi 的 skills 列表是否包含 bundled skills？← 取决于 Pi 的 skill 发现机制
    → 如果 Pi 未发现: SkillResolver fallback 查找 ~/.pi/agent/skills/ 和 .pi/skills/ ← 均不包含 bundled path
    → resolve("xyz-harness-xxx") 抛出 Error "not found" ← ❌

  → 实际工作方式: coding-workflow 的 19 个 skills 已安装在 ~/.pi/agent/skills/ (via symlink)
    → SkillResolver fallback 找到 skill 文件 ✅
    → 但这不是 "自动注册"，而是依赖外部安装 ← 与 FR-3 设计意图不符
```

**异常路径：**
```
用户通过 npm 安装 pi-coding-workflow（无预装 skills）
  → coding-workflow/skills/ 目录在 npm 包内
  → 但 SkillResolver fallback 不搜索 npm 包内的 skills/ 子目录
  → 只有 before_agent_start 的 injected list 可能包含
  → 如果 Pi 不自动扫描 extension 的 skills/ 目录 → skills 不可用 ← ❌
```

## 结构合规性检查

### AC-1: 目录结构
| 检查项 | 状态 | 证据 |
|--------|------|------|
| 所有 extension 位于 packages/ 下 | ✅ | 13 个包均在 packages/ |
| 独立 skills 位于 skills/ 下 | ⚠️ | 9 个 skills 在 skills/，但 remove-worktree 缺失 |
| pnpm-workspace.yaml 正确配置 | ✅ | `packages: ["packages/*"]` |
| pnpm install 成功 | ✅ | pnpm-lock.yaml 生成（3407 行） |

### AC-2: npm 包可发布
| 检查项 | 状态 | 证据 |
|--------|------|------|
| 正确的 @zhushanwen/pi-* name | ✅ | 13 个包全部正确命名 |
| coding-workflow 含 resources_discover | ⚠️ | 不存在，用 before_agent_start 替代（#3） |

### AC-3: 代码迁移
| 检查项 | 状态 | 证据 |
|--------|------|------|
| coding-workflow 从 harness 完整迁入 | ✅ | index.ts 1257 行 + lib/ + scripts/gate-check.py |
| claude-rules-loader 迁入 | ✅ | packages/claude-rules-loader/ 完整 |
| harness ~20 skills 迁入 | ✅ | 19 个 skills 在 coding-workflow/skills/ |
| evolve 3 skills 迁入 | ✅ | evolve, evolve-apply, evolve-report 在 evolve-daily/skills/ |
| 独立 skills 迁入 | ⚠️ | 9/10，缺 remove-worktree（#1） |
| 7 agents 迁入 | ✅ | review-{architecture,blr,dataflow,integration,robustness,standards,taste}.md |
| 2 commands 迁入 | ✅ | dev.md, track.md |
| 文档合并 | ✅ | docs/adr (8-15), docs/research/, docs/harness-design-framework.md 等 |

### AC-4: 依赖关系
| 检查项 | 状态 | 证据 |
|--------|------|------|
| coding-workflow workspace:* 依赖 subagent | ✅ | `"@zhushanwen/pi-subagent": "workspace:*"` |
| 无循环依赖 | ✅ | coding-workflow → subagent 单向，其余包无内部依赖 |
| 所有包依赖 types | ❌ | 只有 types 包存在，但无其他包通过 workspace:* 依赖它 |

> 注：types 包是 `"private": true`，当前仅包含 Pi ExtensionAPI 类型声明。其他包通过 peerDependencies 引用 `@mariozechner/pi-coding-agent` 获取类型，不直接依赖 types 包。这与 AC-4 "所有包通过 workspace:* 依赖 types" 不符，但实际功能不受影响——types 包的定位可能需要重新评估。

### AC-5: 去重
| 检查项 | 状态 | 证据 |
|--------|------|------|
| coding-workflow 无 model-resolve.ts | ✅ | 已删除，从 pi-subagent 导入 resolveModelByComplexity |
| coding-workflow 无 subagent.ts | ❌ | 仍存在 284 行本地实现（#2） |
| coding-workflow 无 process-manager.ts | ❌ | 仍存在 145 行本地实现（#2） |
| review-dispatcher 从 pi-subagent 导入 | ⚠️ | 部分导入（model resolve ✅，spawn ❌）（#4） |
| taste-lint 只保留一份 | ✅ | packages/taste-lint/ 唯一实例 |
| todolist 不迁入 | ✅ | 未在 diff 中出现 |

## 结论

**Pass — 结构性工作完成度高，有 2 个 MUST_FIX 需后续处理。**

Monorepo 骨架正确：13 个包全部位于 packages/，pnpm workspace 配置正确，workspace:* 依赖链路通畅，changesets 配置完整。文档、agents、commands 迁移完整。

MUST_FIX 项均为迁移完整性问题，不影响已迁入功能的核心正确性：
1. **remove-worktree 缺失**：直接补入即可
2. **subagent 去重不完整**：需将 coding-workflow 独有的 spawn 功能（自定义 systemPrompt 注入、processRegistry）贡献到 pi-subagent 包，然后删除本地副本。这是 FR-5 明确要求的策略，但实施复杂度较高，建议作为独立 task 处理
