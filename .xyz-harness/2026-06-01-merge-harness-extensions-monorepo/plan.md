---
verdict: pass
complexity: L1
---

# Monorepo 合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 xyz-pi-extensions 和 xyz-harness-engineering 两个仓库合并为 pnpm workspaces monorepo，每个 extension 作为独立 npm 包发布到 `@zhushanwen` scope。

**Architecture:** 纯结构重构，不改变任何 extension 的运行时行为。核心操作是目录移动（git mv）、package.json 更新、import 路径调整。coding-workflow 的内嵌 subagent 实现替换为对 `@zhushanwen/pi-subagent` 的 workspace 依赖。

**Tech Stack:** pnpm workspaces, changesets, TypeScript (no build step), Pi Extension API

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `pnpm-workspace.yaml` | create | BG1 | pnpm workspace 配置 |
| `package.json` (root) | modify | BG1 | 更新为 monorepo root |
| `tsconfig.json` (root) | modify | BG1 | include 改为 `packages/**` |
| `.changeset/config.json` | create | BG1 | changesets 配置 |
| `packages/goal/` | move (from `./goal/`) | BG1 | goal extension |
| `packages/todo/` | move (from `./todo/`) | BG1 | todo extension |
| `packages/subagent/` | move (from `./subagent/`) | BG1 | subagent extension |
| `packages/context-engineering/` | move (from `./context-engineering/`) | BG1 | context-engineering extension |
| `packages/skill-state/` | move (from `./skill-state/`) | BG1 | skill-state extension |
| `packages/evolve-daily/` | move (from `./evolve-daily/`) | BG1 | evolve-daily extension |
| `packages/statusline/` | move (from `./statusline/`) | BG1 | statusline extension |
| `packages/unified-hooks/` | move (from `./unified-hooks/`) | BG1 | unified-hooks extension |
| `packages/workflow/` | move (from `./workflow/`) | BG1 | workflow extension |
| `packages/taste-lint/` | move (from `./taste-lint/`) | BG1 | taste-lint ESLint plugin |
| `packages/types/` | move (from `./types/`) | BG1 | 共享类型定义 |
| `packages/coding-workflow/` | create (从 harness 复制) | BG2 | coding-workflow extension |
| `packages/coding-workflow/index.ts` | create | BG2 | 从 harness 复制 + 改 import |
| `packages/coding-workflow/lib/gate-runner.ts` | create | BG2 | 从 harness 复制 |
| `packages/coding-workflow/lib/review-dispatcher.ts` | create | BG2 | 从 harness 复制 + 改 import |
| `packages/coding-workflow/lib/skill-resolver.ts` | create | BG2 | 从 harness 复制 |
| `packages/coding-workflow/scripts/gate-check.py` | create | BG2 | 从 harness 复制 |
| `packages/coding-workflow/skills/` | create (从 harness 复制) | BG2 | ~20 个 harness skills |
| `packages/coding-workflow/agents/` | create (从 harness 复制) | BG2 | 7 个 review agent .md |
| `packages/coding-workflow/commands/` | create (从 harness 复制) | BG2 | 2 个 command .md |
| `packages/coding-workflow/package.json` | create | BG2 | 新 package.json |
| `packages/claude-rules-loader/` | create (从 harness 复制) | BG3 | claude-rules-loader extension |
| `packages/evolve-daily/skills/` | move (from `./skills/evolve*`) | BG3 | evolve 3 skills 内嵌 |
| `skills/` | create (从 harness 复制) | BG4 | 独立 skills |
| `docs/` (harness 文档) | create | BG4 | 合并 harness 文档 |
| `scripts/validate-skill-yaml.py` | create (从 harness 复制) | BG4 | 共享脚本 |
| 每个 `packages/*/package.json` | modify | BG5 | 更新 name、files 等 |

## Interface Contracts

本 plan 为纯结构重构，无新公开接口。接口契约聚焦于 **coding-workflow 的 subagent 依赖替换**——唯一涉及 import 路径变更的模块。

### Module: @zhushanwen/pi-subagent

#### 消费方：coding-workflow

