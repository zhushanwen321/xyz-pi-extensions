# Pi Extension 规范审查总结报告

> 审查日期: 2026-06-05
> 审查范围: xyz-pi-extensions monorepo 下全部 11 个 extension
> 审查依据: `docs/pi-extension-standards.md` + `docs/monorepo-conventions.md`

---

## 一、审查概况

| Extension | 版本 | 文件数 | 总行数 | P0 | P1 | P2 | 合规率 |
|-----------|------|--------|--------|----|----|-----|--------|
| claude-rules-loader | 0.1.1 | 1 | 238 | 1 | 5 | 6 | 72% |
| coding-workflow | 0.1.5 | 7 | 2,189 | 2 | 7 | 5 | 61% |
| context-engineering | 0.1.2 | 6 | 1,336 | 0 | 6 | 5 | 75% |
| evolve-daily | 0.1.7 | 10 | 1,470 | 0 | 4 | 5 | 78% |
| goal | - | 9 | 2,316 | 2 | 6 | 6 | 55% |
| model-switch | 0.2.5 | 8 | 1,593 | 0 | 3 | 4 | 82% |
| statusline | 0.4.2 | 6 | 951 | 0 | 3 | 5 | 76% |
| todo | 0.1.4 | 2 | 1,240 | 1 | 7 | 5 | 58% |
| unified-hooks | 0.0.3 | 5 | 232 | 0 | 1 | 3 | 90% |
| vision | 0.1.3 | 4 | 697 | 0 | 3 | 5 | 80% |
| workflow | 0.1.5 | 13 | 4,099 | 0 | 7 | 7 | 60% |
| **合计** | | **71** | **16,361** | **6** | **52** | **56** | |

---

## 二、共性问题（跨 Extension 普遍存在）

### 2.1 🔴 P0 级共性问题

#### (1) `package.json` 缺少 `license` 字段
- **涉及**: 几乎全部 11 个 extension（model-switch 除外均已确认缺失）
- **规范**: §1.2 package.json 必需字段
- **影响**: npm publish 发出 warning，依赖审计工具无法归类许可证
- **修复**: 添加 `"license": "MIT"` (1 行/扩展)

#### (2) `agent_end` 中调用 `sendUserMessage` 启动新 LLM 调用
- **涉及**: **goal**, **todo**（可能还有 coding-workflow 间接涉及）
- **规范**: §6.2 "agent_end 中禁止启动新的 LLM 调用，只做同步清理"
- **影响**: Pi 可能在 agent_end 时已开始销毁上下文，新 LLM 调用会导致崩溃或不可预测行为
- **修复建议**: 将 continuation/stall 逻辑迁移到 `before_agent_start` 中执行，或在规范中为此类自主循环 extension 做例外说明

#### (3) peerDependencies 声明与代码 import 包名不一致
- **涉及**: **coding-workflow**, **model-switch**, **workflow**
- **模式**: package.json 声明 `@earendil-works/pi-tui`，但代码 import `@mariozechner/pi-tui`
- **影响**: 脱离 monorepo tsconfig paths 后运行时 `ERR_MODULE_NOT_FOUND`
- **修复**: 统一 import 字符串与 peerDependencies 声明

### 2.2 🟠 P1 级共性问题

#### (4) 缺少 `isStaleContextError` 保护
- **涉及**: 全部 11 个 extension 均未实现标准的 `isStaleContextError` 检测
- **规范**: §10.1 "所有可能跨越 session 生命周期的 ctx 操作必须加 stale context 保护"
- **严重性**: 对有 `agent_end`/长异步操作的扩展（goal, coding-workflow, workflow）风险较高
- **修复建议**: 在各扩展中引入 `safeNotify()` / `isStaleContextError()` 工具函数

#### (5) `signal` 参数未透传给异步操作
- **涉及**: coding-workflow, goal, todo, workflow, evolve-daily, model-switch, vision
- **规范**: §3.2 "execute 内部的异步操作必须透传 signal 参数支持取消"
- **修复**: 将 `signal` 传递到子进程、Worker、`pi.exec()` 等实际异步操作

#### (6) 缺少 `session_tree` 事件处理器或未正确清理旧分支状态
- **涉及**: 几乎全部 11 个 extension（只有少数注册了空处理器）
- **规范**: §6.2 "session_tree 中必须丢弃旧分支的 pending 状态"
- **修复**: 对有 pending/running 状态的扩展，在 session_tree 中杀掉子进程并重置状态

#### (7) 跨文件类型未集中到 `types.ts`
- **涉及**: coding-workflow, context-engineering, goal, statusline, vision, todo
- **规范**: §3.2 "跨文件共用类型必须提取到 types.ts，禁止多文件重复定义同名 interface"
- **修复**: 创建 `src/types.ts`，将共享 interface/type 集中管理

#### (8) 事件处理器超过 20 行限制
- **涉及**: claude-rules-loader (58行), goal (197行), todo (60行), workflow (30行), evolve-daily (36行), coding-workflow 的 lib/ 文件
- **规范**: §6.2 "每个事件处理器不超过 20 行，复杂逻辑提取为命名函数"
- **修复**: 将复杂逻辑提取为命名函数

