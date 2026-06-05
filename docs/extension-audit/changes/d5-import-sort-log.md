# D5: Import Sort — eslint-plugin-simple-import-sort 引入日志

> **日期**: 2025-07-14
> **范围**: `extensions/` 目录下所有 `.ts` 文件
> **工具**: `eslint-plugin-simple-import-sort@13`

---

## 1. 变更摘要

| 指标 | 数量 |
|------|------|
| 扫描文件数 | 70 |
| 发现 import 排序问题 | 71 |
| 发现 export 排序问题 | 4 |
| **总修复数** | **75** |
| 涉及扩展包 | 10 |

## 2. 配置变更

### 安装依赖

```bash
pnpm add -wD eslint-plugin-simple-import-sort
```

### `shared/taste-lint/base.mjs` 修改

```diff
+ import simpleImportSort from 'eslint-plugin-simple-import-sort';

  // tasteRules 中新增:
+ 'simple-import-sort/imports': 'warn',
+ 'simple-import-sort/exports': 'warn',

  // plugins 中新增:
- plugins: { taste: tastePlugin },
+ plugins: { taste: tastePlugin, 'simple-import-sort': simpleImportSort },
```

规则级别设为 `warn`（不阻塞开发，但 IDE 会提示，`--fix` 可自动修复）。

## 3. Dry-run 结果

运行 `npx eslint extensions/` 后发现 **75 处** simple-import-sort 警告：
- `simple-import-sort/imports`: 71 处（import 语句未按规范排序）
- `simple-import-sort/exports`: 4 处（export 语句未按规范排序）

## 4. 自动修复

```bash
npx eslint extensions/ --fix
```

修复后再次检查：`simple-import-sort` 问题 **0 处**。全部 75 处已自动修复。

## 5. 验证结果

| 检查项 | 结果 |
|--------|------|
| `eslint extensions/` (import-sort) | ✅ 0 问题 |
| `pnpm -r test` | ✅ 全部通过（todo 58, context-engineering 44, statusline 69, workflow 172, quota-providers 7） |
| `pnpm -r typecheck` | ⚠️ 1 个预存问题（coding-workflow 中 `DEFAULT_STATE` 未导入，与 import-sort 无关） |

> **注意**: `coding-workflow` 的 `tool-handlers.ts` 中存在一个 `TS2304: Cannot find name 'DEFAULT_STATE'` 错误。
> 此错误来自工作树中其他预存改动（新增的 `onError` 回调中引用了 `DEFAULT_STATE` 但未导入），
> **不是 import 排序引入的**。经 `git stash` 对照验证：原代码 + 仅 import 排序不触发此错误。

## 6. 受影响文件清单

### 纯 import 排序变更的文件（40 个）

| 扩展包 | 文件 |
|--------|------|
| **coding-workflow** | `index.ts`, `lib/gate-runner.ts`, `lib/process-manager.ts`, `lib/review-dispatcher.ts`, `lib/skill-resolver.ts`, `lib/subagent.ts`, `lib/tool-handlers.ts` |
| **context-engineering** | `src/__tests__/compressor.test.ts`, `src/__tests__/frozen-fresh.test.ts`, `src/__tests__/integration.test.ts`, `src/commands.ts`, `src/config.ts`, `src/index.ts`, `vitest.config.ts` |
| **evolve-daily** | `src/index.ts`, `src/trackers/skill-execution.ts` |
| **goal** | `src/budget.ts`, `src/commands.ts`, `src/templates.ts`, `src/widget.ts` |
| **model-switch** | `src/advisor.ts`, `src/index.ts`, `src/prompt.ts`, `tests/resolveModelForScene.test.ts` |
| **statusline** | `src/__tests__/format.test.ts`, `src/setup.ts`, `vitest.config.ts` |
| **todo** | `src/__tests__/todo.test.ts` |
| **workflow** | `src/agent-pool.ts`, `src/execution-trace.ts`, `src/model-resolver.ts`, `src/tool-generate.ts`, `src/widget.ts`, `tests/agent-pool.test.ts`, `tests/commands-generate.test.ts`, `tests/config-loader.test.ts`, `tests/index.test.ts`, `tests/orchestrator.test.ts`, `tests/resolveModel.test.ts`, `tests/state-budget.test.ts`, `tests/state.test.ts`, `tests/tool-generate.test.ts`, `tests/worker-script.test.ts`, `vitest.config.ts` |

### 同时包含其他预存改动的文件（30 个）

这些文件中 import 排序已修复，但还包含工作树中其他功能的代码改动（非本次 import-sort 引入）：

| 扩展包 | 文件 |
|--------|------|
| **claude-rules-loader** | `index.ts` |
| **coding-workflow** | `lib/helpers.ts` |
| **context-engineering** | `src/compressor.ts` |
| **evolve-daily** | `src/trackers/core.ts` |
| **goal** | `src/index.ts`, `src/state.ts`, `src/tool-handler.ts` |
| **model-switch** | `index.ts`, `src/config.ts`, `src/setup.ts` |
| **statusline** | `src/format.ts`, `src/index.ts` |
| **todo** | `src/index.ts`, `src/model.ts` |
| **unified-hooks** | `src/hooks/network-timeout-guard.ts`, `src/hooks/test-timeout-guard.ts`, `src/hooks/tool-error-handler.ts`, `src/index.ts` |
| **vision** | `src/index.ts`, `src/spawn.ts`, `src/vision-model.ts` |
| **workflow** | `src/commands.ts`, `src/config-loader.ts`, `src/index.ts`, `src/orchestrator.ts` |

## 7. 排序规则说明

`eslint-plugin-simple-import-sort` 默认分组顺序：

1. **Side-effect imports**: `import 'foo'`
2. **Node.js 内置模块**: `import fs from 'node:fs'`
3. **外部包**: `import _ from 'lodash'`
4. **内部别名 / scoped 包**: `import { x } from '@scope/pkg'`
5. **相对路径导入**: `import { y } from './foo'`

每组之间用空行分隔，组内按字母序排列。

## 8. 后续建议

- [x] 将规则级别设为 `warn`（已实现）
- [ ] 考虑在 CI 中加入 `eslint --max-warnings 0` 来严格阻断新问题
- [ ] 在 `pre-commit` hook 中加入 import 排序检查，防止未排序的 import 提交