| 当前 import 来源 | 需要的 export | 替换为 | Spec Ref |
|-----------------|--------------|--------|----------|
| `./lib/subagent.js` | `formatUsageStats` | `@zhushanwen/pi-subagent` (render.ts) | AC-5 |
| `./lib/subagent.js` | `runSingleAgent` | `@zhushanwen/pi-subagent` (spawn.ts → SpawnManager) | AC-5 |
| `./lib/subagent.js` | `UsageStats`, `SingleResult`, `OnUpdateCallback` | `@zhushanwen/pi-subagent` (render.ts) | AC-5 |
| `./lib/subagent.js` | `cleanupOldTempFiles` | `@zhushanwen/pi-subagent` (spawn.ts) | AC-5 |
| `./lib/subagent.js` | `getFinalOutput` | `@zhushanwen/pi-subagent` (render.ts) | AC-5 |
| `./lib/model-resolve.js` | `resolveModel`, `ThinkingLevel`, `THINKING_TO_PI` | `@zhushanwen/pi-subagent` (model.ts) | AC-5 |

**差异分析结果：** pi-subagent 包已包含 coding-workflow 所需的全部 export（`formatUsageStats`、`runSingleAgent` 通过 SpawnManager、`UsageStats`、`SingleResult`、`OnUpdateCallback`、`cleanupOldTempFiles`、`getFinalOutput`、`resolveModel`、`ThinkingLevel`、`THINKING_TO_PI`）。`process-manager.ts` 的功能被 pi-subagent 的 `spawn.ts` 内部管理，coding-workflow 不直接使用。因此可以安全删除 coding-workflow 内嵌的 3 个文件。

**注意**：`review-dispatcher.ts` 中 `runSingleAgent` 的调用模式（参数签名）需要与 pi-subagent 的 `SpawnManager` 对齐。如果签名不同，需要写适配层。

### Module: resources_discover 回调

| Extension | 回调行为 | Spec Ref |
|-----------|---------|----------|
| coding-workflow | `session_start` 时扫描 `__dirname/skills/` 下所有 SKILL.md，通过 `resources_discover` 注册 | AC-2, FR-3 |
| evolve-daily | `session_start` 时扫描 `__dirname/skills/` 下 evolve/evolve-apply/evolve-report，通过 `resources_discover` 注册 | FR-3 |

## Spec Coverage Matrix

| Spec AC | Interface Method / Action | Data Flow | Task |
|---------|--------------------------|-----------|------|
| AC-1 (目录结构) | git mv + mkdir | N/A | Task 1, 2 |
| AC-2 (npm 包可发布) | package.json name/files + changeset config | N/A | Task 2, 10 |
| AC-2 (resources_discover) | coding-workflow resources_discover 回调 | `session_start` → scan skills/ → `pi.emit('resources_discover', ...)` | Task 5 |
| AC-3 (代码迁移) | cp -r from harness repo | harness → packages/coding-workflow | Task 3, 4, 5, 7, 8 |
| AC-4 (依赖关系) | package.json dependencies + import rewrite | coding-workflow → @zhushanwen/pi-subagent | Task 6 |
| AC-5 (去重) | 删 lib/subagent.ts 等 3 文件 + 改 import | review-dispatcher.ts → @zhushanwen/pi-subagent | Task 6 |
| AC-6 (typecheck) | pnpm -r typecheck | N/A | Task 10 |
| AC-7 (功能回归) | Pi 加载 extensions smoke test | N/A | Task 11 |
| AC-8 (归档) | harness README 更新 | N/A | Task 12 |
| AC-9 (里程碑) | CP-1→CP-4 检查点 | N/A | 每波次末尾 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 目录结构 | adopted | Task 1, 2 |
| AC-2 npm 包可发布 | adopted | Task 2, 10 |
| AC-3 代码迁移 | adopted | Task 3, 4, 5, 7, 8 |
| AC-4 依赖关系 | adopted | Task 6 |
| AC-5 去重 | adopted | Task 6 |
| AC-6 类型检查通过 | adopted | Task 10 |
| AC-7 功能回归验证 | adopted | Task 11 |
| AC-8 归档 | adopted | Task 12 |
| AC-9 CP-1 | adopted | Task 2 完成后验证 |
| AC-9 CP-2 | adopted | Task 6 完成后验证 |
| AC-9 CP-3 | adopted | Task 5, 7 完成后验证 |
| AC-9 CP-4 | adopted | Task 10 完成后验证 |
| FR-1 目录结构 | adopted | Task 1, 2 |
| FR-2 独立 npm 包 | adopted | Task 2, 10 |
| FR-3 Skills 内嵌 | adopted | Task 5, 7 |
| FR-4 独立 Skills | adopted | Task 8 |
| FR-5 subagent 去重 | adopted | Task 6 |
| FR-6 todolist 不迁入 | adopted | 不迁入（无 task） |
| FR-7 edit-whitespace-normalizer 删除 | adopted | 不迁入（无 task） |
| FR-8 独立版本管理 | adopted | Task 10 |
| FR-9 共享类型包 | adopted | Task 2 |

