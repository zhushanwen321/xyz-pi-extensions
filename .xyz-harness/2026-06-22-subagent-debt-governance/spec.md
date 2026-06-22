# subagents 技术债治理规格说明

## 背景

`extensions/subagents` 总代码量约 10800 行（core 2089 / runtime 1753 / tools 584 / tui 1956 / types 408 / 其余 index 等）。代码审查发现三类问题：

1. **过度抽象**：EventBridge 翻译了几乎相同的事件结构、RecordStore 三 Map 迁移、session-factory 四步碎片化
2. **伪需求**：三层模型解析的中间层、概率性 GC、BgNotifier 滑动窗口合并
3. **意图偏移**：分层初衷是可测性但 duck-typed 接口反而翻倍代码量、list-view 从简单列表变成 700 行 TUI 应用

## 治理目标

| 指标 | 当前 | 目标 |
|------|------|------|
| 总代码行数 | ~10800 | ~7500（-30%） |
| core 层文件数 | 10 | 7 |
| runtime 层文件数 | 7 | 5 |
| duck-typed 接口数 | 8 | 3 |
| 最大单文件行数 | 468 (subagent-actions.ts) | < 400 |

## 约束

- **功能不变**：所有 wave 完成后行为完全一致（tool schema、renderResult、TUI 渲染、history 持久化）
- **不改 types.ts 的公共接口**：`SubagentToolResult`、`ExecutionHandle`、`ExecuteOptions` 等对外契约不动
- **不改 index.ts 的注册逻辑**：tool 注册、event handler、command 不动
- **每 wave 可独立验证**：`pnpm --filter @zhushanwen/pi-subagents typecheck && pnpm --filter @zhushanwen/pi-subagents test` 通过
