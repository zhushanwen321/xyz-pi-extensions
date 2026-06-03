# Progress

## Status
Completed

## Validation
- [x] `npx tsc --noEmit` — 零错误通过
- [x] `rg 'pi' quota-providers/package.json` — 确认 pi 字段已删除
- [x] `rg 'extension' quota-providers/package.json` — 确认 extension 标签已从 keywords 移除

## Tasks
- [x] 移除 quota-providers/package.json 中 `pi` 字段（避免 Pi 尝试加载内部 utility 包为扩展）
- [x] 从 keywords 移除 `"extension"` 标签

## Files Changed
- `packages/quota-providers/package.json`

## Notes
quota-providers 是内部 utility 包（被 model-switch 和 statusline 在 dependencies 引用），不应有 pi.extensions 声明。src/index.ts 导出工具函数而非 factory function，Pi 加载会导致静默失败。

### Additional fixes (2026-06-03)
- [x] `coding-workflow/index.ts`: 模块级 `skillResolver` (line 27) 移入工厂闭包 (line 277) — 消除多 session 共享 mutable 对象的 P0 风险
- [x] `evolve-daily/trackers/core.ts`: 删除悬挂 `try {` (line 323) — 之前 subagent 引入的语法错误