---

## Task List

### Task 1: 创建 Monorepo 基础设施

**Type:** backend

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root)
- Modify: `tsconfig.json` (root)
- Create: `.changeset/config.json`

- [ ] **Step 1: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: 更新根 package.json**

将根 package.json 转为 monorepo root：

```json
{
  "name": "xyz-pi-extensions",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "pnpm -r lint",
    "lint:fix": "pnpm -r lint:fix",
    "typecheck": "pnpm -r typecheck",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "pnpm -r typecheck && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0",
    "eslint": "^9",
    "typescript-eslint": "^8.60.0"
  }
}
```

- [ ] **Step 3: 更新根 tsconfig.json**

将 `include` 改为 `packages/**`，保持 paths 映射不变：

```json
{
  "include": [
    "shared/**/*.ts",
    "packages/**/*.ts"
  ],
  "exclude": [
    "node_modules",
    ".superpowers",
    ".xyz-harness",
    "**/__tests__",
    "**/node_modules"
  ]
}
```

- [ ] **Step 4: 创建 .changeset/config.json**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 5: 安装依赖 + 验证**

```bash
pnpm install
# 确认无报错
```

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.json .changeset/
git commit -m "chore: set up pnpm workspaces monorepo infrastructure"
```

---

### Task 2: 迁移现有 10 个 Extension 到 packages/

**Type:** backend

**Files:**
- Move: `goal/` → `packages/goal/`
- Move: `todo/` → `packages/todo/`
- Move: `subagent/` → `packages/subagent/`
- Move: `context-engineering/` → `packages/context-engineering/`
- Move: `skill-state/` → `packages/skill-state/`
- Move: `evolve-daily/` → `packages/evolve-daily/`
- Move: `statusline/` → `packages/statusline/`
- Move: `unified-hooks/` → `packages/unified-hooks/`
- Move: `workflow/` → `packages/workflow/`
- Move: `taste-lint/` → `packages/taste-lint/`
- Move: `types/` → `packages/types/`

- [ ] **Step 1: 创建 packages/ 目录并 git mv 所有 extension**

```bash
mkdir -p packages
git mv goal packages/goal
git mv todo packages/todo
git mv subagent packages/subagent
git mv context-engineering packages/context-engineering
git mv skill-state packages/skill-state
git mv evolve-daily packages/evolve-daily
git mv statusline packages/statusline
git mv unified-hooks packages/unified-hooks
git mv workflow packages/workflow
git mv taste-lint packages/taste-lint
git mv types packages/types
```

- [ ] **Step 2: 更新每个包的 package.json**

对每个 extension 包，更新 package.json 的 name 为 `@zhushanwen/pi-<name>`：

| 包目录 | name |
|--------|------|
| packages/goal | `@zhushanwen/pi-goal` |
| packages/todo | `@zhushanwen/pi-todo` |
| packages/subagent | `@zhushanwen/pi-subagent` |
| packages/context-engineering | `@zhushanwen/pi-context-engineering` |
| packages/skill-state | `@zhushanwen/pi-skill-state` |
| packages/evolve-daily | `@zhushanwen/pi-evolve-daily` |
| packages/statusline | `@zhushanwen/pi-statusline` |
| packages/unified-hooks | `@zhushanwen/pi-unified-hooks` |
| packages/workflow | `@zhushanwen/pi-workflow` |
| packages/taste-lint | `@zhushanwen/pi-taste-lint` |
| packages/types | `@zhushanwen/pi-types`（加 `"private": true`） |

每个 package.json 增加 `files` 白名单：

```json
{
  "files": ["src/", "index.ts", "skills/", "scripts/"],
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.1.0"
  }
}
```

- [ ] **Step 3: 运行 pnpm install + typecheck (CP-1)**

```bash
pnpm install
pnpm -r typecheck
# 预期：PASS（只是目录移动，代码不变）
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move existing extensions to packages/ directory"
```

---

### Task 3: 迁移 coding-workflow 从 harness 仓库

**Type:** backend

**Files:**
- Create: `packages/coding-workflow/index.ts` (从 harness 复制)
- Create: `packages/coding-workflow/lib/gate-runner.ts`
- Create: `packages/coding-workflow/lib/review-dispatcher.ts`
- Create: `packages/coding-workflow/lib/skill-resolver.ts`
- Create: `packages/coding-workflow/scripts/gate-check.py`
- Create: `packages/coding-workflow/package.json`

- [ ] **Step 1: 从 harness 仓库复制 coding-workflow（排除 subagent 三文件和 node_modules）**

```bash
mkdir -p packages/coding-workflow/lib packages/coding-workflow/scripts
# 复制源文件（排除 node_modules、subagent.ts、model-resolve.ts、process-manager.ts、package-lock.json）
cp /path/to/xyz-harness-engineering/extensions/coding-workflow/index.ts packages/coding-workflow/
cp /path/to/xyz-harness-engineering/extensions/coding-workflow/lib/gate-runner.ts packages/coding-workflow/lib/
cp /path/to/xyz-harness-engineering/extensions/coding-workflow/lib/review-dispatcher.ts packages/coding-workflow/lib/
cp /path/to/xyz-harness-engineering/extensions/coding-workflow/lib/skill-resolver.ts packages/coding-workflow/lib/
cp /path/to/xyz-harness-engineering/extensions/coding-workflow/gate-check.py packages/coding-workflow/scripts/
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "@zhushanwen/pi-coding-workflow",
  "version": "0.1.0",
  "description": "5-phase coding workflow orchestration",
  "main": "index.ts",
  "files": ["src/", "index.ts", "lib/", "scripts/", "skills/", "agents/", "commands/"],
  "dependencies": {
    "@zhushanwen/pi-subagent": "workspace:*",
    "js-yaml": "^4.1.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.1.0"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/coding-workflow/
git commit -m "feat: migrate coding-workflow from harness repo"
```

---

### Task 4: 迁移 claude-rules-loader

**Type:** backend

**Files:**
- Create: `packages/claude-rules-loader/index.ts`
- Create: `packages/claude-rules-loader/package.json`

- [ ] **Step 1: 从 harness 仓库复制**

```bash
mkdir -p packages/claude-rules-loader
cp /path/to/xyz-harness-engineering/extensions/claude-rules-loader/index.ts packages/claude-rules-loader/
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "@zhushanwen/pi-claude-rules-loader",
  "version": "0.1.0",
  "description": "Load CLAUDE.md rules for Pi coding agent",
  "main": "index.ts",
  "files": ["index.ts"],
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.1.0"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-rules-loader/
git commit -m "feat: migrate claude-rules-loader from harness repo"
```

---

### Task 5: 迁移 harness skills 到 coding-workflow + 添加 resources_discover

**Type:** backend

**Files:**
- Create: `packages/coding-workflow/skills/` (19 个 skill 目录)
- Modify: `packages/coding-workflow/index.ts` (添加 resources_discover 事件)

- [ ] **Step 1: 从 harness 仓库复制所有 coding-workflow 所属 skills**

```bash
mkdir -p packages/coding-workflow/skills
```bash
mkdir -p packages/coding-workflow/skills
# 复制 19 个 coding-workflow 所属 skills（不含独立 skills）
for skill in xyz-harness-brainstorming xyz-harness-writing-plans xyz-harness-phase-dev \
  xyz-harness-phase-test xyz-harness-phase-pr xyz-harness-gate xyz-harness-gate-reviewer \
  xyz-harness-expert-reviewer xyz-harness-business-logic-reviewer xyz-harness-integration-reviewer \
  xyz-harness-robustness-reviewer xyz-harness-standards-reviewer xyz-harness-code-standard-protection \
  xyz-harness-backend-dev xyz-harness-frontend-dev xyz-harness-test-driven-development \
  xyz-harness-subagent-driven-development harness-retrospect harness-retrospect-collector; do
  if [ -d "/path/to/xyz-harness-engineering/skills/$skill" ]; then
    cp -r "/path/to/xyz-harness-engineering/skills/$skill" "packages/coding-workflow/skills/"
  fi
done
```

**coding-workflow 专属 skills 清单（19 个）：**

1. xyz-harness-brainstorming
2. xyz-harness-writing-plans
3. xyz-harness-phase-dev
4. xyz-harness-phase-test
5. xyz-harness-phase-pr
6. xyz-harness-gate
7. xyz-harness-gate-reviewer
8. xyz-harness-expert-reviewer
9. xyz-harness-business-logic-reviewer
10. xyz-harness-integration-reviewer
11. xyz-harness-robustness-reviewer
12. xyz-harness-standards-reviewer
13. xyz-harness-code-standard-protection
14. xyz-harness-backend-dev
15. xyz-harness-frontend-dev
16. xyz-harness-test-driven-development
17. xyz-harness-subagent-driven-development
18. harness-retrospect
19. harness-retrospect-collector

- [ ] **Step 2: 在 coding-workflow/index.ts 中添加 resources_discover 事件**

在 `coding-workflowExtension(pi)` 工厂函数的 `session_start` 事件处理中，添加 skill 发现和注册逻辑：

```typescript
pi.on("session_start", async (_ctx) => {
  // ... 现有 session_start 逻辑 ...

  // 注册内嵌 skills
  const skillsDir = path.join(__dirname, "skills");
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir).filter(d =>
      fs.existsSync(path.join(skillsDir, d, "SKILL.md"))
    );
    for (const skillName of entries) {
      pi.emit("resources_discover", {
        type: "skill",
        name: skillName,
        path: path.join(skillsDir, skillName),
      });
    }
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/coding-workflow/skills/ packages/coding-workflow/index.ts
git commit -m "feat: migrate harness skills and add resources_discover"
```

---

### Task 6: Subagent 去重 — 替换 coding-workflow 内嵌 subagent 为 workspace 依赖

**Type:** backend

**Files:**
- Modify: `packages/coding-workflow/lib/review-dispatcher.ts` (改 import 路径)
- Modify: `packages/coding-workflow/index.ts` (改 import 路径)

- [ ] **Step 1: 分析 import 签名差异**

对比 coding-workflow/lib/subagent.ts 的 `runSingleAgent` 和 pi-subagent 的 `SpawnManager` 调用方式。

**coding-workflow review-dispatcher.ts 当前调用：**
```typescript
import { runSingleAgent, SubagentOpts, SubagentResult, formatUsageStats } from "./subagent.js";
import { resolveModel, ThinkingLevel, THINKING_TO_PI } from "./model-resolve.js";
```

**pi-subagent 包对应 export：**
- `runSingleAgent` → `spawn.ts` 中的 `SpawnManager` 接口（调用方式不同，需要写适配函数或直接调用 `createSpawnManager`）
- `formatUsageStats` → `render.ts`
- `UsageStats`、`SingleResult` → `render.ts`
- `OnUpdateCallback` → `spawn.ts`
- `cleanupOldTempFiles` → `spawn.ts`
- `getFinalOutput` → `render.ts`
- `resolveModel`、`resolveModelByComplexity` → `model.ts`
- `ThinkingLevel`、`THINKING_TO_PI` → `model.ts`

- [ ] **Step 2: 改写 review-dispatcher.ts 的 import**

将所有从 `./subagent.js` 和 `./model-resolve.js` 的 import 改为从 `@zhushanwen/pi-subagent` 导入：

```typescript
// 旧:
// import { runSingleAgent, SubagentOpts, SubagentResult, formatUsageStats } from "./subagent.js";
// import { resolveModel, ThinkingLevel, THINKING_TO_PI } from "./model-resolve.js";

// 新:
import { formatUsageStats, type UsageStats, type SingleResult } from "@zhushanwen/pi-subagent";
import { resolveModel, type ThinkingLevel, THINKING_TO_PI } from "@zhushanwen/pi-subagent";
```

如果 `runSingleAgent` 的调用签名与 pi-subagent 不兼容，需要写一个薄适配函数（放在 review-dispatcher.ts 内部）。

- [ ] **Step 3: 改写 index.ts 的 import**

```typescript
// 旧:
// import { formatUsageStats } from "./lib/subagent.js";

// 新:
import { formatUsageStats } from "@zhushanwen/pi-subagent";
```

- [ ] **Step 4: 删除内嵌的 subagent 三文件**

```bash
rm packages/coding-workflow/lib/subagent.ts
rm packages/coding-workflow/lib/model-resolve.ts
rm packages/coding-workflow/lib/process-manager.ts
```

- [ ] **Step 5: 运行 typecheck (CP-2)**

```bash
pnpm install
pnpm -r typecheck
# 预期：PASS。如果有类型错误，修复 import 路径或写适配
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: replace coding-workflow internal subagent with workspace dependency"
```

---

### Task 7: 迁移 evolve skills 到 evolve-daily + 添加 resources_discover

**Type:** backend

**Files:**
- Move: `skills/evolve/` → `packages/evolve-daily/skills/evolve/`
- Move: `skills/evolve-apply/` → `packages/evolve-daily/skills/evolve-apply/`
- Move: `skills/evolve-report/` → `packages/evolve-daily/skills/evolve-report/`
- Modify: `packages/evolve-daily/src/index.ts` (添加 resources_discover)
- Delete: `skills/` 目录（迁空后）

- [ ] **Step 1: 移动 evolve skills**

```bash
mkdir -p packages/evolve-daily/skills
git mv packages/../../skills/evolve packages/evolve-daily/skills/evolve
git mv packages/../../skills/evolve-apply packages/evolve-daily/skills/evolve-apply
git mv packages/../../skills/evolve-report packages/evolve-daily/skills/evolve-report
```

（实际路径根据 git mv 之后的相对位置调整）

- [ ] **Step 2: 在 evolve-daily/src/index.ts 中添加 resources_discover**

```typescript
pi.on("session_start", async (_ctx) => {
  // ... 现有 session_start 逻辑 ...

  const skillsDir = path.join(__dirname, "skills");
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir).filter(d =>
      fs.existsSync(path.join(skillsDir, d, "SKILL.md"))
    );
    for (const skillName of entries) {
      pi.emit("resources_discover", {
        type: "skill",
        name: skillName,
        path: path.join(skillsDir, skillName),
      });
    }
  }
});
```

- [ ] **Step 3: 更新 evolve-daily package.json files 字段**

确保 `files` 包含 `"skills/"`：

```json
{ "files": ["src/", "index.ts", "skills/"] }
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: embed evolve skills in evolve-daily with resources_discover"
```

---

### Task 8: 迁移独立 Skills + Agents + Commands

**Type:** backend

**Files:**
- Create: `skills/create-worktree/` 等 7 个独立 skill
- Create: `packages/coding-workflow/agents/` (7 个 .md 文件)
- Create: `packages/coding-workflow/commands/` (2 个 .md 文件)

- [ ] **Step 1: 迁移独立 skills 到 skills/ 目录**

```bash
mkdir -p skills
for skill in create-worktree merge-worktree remove-worktree code-review-worktree \
  zcommit browser-automation code-link meta-sk-agent-writer meta-sk-skill-writer vision-analysis; do
  cp -r "/path/to/xyz-harness-engineering/skills/$skill" "skills/"
done
```

- [ ] **Step 2: 迁移 agents**

```bash
mkdir -p packages/coding-workflow/agents
for agent in review-architecture review-blr review-dataflow review-integration \
  review-robustness review-standards review-taste; do
  cp "/path/to/xyz-harness-engineering/agents/${agent}.md" "packages/coding-workflow/agents/"
done
```

- [ ] **Step 3: 迁移 commands**

```bash
mkdir -p packages/coding-workflow/commands
cp "/path/to/xyz-harness-engineering/commands/dev.md" "packages/coding-workflow/commands/"
cp "/path/to/xyz-harness-engineering/commands/track.md" "packages/coding-workflow/commands/"
```

- [ ] **Step 4: Commit**

```bash
git add skills/ packages/coding-workflow/agents/ packages/coding-workflow/commands/
git commit -m "feat: migrate independent skills, agents, and commands"
```

---

### Task 9: 迁移 harness 文档和脚本

**Type:** backend

**Files:**
- Create: `docs/adr/` (合并 harness 的 ADR 0001-0008)
- Create: `docs/research/` (合并 harness 的 research)
- Create: `docs/harness-design-framework.md` 等
- Create: `scripts/validate-skill-yaml.py`

- [ ] **Step 1: 合并 harness 文档**

```bash
# ADR — 重新编号为 008-015（当前已有 001-007）
cp /path/to/xyz-harness-engineering/docs/adr/0001-six-dimension-evaluation-framework.md docs/adr/008-six-dimension-evaluation-framework.md
cp /path/to/xyz-harness-engineering/docs/adr/0002-integrate-grill-with-docs-as-steps.md docs/adr/009-integrate-grill-with-docs-as-steps.md
# ... 以此类推，共 8 个 ADR 文件

# 其他文档
cp /path/to/xyz-harness-engineering/docs/harness-design-framework.md docs/harness-design-framework.md
cp /path/to/xyz-harness-engineering/docs/harness-current-state-assessment.md docs/harness-current-state-assessment.md
cp -r /path/to/xyz-harness-engineering/docs/e2e-research docs/e2e-research
cp -r /path/to/xyz-harness-engineering/docs/improvement docs/improvement
cp -r /path/to/xyz-harness-engineering/docs/retrospectives docs/retrospectives

# research（不与现有 docs/research 冲突的文件）
cp /path/to/xyz-harness-engineering/docs/research/agent-md-writing-research.md docs/research/
cp /path/to/xyz-harness-engineering/docs/research/code-trace-ast-research.md docs/research/
# 等
```

- [ ] **Step 2: 迁移共享脚本**

```bash
mkdir -p scripts
cp /path/to/xyz-harness-engineering/scripts/validate-skill-yaml.py scripts/
```

- [ ] **Step 3: Commit**

```bash
git add docs/ scripts/
git commit -m "docs: merge harness documentation and scripts"
```

---

### Task 10: 更新所有 package.json + Changesets 配置验证

**Type:** backend

**Files:**
- Modify: 所有 `packages/*/package.json` (添加 typecheck 脚本、files、peerDependencies)
- Modify: `packages/types/package.json` (private: true)

- [ ] **Step 1: 确保每个包有 typecheck 脚本**

每个包的 package.json 添加：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

如果包内没有 tsconfig.json，创建一个继承根配置：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "./dist" },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 2: 验证 changesets 配置 (CP-4)**

