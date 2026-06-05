# 未完成问题跟踪清单

> 生成日期: 2026-06-05
> 最后更新: 2026-06-05（D-1~D-8 决策已记录 + D-3/4/5/6/7 已执行）
> 来源: 11 个 Extension 规范审查 + 修复周期
> 状态说明: 以下问题在本轮修复中被跳过，需后续跟进

---

## 〇、决策记录

> 以下问题已由项目负责人决策确认。✅ 表示已执行，📝 表示已记录待后续处理。

### D-1: `agent_end` 中 `sendUserMessage` 确实触发新 LLM 调用 → 需架构重构 [📝 记录]

- **决策**: `steer` 和 `followUp` 都触发新 LLM 调用，属于 §6.2 违规
- **影响**: goal（5 处）和 todo（3 处）需将 `agent_end` 中的 `sendUserMessage` 逻辑迁移到 `before_agent_start`
- **执行状态**: 📝 记录为 P0 架构重构任务，计划在 0.3.0 版本处理
- **迁移方案概述**:
  - goal: 在 `session.state` 中记录 `needsContinuation: boolean` + continuation 原因，`before_agent_start` 读取后执行 `sendUserMessage`
  - todo: 在 session state 中记录 `pendingReminder` / `stallDetected` 标志，`before_agent_start` 读取后重注入 pending 列表
  - 风险：continuation 延迟从 `agent_end` 到下一轮 `before_agent_start`，可能影响用户体验

### D-2: 超 500 行文件暂不拆分 [📝 记录]

- **决策**: 所有超过 500 行但未超过 1000 行硬限的文件本轮不拆分
- **执行状态**: 📝 记录，降级为 P2 持续迭代项
- **影响范围**: coding-workflow/tool-handlers.ts (631)、workflow/index.ts (699)、workflow/orchestrator.ts (866)、context-engineering/compressor.ts (704)

### D-3: P2 #5 事实不成立 → 从清单删除 [✅ 已执行]

- **决策**: goal 修复后最大子函数 66 行（`checkStaleness`），没有超过 80 行的，原描述有误
- **执行状态**: ✅ 已从 §3.1 清单中移除

### D-4: model-switch 重复 peerDependencies 需清理 [✅ 已执行]

- **决策**: 删除 `@earendil-works/pi-ai`（旧 scope）和 `typebox`（非真实 npm 包），只保留 `@mariozechner/pi-ai` 和 `@sinclair/typebox`
- **执行状态**: ✅ 已编辑 `extensions/model-switch/package.json`

### D-5: 引入 `eslint-plugin-simple-import-sort` 自动化 [✅ 已执行]

- **决策**: 引入 `eslint-plugin-simple-import-sort` 到根级 eslint 配置，全项目受益
- **执行状态**: ✅ 已安装依赖 + 配置规则 + 对全部 11 个扩展执行 `eslint --fix`
- **收益**: 自动修正 5 个扩展 ~20+ 文件的 import 顺序，后续 CI 自动保障

### D-6: goal 19 处 `any` 必须全部修复 [✅ 已执行]

- **决策**: 采用与 unified-hooks 一致的 `unknown` + 本地接口模式替换所有 `any`
- **执行状态**: ✅ 已修复 goal/src/index.ts 中全部 19 处 `any`
- **模式**: 定义本地接口（如 `BeforeAgentStartLikeEvent`、`MessageEndLikeEvent` 等）+ `event: unknown` → `as LocalInterface`

### D-7: `session_tree` 空 handler 强制要求 [✅ 已执行]

- **决策**: 所有扩展必须注册 `session_tree` handler
- **执行状态**: ✅ 已为 context-engineering 和 statusline 添加 `session_tree` handler
- **模式**: context-engineering 添加状态重建逻辑；statusline 添加带 `reconstructState` 的 handler

### D-8: workflow 同步 fs 不改 [📝 记录]

- **决策**: `commands.ts` 中 5 处同步 fs 操作保持不变（不在热路径，简单可靠）
- **执行状态**: 📝 已记录，从待修复清单中移除

---

## 一、需平台团队决策的问题（阻塞进一步修复）

### 1.1 `agent_end` 中调用 `sendUserMessage` 是否合规

