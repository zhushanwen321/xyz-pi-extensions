---
verdict: pass
---

# E2E Test Plan — Monorepo 合并

## Test Scenarios

### TS-1: Monorepo 基础设施验证 (AC-1)
1. `pnpm-workspace.yaml` 存在且配置了 `packages/*`
2. `pnpm install` 在根目录成功执行，无报错
3. 所有 `packages/` 下的包被 pnpm workspace 正确识别

### TS-2: npm 包可发布验证 (AC-2)
1. 每个 `packages/` 下的包 `package.json` 包含 `@zhushanwen/pi-*` name
2. `pnpm changeset publish --dry-run` 不报错
3. coding-workflow 的 `index.ts` 包含 `resources_discover` 事件处理器

### TS-3: 代码迁移完整性 (AC-3)
1. coding-workflow 包含 `index.ts`、`lib/gate-runner.ts`、`lib/review-dispatcher.ts`、`lib/skill-resolver.ts`
2. coding-workflow 不包含 `lib/subagent.ts`、`lib/model-resolve.ts`、`lib/process-manager.ts`
3. coding-workflow 包含 `scripts/gate-check.py`
4. claude-rules-loader 包含 `index.ts`
5. coding-workflow/skills/ 下包含 19 个 harness skill 目录（每个含 SKILL.md）
6. evolve-daily/skills/ 下包含 evolve、evolve-apply、evolve-report 三个目录
7. skills/ 下包含 10 个独立 skill 目录
8. coding-workflow/agents/ 下包含 7 个 .md 文件
9. coding-workflow/commands/ 下包含 dev.md 和 track.md
10. docs/ 下包含合并后的 harness 文档（adr、research 等）

### TS-4: 依赖关系验证 (AC-4)
1. coding-workflow 的 `package.json` 声明 `"@zhushanwen/pi-subagent": "workspace:*"`
2. 无循环依赖（可通过 `pnpm list --depth=1` 检查）
3. coding-workflow 的 `review-dispatcher.ts` 不再从 `./lib/subagent.js` 或 `./lib/model-resolve.js` 导入

### TS-5: 去重验证 (AC-5)
1. `find packages/coding-workflow -name "subagent.ts"` 返回空
2. `find packages/coding-workflow -name "model-resolve.ts"` 返回空
3. `find packages/coding-workflow -name "process-manager.ts"` 返回空
4. `grep -r "from.*\./lib/subagent" packages/coding-workflow/` 返回空
5. `grep -r "from.*\./lib/model-resolve" packages/coding-workflow/` 返回空

### TS-6: 类型检查 (AC-6)
1. `pnpm -r typecheck` 返回 exit code 0

### TS-7: 功能回归 (AC-7)
1. Pi 加载所有 extensions 无启动错误
2. `coding-workflow-gate` tool 可调用
3. `goal_manager` tool 可创建 goal
4. subagent single 模式可执行

### TS-8: Harness 仓库归档 (AC-8)
1. xyz-harness-engineering 的 README.md 包含 "ARCHIVED" 标记
2. 仓库在 GitHub 上已 archive

## Test Environment

- **前置条件**: 两个仓库的代码在本地可用
- **运行时**: Node.js v24+, pnpm 9+, Python 3.12+
- **Pi 版本**: 全局安装的 xyz-pi
- **验证方式**: shell 命令 + Pi CLI 交互验证