```bash
pnpm changeset publish --dry-run
# 预期：列出所有包及其当前版本，无报错
```

- [ ] **Step 3: 最终 typecheck (AC-6)**

```bash
pnpm install
pnpm -r typecheck
# 预期：PASS
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: finalize package.json configs and changesets setup"
```

---

### Task 11: 功能回归验证 (AC-7)

**Type:** backend

**Files:**
- (无文件变更，纯验证)

- [ ] **Step 1: 在 Pi 中加载所有 extensions**

```bash
pi --extension packages/goal/index.ts \
   --extension packages/todo/index.ts \
   --extension packages/subagent/index.ts \
   --extension packages/coding-workflow/index.ts \
   --extension packages/claude-rules-loader/index.ts
# 预期：Pi 启动无错误，所有 extensions 加载成功
```

- [ ] **Step 2: 验证 coding-workflow gate tool**

在 Pi session 中：
```
/coding-workflow-gate(phase=1)
```
预期：gate check 脚本执行（即使返回 FAIL 也说明功能可用，只要不是加载错误）。

- [ ] **Step 3: 验证 goal_manager tool**

在 Pi session 中：
```
/goal Test goal --tokens 5000
```
预期：goal 创建成功。

- [ ] **Step 4: 验证 subagent basic single 模式**

