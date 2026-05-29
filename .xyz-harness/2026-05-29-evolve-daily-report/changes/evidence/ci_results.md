---
ci_passed: false
ci_url: https://github.com/zhushanwen321/xyz-pi-extensions/actions/runs/26634323546
commit_sha: 6cd25fd
---

# CI Results

## CI 状态：失败（预存问题，与本次变更无关）

### 失败原因

CI 在 `typecheck` job 中运行 `npx tsc --noEmit`，报错全部来自 `workflow/` 扩展：

1. **workflow/src/index.ts**: 参数隐式 `any` 类型（8 处）
2. **workflow/src/orchestrator.ts**: `node:fs`, `node:worker_threads`, `process`, `setTimeout` 未识别（缺少 @types/node）
3. **workflow/src/tool-generate.ts**: 同上（隐式 any + 缺少 @types/node）

### 为什么不是本次变更的问题

1. 根 `tsconfig.json` 的 `include` 包含 `workflow/**/*.ts`，但 CI 环境没有本地 paths 映射指向的全局 Pi 包
2. 本次变更只涉及 `evolution-engine/` 目录（有独立的 `tsconfig.json` + 正确的 paths 配置）
3. `evolution-engine/` 甚至不在根 `tsconfig.json` 的 `include` 范围内
4. 本地运行 `npx tsc --noEmit` 成功（0 errors），因为本地 paths 指向已安装的 Pi 全局包
5. CI 失败的 run 可以追溯到本次变更之前的多个 commit，说明是持续存在的预存问题

### 建议（不在本次变更范围内）

1. 根 `tsconfig.json` 移除 `workflow/**/*.ts` 的 include（workflow 模块应使用独立 tsconfig）
2. 或创建 `tsconfig.ci.json`（已存在但未在 CI 中使用），排除有问题的模块
3. CI workflow 使用 `tsconfig.ci.json` 而非默认 `tsconfig.json`