#### (9) 单文件超过 500 行指南限制
- **涉及**:
  - `context-engineering/src/compressor.ts` — 798 行
  - `goal/src/index.ts` — 900 行
  - `todo/src/index.ts` — 928 行
  - `workflow/src/orchestrator.ts` — 787 行
  - `workflow/src/index.ts` — 648 行
  - `coding-workflow/lib/tool-handlers.ts` — 620 行
- **规范**: §11 代码风格 → 单文件 ≤ 500 行 [指南]
- **修复**: 按职责拆分为子模块

#### (10) 函数超过 80 行限制
- **涉及**: coding-workflow (`executeGateTool` 180行), goal (`handleAgentEnd` 197行, `executeGoalAction` 260行), todo (`executeTodoAction` 318行), vision (`runSingleVisionAgent` 172行)
- **规范**: §11 代码风格 → 函数 ≤ 80 行 [指南]
- **修复**: 将大函数拆分为多个子函数

#### (11) 使用 `any` 类型
- **涉及**: claude-rules-loader, goal, unified-hooks, statusline
- **规范**: §11.1 "禁止 any，必须替换为具体类型或 unknown"
- **典型代码**: `pi.on("session_start", async (_event: any, ctx: any) => {`
- **修复**: 定义具体事件类型接口或使用 `unknown` + 类型守卫

### 2.3 🟡 P2 级共性问题

#### (12) Import 顺序不符合 Monorepo 约定
- **涉及**: coding-workflow, evolve-daily, goal, model-switch, workflow
- **规范**: §12 "Import 顺序: Node内置 → npm → Pi SDK → 内部包 → 当前包"
- **修复**: 调整 import 分组和排序

#### (13) 缺少防重入 (`isProcessing`) 标志
- **涉及**: goal, todo, vision, workflow
- **修复**: 在工厂闭包内添加 `isProcessing` 标志

#### (14) 配置路径未走扩展专属目录
- **涉及**: context-engineering (使用 `~/.pi/agent/settings.json` 而非 `~/.pi/agent/extensions/<name>/config.json`)
- **规范**: §8.1 "配置路径使用 `~/.pi/agent/extensions/<extension-name>/config.json` 子目录"

---

## 三、个性化问题（特定 Extension 独有）

### claude-rules-loader
- **P1**: 使用 `process.env.HOME` 而非 `os.homedir()`（§12.1）
- **P1**: `path.parse` 边界条件下可能死循环（`ctx.cwd` 为空字符串时）
- **P2**: Tab 与 Space 缩进混用

### coding-workflow
- **P1**: `gateRetryCount` 未持久化，重启后绕过重试上限
- **P1**: `executeInitTool` 中 skill 注入失败时未返回 `isError: true`
- **P1**: `compactRetryCount` 在错误路径不回退，导致状态漂移
- **P2**: 10+ 处重复的 `{ content: [...], isError: true }` 样板代码

### context-engineering
- **P1**: `peerDependencies` 声明 `@sinclair/typebox` 但代码 import `typebox`（不同 npm 包）
- **P1**: `loadConfig` JSON 解析失败时静默回退默认值（规范要求抛错）
- **P1**: 配置路径使用 Pi 全局 `settings.json` 而非扩展专属目录

### evolve-daily
- **P1**: `createTracker` 工厂函数 318 行，超过 100 行委托阈值
- **P2**: `PiOnAny` 类型在 `src/index.ts` 和 `src/trackers/core.ts` 中重复定义

### goal
- **P1**: `executeGoalAction` 内部 30+ 处 `throw` 而非返回 `{ isError: true }`
- **P1**: `src/index.ts` 900 行（接近 P0 的 1000 行上限）
- **P2**: `state.ts` 中 `deserializeState` 使用 ~20 处 `as` 类型断言，缺少运行时校验

### model-switch
- **P1**: `CONFIG_PATH` 在 `config.ts` 和 `setup.ts` 中重复定义
- **P1**: `details` 类型使用 `Record<string, never>` 而非规范的 `Record<string, unknown>`
- **P2**: `@earendil-works/pi-ai` 标记 optional 但代码中无条件使用

### statusline
- **P1**: `src/index.ts` 与 `src/format.ts` 之间 9 个函数 + 13 个常量 + 1 个接口完全重复定义（~150-200 行重复代码）
- **P1**: `(ctx.ui as any).setFooter(...)` 绕过类型检查

### todo
- **P1**: 工厂函数体 612 行，`executeTodoAction` 函数 318 行
- **P1**: `updates[]` 内嵌 schema 字段 (`id`/`status`/`text`) 缺少 description
- **P2**: verifyTag 渲染逻辑在 3 处重复

### unified-hooks
- **P2**: `typebox` 在 peerDependencies 中声明但源码从未使用
- **P2**: README.md 和 CLAUDE.md 引用已不存在的 hook 模块