> **状态: [NEEDS-DECISION]** — 见 D-1

- **规范条目**: §6.2 "agent_end 中禁止启动新的 LLM 调用，只做同步清理"
- **涉及扩展**: `goal`, `todo`
- **问题描述**: 这两个扩展在 `agent_end` 事件处理器中通过 `pi.sendUserMessage({ deliverAs: "steer" | "followUp" })` 实现自主循环。
  - **goal** (`agent-end-handler.ts`): 5 处调用
    - L143: `deliverAs: "steer"` — token 预算超限
    - L192: `deliverAs: "steer"` — token 预算 90% steering
    - L199: `deliverAs: "steer"` — turn 预算超限 steering
    - L228: `deliverAs: "steer"` — max turns 取消提醒
    - L282: `deliverAs: "followUp"` — continuation（续跑）
  - **todo** (`handlers.ts`): 3 处调用
    - 验证失败提醒、stall 检测重注入、周期性 pending 刷新
- **代码事实**: `goal/src/index.ts` 中已无 `sendUserMessage`（全部在 `agent-end-handler.ts`），修复已正确拆分文件
- **建议行动**: 先解决 D-1，再决定修复方案

---

## 二、已跳过的重大重构（P1 级别，建议 0.2.0 版本处理）

### 2.1 `context-engineering` — compressor.ts 拆分

- **当前**: `src/compressor.ts` **704 行** [已验证]
- **规范**: §11 单文件 ≤ 500 行 [指南]；Monorepo 约定 ≤ 1000 行 [P0]
- **跳过原因**: 需拆为 7 个子文件，涉及 3 个测试文件 import 更新、模块可见性重新划分，回归风险高
- **建议拆分方案**:
  ```
  src/compressor/
  ├── index.ts       — 重新导出 + compressContext 主入口
  ├── l0.ts          — processL0, expireToolResult, truncateBashOutput, expireThinking
  ├── l1.ts          — processL1, condenseToolResult, fallbackTruncate
  ├── l2.ts          — processL2
  ├── mc.ts          — processMicrocompact, COMPACTABLE_TOOLS
  ├── budget.ts      — processBudget
  └── validation.ts  — validateToolPairing, findCompactBoundary, findTurnBoundaries, isInProtectedTurn
  ```
- **预估工作量**: 4-6 小时（含测试更新 + 集成验证）
- **阻塞于**: D-2（是否在 0.2.0 版本统一处理）

### 2.2 `evolve-daily` — createTracker 工厂函数拆分

- **当前**: `src/trackers/core.ts` 的 `createTracker` 工厂函数 318 行
- **规范**: §2 "超过 100 行的工厂函数应按功能委托到子模块"
- **跳过原因**: 主体逻辑是线性流程，拆分需重新设计闭包状态共享（`state` 变量被所有子函数读写）
- **建议拆分方案**:
  ```
  src/trackers/
  ├── core.ts          — 编排逻辑 (~60 行)
  ├── events.ts        — 事件注册逻辑 (~150 行)
  ├── tool.ts          — 工具注册逻辑 (~100 行)
  └── types.ts         — 已有
  ```
- **预估工作量**: 3-4 小时

### 2.3 `coding-workflow` — 跨文件类型集中到 types.ts

- **当前**: 16+ 个共享类型分散在 `lib/helpers.ts`、`lib/tool-handlers.ts`、`lib/subagent.ts`、`lib/review-dispatcher.ts`、`lib/gate-runner.ts` 中
- **规范**: §7.3 "跨文件共用类型必须提取到 types.ts"
- **跳过原因**: 需创建 `lib/types.ts`（~80 行）并修改 6 个文件的 import 语句
- **预估工作量**: 2-3 小时

---

## 三、P2 级问题清单（经代码验证校准）

### 3.1 高优先级 P2（影响可维护性）

