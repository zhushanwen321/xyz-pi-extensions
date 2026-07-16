# Code Review — fix-robustness-medium-batch2

## 审查范围
- commit: 5793d2529（4 files: subagent-service.ts, error-recovery.ts, helpers.ts, test）

## 发现的问题
无 must-fix / should-fix。

| 修复 | 核对 |
|------|------|
| M6 | `if (record.worktreeHandle)` 不再含 patchOk，patch 失败不阻塞 worktree cleanup |
| M9 | 4 处 `void deps.store.save(run)` 全部改为 `.catch(console.error)` |
| M10 | JSON.stringify(scriptResult) 包在 try-catch，fallback 到 String() |
| M12 | budget-done transition 和 onRunDone/emit 分成两个 try 块，各自独立 catch |

## 结论
- must-fix: 0, should-fix: 0, nit: 0