### vision
- **P1**: `vision-model.ts` 存在模块级 `let` 变量（缓存状态），违反工厂闭包隔离规范
- **P2**: `vision-model.ts` 中 `_THINKING_TO_PI` 变量声明后从未使用

### workflow
- **P1**: `src/commands.ts` 中 `notifiedRunIds` 为模块级可变 Set，不在工厂闭包内
- **P1**: `src/config-loader.ts` 中 `cache` 为模块级可变 Map，跨 session 共享
- **P2**: `commands.ts` 使用同步 fs 操作（`renameSync`/`unlinkSync`）
- **P2**: `commands.ts` 中路径使用 `resolve(".pi/...")` 缺少 workspace root 检测

---

## 四、按严重程度排序的 Top 10 问题

| 排名 | 严重度 | 问题 | 影响范围 | 修复工作量 |
|------|--------|------|----------|-----------|
| 1 | **P0** | `agent_end` 中调用 `sendUserMessage` 启动新 LLM | goal, todo | 中（需架构调整） |
| 2 | **P0** | peerDependencies 与 import 包名不一致 | coding-workflow, model-switch, workflow | 小（统一命名） |
| 3 | **P0** | `package.json` 缺 `license` 字段 | 全部 | 极小（1 行/扩展） |
| 4 | **P1** | 缺少 `isStaleContextError` 保护 | 全部 | 小（引入工具函数） |
| 5 | **P1** | `signal` 参数未透传给异步操作 | 7 个扩展 | 中（需逐个透传） |
| 6 | **P1** | 跨文件类型散落、缺少 `types.ts` | 6 个扩展 | 中（提取+重 import） |
| 7 | **P1** | 模块级可变状态违反闭包隔离 | vision, workflow | 中（重构状态管理） |
| 8 | **P1** | 单文件严重超标（500-900 行） | 6 个扩展 | 高（拆分重构） |
| 9 | **P1** | 大量使用 `any` 类型 | 4 个扩展 | 小（替换为具体类型） |
| 10 | **P1** | `session_tree` 未处理旧分支状态 | 全部 | 小（添加处理器） |

---

## 五、修复优先级建议

### 第一批：P0 修复（阻塞发布）
1. 所有扩展添加 `license` 字段 (~11 行)
2. goal/todo 的 `agent_end` + `sendUserMessage` 模式迁移
3. 统一 peerDependencies 与 import 包名

### 第二批：P1 通用修复（建议 1 周内）
4. 引入共享的 `isStaleContextError` / `safeNotify` 工具（可放到 `shared/` 中）
5. 为有异步操作的扩展添加 `signal` 透传
6. 补充 `session_tree` 事件处理器
7. 将 `any` 替换为具体类型或 `unknown`
8. 创建 `types.ts` 集中跨文件类型

### 第三批：P1 个性化修复（建议 2 周内）
9. 各扩展的个性化问题修复（参见第三节）
10. 超大文件拆分（goal 900行、todo 928行、workflow 787行 等）

### 第四批：P2 风格优化（持续迭代）
11. Import 顺序调整
12. 事件处理器瘦身
13. 重复代码消除
14. 补充测试覆盖

---

## 六、各扩展评级

| Extension | 评级 | 评语 |
|-----------|------|------|
| unified-hooks | **A-** | 轻量、聚焦、合规率最高。仅 `any` 类型需修复 |
| model-switch | **B+** | 架构清晰、类型安全、有测试。包名一致性待修复 |
| vision | **B+** | 核心设计良好，signal 支持完善。模块级变量和函数过长待优化 |
| context-engineering | **B+** | 压缩算法严谨、测试完整。单文件过大是主要问题 |
| evolve-daily | **B** | 检测器/追踪器架构优秀，类型安全。事件处理器和工厂函数需拆分 |
| statusline | **B** | 纯函数测试设计优秀。大量代码重复是核心问题 |
| claude-rules-loader | **B-** | 功能克制、实现合理。规范合规性待提升 |
| coding-workflow | **B-** | 5阶段编排设计成熟、ProcessManager 优秀。包名和状态持久化需修复 |
| todo | **C+** | 数据模型和验证流程设计精巧。文件/函数严重超标，agent_end 违规 |
| workflow | **C+** | 架构最复杂、Worker/AgentPool 设计优秀。模块级状态和 signal 缺失是硬伤 |
| goal | **C** | 状态机和预算策略优秀。agent_end 违规、900行文件、30+ throw 是最大问题 |

---

## 七、附录：各扩展详细审查报告

- [claude-rules-loader.md](./claude-rules-loader.md)
- [coding-workflow.md](./coding-workflow.md)
- [context-engineering.md](./context-engineering.md)
- [evolve-daily.md](./evolve-daily.md)
- [goal.md](./goal.md)
- [model-switch.md](./model-switch.md)
- [statusline.md](./statusline.md)
- [todo.md](./todo.md)
- [unified-hooks.md](./unified-hooks.md)
- [vision.md](./vision.md)
- [workflow.md](./workflow.md)