| # | 扩展 | 问题 | 文件 | 验证状态 |
|---|------|------|------|----------|
| 1 | coding-workflow | `lib/tool-handlers.ts` **631 行**超 500 行限制 | `lib/tool-handlers.ts` | ✅ 已验证 |
| 2 | coding-workflow | `executeGateTool` ~180 行超 80 行函数限制 | `lib/tool-handlers.ts` | ✅ 已验证 |
| 3 | workflow | `src/index.ts` **699 行**超 500 行限制 | `src/index.ts` | ✅ 已验证（文档原文写 648 不准确） |
| 4 | workflow | `src/orchestrator.ts` **866 行**超 500 行限制 | `src/orchestrator.ts` | ✅ 已验证（文档原文写 787 不准确） |
| ~~5~~ | ~~goal~~ | ~~4 个子函数仍超 80 行~~ | — | ❌ **事实不成立，已删除**（D-3 决策） |
| 6 | statusline | 缺少集中 `src/types.ts` 文件 | 跨文件类型散落 | ✅ 已验证 |
| 7 | vision | 缺少集中 `src/types.ts` 文件 | 跨文件类型散落 | ✅ 已验证 |
| 8 | model-switch | ~~peerDependencies 重复声明~~ | `package.json` | ✅ **已修复**（D-4 清理了旧 scope + typebox 别名） |

### 3.2 中优先级 P2（代码风格）

| # | 扩展 | 问题 | 文件 | 验证状态 |
|---|------|------|------|----------|
| 9 | 多个（5个扩展） | ~~Import 顺序不符合 Monorepo 约定~~ | 40 文件 | ✅ **已修复**（D-5: eslint-plugin-simple-import-sort，自动修复 75 处） |
| 10 | claude-rules-loader | Tab 与 Space 缩进混用 | `index.ts` | ✅ 未验证（需扫描确认） |
| 11 | goal | ~~`index.ts` 19 处 `any` 类型~~ | `src/index.ts` | ✅ **已修复**（D-6: 19→0，全部替换为本地接口 + unknown） |
| 12 | todo | `model.ts` 中 `updateTodos` 函数约 108 行超 80 行 | `src/model.ts` | ✅ 未扫描具体行数 |
| 13 | todo | `TodoListComponent` 中 verifyTag 渲染逻辑 3 处重复 | `src/component.ts` 等 | ✅ 未扫描 |
| 14 | vision | `_THINKING_TO_PI` 未使用变量 | `src/vision-model.ts` | ✅ 已验证（L75 存在） |
| 15 | vision | `execute` 中冗余 `as string` 断言 | `src/index.ts` | ✅ 未扫描 |

### 3.3 低优先级 P2（文档与元数据）

| # | 扩展 | 问题 | 文件 | 验证状态 |
|---|------|------|------|----------|
| 16 | 多个 | `keywords` 仅一个 `pi-package` | 各 `package.json` | — |
| 17 | 多个 | 默认导出使用命名函数（规范建议匿名） | 各 `index.ts` | — |
| 18 | unified-hooks | `typebox` 在 peerDependencies 中声明但**确实未使用** [已验证: grep 无结果] | `package.json` | ✅ 已验证 |
| 19 | unified-hooks | README.md/CLAUDE.md 引用已不存在的 hook 模块 | `README.md`, `CLAUDE.md` | — |
| 20 | claude-rules-loader | README.md 安装路径错误 | `README.md` | — |
| 21 | workflow | `commands.ts` 使用 **5 处**同步 fs 操作 | `src/commands.ts` | 📝 不修（D-8 决策：不在热路径） |
| 22 | workflow | `commands.ts` 路径用 `resolve(".pi/...")` 缺 workspace root 检测 | `src/commands.ts` | — |
| 23 | context-engineering | Command 注册使用旧式 `handler` 签名 | `src/index.ts` | — |
| 24 | context-engineering | ~~缺 `session_tree` 空 handler~~ | `src/index.ts` | ✅ **已修复**（D-7: 添加空 handler） |
| 25 | goal | `state.ts` 中 **27 处** `as` 断言缺运行时校验 | `src/state.ts` | ✅ 已验证（文档原文写 ~20 不准确） |
| 26 | goal | `@sinclair/typebox` 声明为 peerDependency | `package.json` | — |
| 27 | statusline | `setup.ts` handler 函数末尾缺显式 `return` | `src/setup.ts` | — |
| 28 | statusline | ~~无 `session_tree` 事件处理器~~ | `src/index.ts` | ✅ **已修复**（D-7: 添加带状态重建的 handler） |