在 Pi session 中通过 subagent tool 调用一个简单任务。

- [ ] **Step 5: 记录验证结果**

将验证结果写入 commit message 或注释。

---

### Task 12: 归档 harness 仓库 (AC-8)

**Type:** backend

**Files:**
- Modify: xyz-harness-engineering 仓库的 README.md

- [ ] **Step 1: 在 harness 仓库打 release tag**

```bash
cd /path/to/xyz-harness-engineering
git tag -a v-last-standalone -m "Last standalone version before monorepo merge"
git push origin v-last-standalone
```

- [ ] **Step 2: 更新 harness README.md**

在 README.md 顶部添加归档声明：

```markdown
# ⚠️ ARCHIVED

This repository has been merged into [xyz-pi-extensions](https://github.com/zhushanwen321/xyz-pi-extensions).

All extensions, skills, and documentation have been migrated to the monorepo structure.
No further development will occur in this repository.
```

- [ ] **Step 3: Commit + push**

```bash
git add README.md
git commit -m "docs: archive repository, migrated to xyz-pi-extensions monorepo"
git push
```

- [ ] **Step 4: 在 GitHub 上 archive 仓库**（Settings → Archive repository）

---

## Execution Groups

#### BG1: Monorepo 基础设施 + 现有 Extension 迁移

