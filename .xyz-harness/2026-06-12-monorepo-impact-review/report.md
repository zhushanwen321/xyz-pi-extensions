---
verdict: pass
must_fix: 0
---

## Summary

0 must-fix, 3 suggestions.

本次变更向 `GoalExternalInit` 类型新增了可选参数 `ctx?: ExtensionContext`，影响范围可控。`plan` 已同步更新。`coding-workflow` 存在类型漂移但不影响运行时行为。`extension-dependencies.json` 存在一处缺失声明。

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| SUGGESTION | extensions/coding-workflow/lib/tool-handlers.ts | 502, 525 | public-api | 两处内联 `GoalInitFn` 类型缺少新增的 `ctx?` 参数，与 `GoalExternalInit` 产生类型漂移。运行时不受影响（`ctx` 可选），但未来若有第四、第五参数会持续累积差异 | 引入 `import type { GoalExternalInit } from '@zhushanwen/pi-goal'` 替换本地内联类型，或同步更新本地类型签名 |
| SUGGESTION | extension-dependencies.json | — | workspace-dep | `@zhushanwen/pi-coding-workflow` 通过 `pi.__goalInit` 依赖 goal 扩展的运行时能力，但其 `dependsOn` 中未声明对 `@zhushanwen/pi-goal` 的可选依赖。`@zhushanwen/pi-plan` 已正确声明 | 在 `@zhushanwen/pi-coding-workflow` 的 `dependsOn` 中添加 `{ "package": "@zhushanwen/pi-goal", "type": "optional", "reason": "Phase 2/3 通过 __goalInit 启动 goal，缺失时降级跳过" }` |
| INFO | shared/types/mariozechner/index.d.ts | 12 | public-api | `ExtensionContext` 已在 stub 中声明（line 12），`state.ts` 新增的 `import type { ExtensionContext }` 不会导致类型检查失败 | 无需操作 |
