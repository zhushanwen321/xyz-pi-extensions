---
verdict: pass
---

# Non-Functional Design — use_skill tracker

## 1. 稳定性

改动集中在 evolve-daily 扩展内部，不涉及 Pi 核心进程。`createTracker` 框架的 `triggerEvent` 改为可选是向后兼容的（现有 handler 逻辑不变，只是有条件注册）。风险点：`createItem` 从 triggerEvent handler 提取为独立函数后，两条调用路径（被动监听 / 主动 start）需确保状态一致——通过共用 `persistState` + `state` 闭包变量保证。

## 2. 数据一致性

状态持久化沿用 `pi.appendEntry` + sessionManager 机制（不变）。`abandoned` 自动转换在 `turn_end` 和 `reconstructState` 两处触发，需确保 `currentTurnIndex` 已恢复最新值后再检查（reconstructState 中调整代码顺序）。旧 `dismissed` 数据在 deserialize 时直接丢弃，不迁移不映射——用户确认"历史数据不用管"，避免半迁移导致的数据歧义。

## 3. 性能

`scanSkillNames()` 在每次 `use_skill(start)` 时执行目录扫描（readdirSync + statSync）。已知 skills 目录通常 < 100 个子目录，扫描耗时 < 10ms，不构成瓶颈。npm bundled skills 的 glob 扫描（`node_modules/*/skills/*`）在依赖多的环境中可能稍慢，但有 system prompt fallback 兜底。不做缓存——start 调用频率低（每次 skill 使用一次），扫描开销可接受。

## 4. 业务安全

`use_skill` 的 tool description 直接决定 agent 何时调用 start，是本方案的可靠性核心。description 中明确划定"准备按 skill 指引行动 = 使用"vs"仅 read 了解/评估/分析 = 不使用"的边界。措辞不当会导致误报（描述过于宽泛）或漏报（描述过于严格）。steering 提示（onCreate）需明确告知 agent 后续 update 路径（completed/error/cancelled），避免遗忘堆积。

## 5. 数据安全

skill-registry 扫描的目录路径（`~/.pi/agent/skills`、`{cwd}/.agents/skills`、`~/.pi/agent/npm/node_modules/*/skills`）均为只读扫描，不涉及文件写入或删除。`isValidSkillName` 只做 Set 查找，不暴露文件内容。system prompt fallback 仅提取 `<name>` 标签，不解析完整 skill 内容。无敏感信息泄露风险。
