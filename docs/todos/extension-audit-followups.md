# Extension 规范审查 — 待跟进项

> 来源：2026-06-05 全量审查（`extension-audit/` 已删除，本文档保留未完成项）
> 原则：跨 extension，不按 extension 分目录。完成一项删一项，全部清空后删除本文件。

---

## P0 — 架构重构（计划 0.3.0）

### D-1: `agent_end` 中 `sendUserMessage` 迁移到 `before_agent_start`

`steer`/`followUp` 都触发新 LLM 调用，违反 §6.2「agent_end 中禁止启动新的 LLM 调用，只做同步清理」。

- **goal** `agent-end-handler.ts` 5 处：L143/L192/L199（steer，预算/turn 超限）、L228（steer，max turns 取消）、L282（followUp，continuation）
- **todo** `handlers.ts` 3 处：验证失败提醒、stall 检测重注入、周期性 pending 刷新
- 方案：session.state 记录 `needsContinuation`/`pendingReminder`/`stallDetected` 标志，`before_agent_start` 读取后执行
- 风险：continuation 延迟到下一轮 `before_agent_start`

---

## P1 — 重大重构（计划 0.2.0）

### D-2: 超 500 行文件拆分

| 文件 | 行数 |
|------|------|
| `context-engineering/src/compressor.ts` | 704 |
| `workflow/src/orchestrator.ts` | 866 |
| `workflow/src/index.ts` | 699 |
| `coding-workflow/lib/tool-handlers.ts` | 631 |

### 拆分方案

- **compressor.ts** → `compressor/{index,l0,l1,l2,mc,budget,validation}.ts`（4-6h，含 3 个测试 import 更新）
- **evolve-daily `createTracker`**（318 行工厂函数）→ `trackers/{core,events,tool}.ts`（3-4h，需重设闭包状态共享）
- **coding-workflow** 16+ 跨文件类型 → 新建 `lib/types.ts`（2-3h，改 6 个文件 import）

---

## P2 — 未修复项（校准后）

### 影响可维护性
- [ ] coding-workflow: `executeGateTool` ~180 行超 80 行函数限制（`tool-handlers.ts`）
- [ ] statusline: 缺集中 `src/types.ts`
- [ ] vision: 缺集中 `src/types.ts`

### 代码风格
- [ ] claude-rules-loader: `index.ts` Tab/Space 缩进混用（未扫描确认）
- [ ] todo: `model.ts` `updateTodos` ~108 行超 80 行
- [ ] todo: `TodoListComponent` verifyTag 渲染逻辑 3 处重复
- [ ] vision: `_THINKING_TO_PI` 未使用变量（`vision-model.ts` L75）
- [ ] vision: `execute` 中冗余 `as string` 断言（`index.ts`）

### 文档与元数据
- [ ] 多个扩展: `keywords` 仅 `pi-package`，建议补全
- [ ] 多个扩展: 默认导出用命名函数（规范建议匿名）
- [ ] unified-hooks: `typebox` 在 peerDependencies 但未使用（grep 无结果）
- [ ] unified-hooks: README.md/CLAUDE.md 引用已不存在的 hook 模块
- [ ] claude-rules-loader: README.md 安装路径错误
- [ ] workflow: `commands.ts` 用 `resolve(".pi/...")` 缺 workspace root 检测
- [ ] context-engineering: Command 注册用旧式 `handler` 签名
- [ ] goal: `state.ts` 27 处 `as` 断言缺运行时校验
- [ ] goal: `@sinclair/typebox` 声明为 peerDependency
- [ ] statusline: `setup.ts` handler 末尾缺显式 `return`

---

## 已决策不修

- D-8: workflow `commands.ts` 5 处同步 fs 操作（不在热路径，简单可靠）