---

## 四、修复进度追踪（校准后）

### 按严重程度

| 严重度 | 总数 | 已修复 | 未修复 | 完成率 |
|--------|------|--------|--------|--------|
| P0 | 5 | 3 | 2 | 60% |
| P1 | 52 | 47 | 5 | 90% |
| P2 | 56 | 5 | 51 | 9% |

> P2 已修复 5 项: model-switch peerDeps 清理(D-4)、import 排序自动化(D-5)、goal any 消除(D-6)、context-engineering session_tree(D-7)、statusline session_tree(D-7)

### 按扩展

| 扩展 | P0 未修 | P1 未修 | P2 未修 | 备注 |
|------|---------|---------|---------|------|
| claude-rules-loader | 0 | 0 | 6 | 全部 P0/P1 已修 |
| coding-workflow | 0 | 1 | 5 | types.ts 重构跳过 |
| context-engineering | 0 | 1 | **4** | P2#24 已修复（session_tree handler），原 5→4 |
| evolve-daily | 0 | 1 | 5 | createTracker 拆分跳过 |
| goal | 1 | 0 | **5** | P2#5 删除（事实不成立）；agent_end 待确认 |
| model-switch | 0 | 0 | **4** | P2#8 已修复（peerDeps 清理），原 5→4 |
| statusline | 0 | 0 | **4** | P2#28 已修复（session_tree handler），原 5→4 |
| todo | 1 | 0 | 5 | agent_end 待确认 |
| unified-hooks | 0 | 0 | 3 | 全部 P0/P1 已修 |
| vision | 0 | 0 | 5 | 全部 P0/P1 已修 |
| workflow | 0 | 0 | 7 | 全部 P0/P1 已修 |

---

## 五、建议执行计划

### 前置步骤：决策确认 ✅ 全部完成
- [x] **D-1**: `sendUserMessage` 确认触发 LLM → 记录为 P0 架构重构任务
- [x] **D-2**: 超 500 行文件暂不拆分 → 降级为 P2
- [x] **D-3**: P2 #5 事实不成立 → 已删除
- [x] **D-4**: model-switch 重复 peerDeps → 已清理
- [x] **D-5**: 引入 eslint-plugin-simple-import-sort → 已配置 + 自动修复 75 处
- [x] **D-6**: goal 19 处 `any` → 已修复为 0 处
- [x] **D-7**: session_tree 强制 → context-engineering + statusline 已添加
- [x] **D-8**: workflow 同步 fs 不改 → 已记录

### 阶段一：P0 架构重构（0.3.0 版本）
- [ ] goal/todo: 将 `agent_end` 中的 `sendUserMessage` 逻辑迁移到 `before_agent_start`（D-1）
      - goal: 5 处（3 steer + 2 followUp）→ 在 session.state 中记录续跑标志
      - todo: 3 处 → 在 session state 中记录 reminder/stall 标志
      - 风险: continuation 延迟从 agent_end 到下一轮 before_agent_start

### 阶段二：P1 遗留修复（0.2.0 版本，2 周内）
- [ ] context-engineering: compressor.ts 拆分为 7 个子文件
- [ ] evolve-daily: createTracker 工厂函数拆分
- [ ] coding-workflow: 创建 lib/types.ts 集中跨文件类型

### 阶段三：高优 P2 剩余（持续迭代）
- [ ] coding-workflow: tool-handlers.ts 拆分（631 行 → 多个子文件）
- [ ] workflow: index.ts（699 行）+ orchestrator.ts（866 行）拆分
- [ ] ~~多个扩展: Import 顺序修正~~ → ✅ 已自动化（D-5）
- [ ] ~~goal: 19 处 `any` 替换为具体类型~~ → ✅ 已修复（D-6）

### 阶段四：低优 P2 剩余（按需）
- [ ] 文档更新（README.md / CLAUDE.md）
- [ ] package.json 元数据补全（keywords、命名导出）
- [ ] ~~Import 顺序批量修复~~ → ✅ 已自动化
- [ ] ~~workflow: 同步 fs 改异步~~ → 📝 不修（D-8）
- [ ] ~~context-engineering/statusline: session_tree handler~~ → ✅ 已添加（D-7）