**Description:** 建立 monorepo 基础设施并将现有 10 个 extension 移入 packages/。这是后续所有任务的基础。

**Tasks:** Task 1, Task 2

**Files (预估):** ~25 个文件（4 create + 10 move + 10 modify + 1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-1, FR-2, FR-9; plan Task 1-2 完整描述 |
| 读取文件 | 根 package.json, tsconfig.json, 每个 extension 的 package.json |
| 修改/创建文件 | pnpm-workspace.yaml, package.json, tsconfig.json, .changeset/config.json, packages/*/package.json |

**Execution Flow (BG1 内部):** 串行。Task 1 先建立基础设施，Task 2 再迁移。

**Dependencies:** 无

---

#### BG2: Harness Extension 迁移 + Subagent 去重

**Description:** 迁移 coding-workflow 和 claude-rules-loader 两个 extension，处理 subagent 去重。这是最高风险的 group。

**Tasks:** Task 3, Task 4, Task 6

**Files (预估):** ~15 个文件

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-5, AC-5; plan Task 3, 4, 6 完整描述; coding-workflow/lib/ 源文件 |
| 读取文件 | harness coding-workflow/index.ts, lib/*.ts, review-dispatcher.ts; pi-subagent/src/*.ts |
| 修改/创建文件 | packages/coding-workflow/*, packages/claude-rules-loader/* |

**Execution Flow (BG2 内部):** 串行。Task 3 → Task 4 → Task 6（Task 6 依赖 Task 3 完成后才能改 import）。

**Dependencies:** BG1（packages/ 目录必须已存在）

---

#### BG3: Skills + Agents + Commands 迁移

**Description:** 迁移所有 skills（harness skills 到 coding-workflow、evolve skills 到 evolve-daily、独立 skills）、agents 和 commands。

**Tasks:** Task 5, Task 7, Task 8

**Files (预估):** ~35 个目录

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-3, FR-4, AC-3; plan Task 5, 7, 8 完整描述 |
| 读取文件 | harness skills/ 目录、agents/、commands/; evolve-daily/src/index.ts; coding-workflow/index.ts |
| 修改/创建文件 | packages/coding-workflow/skills/*, packages/coding-workflow/agents/*, packages/coding-workflow/commands/*, packages/evolve-daily/skills/*, skills/* |

**Execution Flow (BG3 内部):** Task 5 → Task 7 → Task 8（可部分并行，但建议串行避免混乱）。

**Dependencies:** BG2（coding-workflow 目录必须已存在）

---

#### BG4: 文档 + 脚本 + 配置收尾

**Description:** 合并 harness 文档、脚本，更新所有 package.json 配置，验证 changesets。

**Tasks:** Task 9, Task 10

**Files (预估):** ~30 个文件

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | plan Task 9, 10 完整描述; harness docs/ 和 scripts/ 目录 |
| 读取文件 | harness docs/*, scripts/*; 所有 packages/*/package.json |
| 修改/创建文件 | docs/*, scripts/*, packages/*/package.json, packages/*/tsconfig.json |

**Execution Flow (BG4 内部):** 串行。Task 9 → Task 10。

**Dependencies:** BG1（packages/ 目录已存在）

---

#### BG5: 验证 + 归档

**Description:** 功能回归验证和 harness 仓库归档。

**Tasks:** Task 11, Task 12

**Files (预估):** 1 个文件（harness README.md）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | plan Task 11, 12 完整描述; spec AC-7, AC-8 |
| 读取文件 | 所有 packages/*/index.ts |
| 修改/创建文件 | harness README.md |

**Execution Flow (BG5 内部):** 串行。Task 11 先验证，Task 12 再归档。

**Dependencies:** BG2, BG3, BG4 全部完成

---

## Dependency Graph & Wave Schedule

```
BG1 (基础设施+迁移) ──┬──→ BG2 (harness extension+去重) ──┬──→ BG5 (验证+归档)
                       │                                    │
                       └──→ BG3 (skills+agents+commands) ──┘
                       │
                       └──→ BG4 (文档+配置)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 基础设施，无依赖 |
| Wave 2 | BG2, BG3, BG4 | BG2/BG3/BG4 依赖 BG1；BG3 额外依赖 BG2（coding-workflow 目录） |
| Wave 3 | BG5 | 依赖 BG2+BG3+BG4 全部完成 |

**并行约束：** Wave 2 中 BG2 必须先于 BG3 完成（BG3 的 Task 5 需要 coding-workflow 目录已存在）。BG4 与 BG2/BG3 无依赖，可以并行。

实际执行顺序：**BG1 → BG2 → BG3 + BG4（并行）→ BG5**
