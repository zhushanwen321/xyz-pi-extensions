# subagent heartbeat 系统改进 followups

> 来源：lite 工作流复盘（`xyz-agent/.xyz-harness/2026-06-28-lite-composer-slash-trigger/retrospect.md` 问题 2，P0）
> 状态：过渡方案已实施，根治方案待办

## 问题

后台 subagent（`wait:false`）可能**静默 hang**——模型推理卡住 / 连接中断 / 等输入，既不完成也不失败。notifier 只在终态触发，subagent 永不到达终态时，主 agent 在 STOP 状态**无法被唤醒**，无限等待。

实测：reviewer subagent 跑 145s 后 token 卡 105036 两分钟不增长，靠 `goal_context` 的 turn 推进偶然打破僵局，非规范保证。

## 根因（责任与能力错位）

异步 subagent 把 liveness 检测责任推给消费者（主 agent），但消费者在等终态时本就无法主动执行——STOP 状态没有执行健康检查的时机。分布式系统靠 worker heartbeat 解决，subagent 无心跳机制。

**可证伪**：若 subagent 每 30s 发心跳 + 主 agent 2 周期无心跳则 cancel，hang 会在 ~60s 发现，而非 136s + 靠 goal_context 救场。

## 过渡方案（已实施）：schedule_prompt 哨兵

`extensions/coding-workflow/skills/lite-shared/references/subagent-dispatch.md`「后台 subagent hang 兜底」节：派 `wait:false` subagent 拿到 id 后，紧接埋 `schedule_prompt(action=add, type=once, schedule=+{2x预估秒})` 哨兵，到点强制唤醒主 agent 执行 list / 读 session / cancel。

- **正常路径**：subagent 先完成，notifier 唤醒；哨兵到点发现 finished 忽略（冗余无害）
- **hang 路径**：哨兵是唯一唤醒源

**局限**：每次派发都要手动埋哨兵，靠 skill 规范遵守，非机制保证；多 subagent 场景哨兵 prompt 需含对应 id。

## 根治方案（待实施）：subagent heartbeat

归属：`extensions/subagents/`（@zhushanwen/pi-subagents）或 pi-mono 调度层。

设计要点：
- 后台 subagent 每 N 秒（建议 30s）写心跳到 session 文件
- 主 agent 侧（或 subagents runtime）监测：2 周期（60s）无心跳 → 自动注入检查消息或直接 cancel
- 将 liveness 检测从「消费者责任」下沉为「runtime 机制」，责任与能力对位

## 追踪

- [ ] 在 `extensions/subagents` 评估 heartbeat 实现（session 文件写心跳 + runtime 监测）
- [ ] 实施后更新 `subagent-dispatch.md`，把「哨兵」降级为「heartbeat 不可用时的 fallback」
- [ ] 跨 repo：若 heartbeat 属 pi 调度层（pi-mono），在此补 issue 链接
