# Goal 插件优化 — Spec

> 日期：2026-05-19
> 基于 `docs/goal-todo.md` 待实施项 + 代码扫描发现的附带问题

---

## 目标

实现 goal 插件的 4 项待优化功能 + 修复 2 个附带问题，使插件在预算感知、用户体验、代码清洁度上达到可发布质量。

## 成果

- 用户在 token/时间预算接近耗尽时收到提前通知（70%/90%），有足够时间调整策略
- 所有任务完成且预算紧张时，模型被优先引导完成目标而非继续工作
- Widget 展示可视化进度条，用户一眼可知预算消耗情况
- Continuation prompt 暴露完整预算信息（含时间），与 Codex 对齐
- 死代码清理完毕，README 与代码一致

## 范围

### In-scope

1. P1-3：Continuation 防重入保护
2. P2-6：Token + 时间预算 70%/90% 预警（notify + continuation prompt 暴露时间信息）
3. P2-7：预算紧张时优先 complete_goal（steer 替代 followUp）
4. P2-8：Widget 进度条
5. 附带：清理 `blockedPrompt` 死代码
6. 附带：README `--max-stall` 默认值修正

### Out-of-scope

- Token 会计排除 cached tokens（已做）
- setTimeout → 同步检查（已做）
- Stall 检测改为"同一原因重复"（过度工程）
- Evidence 自动验证
- Per-tool token 会计
- 多 session 多 goal
- Token 会计即时持久化（需 Pi API 变更，接受崩溃窗口）

## 约束

- 文件修改范围：`index.ts`、`state.ts`、`templates.ts`、`widget.ts`、`README.md`
- 遵循 Pi Extension API（jiti 运行时加载，无构建步骤）
- 遵循现有代码风格（tab 缩进、中文注释解释"为什么"）
- 不引入新依赖

## 健壮性修复（审查发现）

| # | 严重度 | 问题 | 修复方案 |
|---|--------|------|----------|
| R1 | P0 | `agent_end` 无 goalId 校验，旧 goal 回调可能操作新 goal | agent_end 开头 snapshot goalId，操作前校验 |
| R2 | P1 | `persistState` 时间双写：终止分支先赋值再 persist 导致重复累加 | 终止分支不再手动赋值 timeUsedSeconds |
| R3 | P1 | `/goal update` 不重置 stallCount/turnCount/tasksCompletedAtAgentStart | update 时重置计数器 |
| R4 | P1 | `complete_goal` 允许零任务直接完成 | 要求至少 1 个 task |
| R5 | P2 | `deserializeState` 无数据校验/默认值补全 | 补字段默认值 |

## 已有基础设施

来自代码扫描：

- `GoalRuntimeState` 已有 `budgetLimitSteeringSent: boolean` 字段（P2-6 可参照此模式新增 `budgetWarning70Sent`/`budgetWarning90Sent`）
- `getTokenUsagePercent()` / `getTimeUsagePercent()` 已存在于 `state.ts`，widget 和 index 都已引用
- `ctx.ui.notify(msg, level)` 已用于所有用户通知
- `pi.sendUserMessage(msg, { deliverAs: "steer" })` 用于高优先级注入
- `renderWidgetLines(state, theme)` 返回 `string[]`，每行一个 widget 行
- `continuationPrompt(state)` 已暴露 token 信息，但**缺少时间信息**（Codex 的 continuation 模板有 budget section 包含时间）
- `blockedPrompt` 在 `templates.ts` 定义但 `index.ts` 未调用（死代码）
- README `--max-stall` 默认值写的 3，实际代码为 5

## 决策记录

1. **预算预警：token + 时间都做**——用户要求，Codex 只暴露信息不做预警，但 Pi 有独立的 notify 通道，预警对用户有直接价值
2. **预警阈值 70%/90%**——70% 提示注意，90% 提示收尾，与两阶段预算终止（90% steering + 100% terminate）的 90% 衔接
3. **Continuation prompt 增加时间预算信息**——参考 Codex continuation.md 的 Budget section，补充 time elapsed / time budget
4. **P2-7 预算紧张阈值 80%**——与 90% steering 发送点有间隔，给模型足够空间
5. **blockedPrompt 直接删除**——resume 时已内联 blocker 信息，该模板无使用场景
6. **agent_end goalId 校验**——每次 agent_end 捕获当前 goalId snapshot，校验 state.goalId 未变，防止旧回调操作新 goal
7. **时间累计统一由 persistState 管理**——终止分支不再手动赋值 timeUsedSeconds，消除双写
8. **complete_goal 零任务拒绝**——要求至少 1 个 task，防止模型跳过任务追踪
9. **deserializeState 补全字段**——向后兼容旧格式数据
10. **Token 会计崩溃窗口**——接受不即时持久化，因需 Pi API 变更（无 message_end 后的 persist hook），概率极低

## 验收标准

1. `npm run tsc --noEmit` 无语法错误（隐式 any 可忽略）
2. 设置 `--tokens 100000` 的 goal，运行到 70k/90k 时分别收到 notify
3. 设置 `--timeout 5` 的 goal，运行到 3.5 分钟/4.5 分钟时分别收到 notify
4. 所有任务完成后预算 >80% 时，模型收到 steer 而非 followUp
5. Widget 显示 `█░` 进度条和百分比
6. `grep -r "blockedPrompt" src/` 返回空
7. README `--max-stall` 默认值显示为 5
8. 旧 goal agent_end 回调不会操作新 goal 状态（goalId 校验）
9. 时间累计无双写
10. `/goal update` 重置 stall/turn 计数器
11. `complete_goal` 零任务时拒绝完成
12. `deserializeState` 补全缺失字段默认值
