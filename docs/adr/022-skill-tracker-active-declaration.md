# ADR-022: skill tracker 主动声明替代被动监听（误报零容忍）

## Status

Accepted

## Context

evolve-daily 的 skill-execution tracker 原通过被动监听 `tool_call` + `read SKILL.md` 触发 tracking。该信号多义——调研性 read、开发性 read、执行性 read 无法在信号层区分，导致**误报**（agent 仅为了解/评估 skill 而 read SKILL.md，被当成"使用 skill"记录），污染 evolve 后续分析的底层数据。

evolve 的核心价值是"基于 skill 使用数据改进 skill 设计/CLAUDE.md"。脏数据（误报）比漏报更有害——误报会误导改进决策（如"某 skill 被频繁使用"但实际只是被频繁调研）。

## Decision

将触发机制从**被动监听 read**改为**agent 主动调用 `use_skill` tool 声明**。实现误报零容忍，接受漏报（agent 忘记调用时不追踪）。

### 替代方案对比

| 方案 | 误报 | 漏报 | 信号来源 | 破坏 progressive disclosure |
|------|------|------|---------|--------------------------|
| **A: 检测 `<skill>` block** | 0 | 结构性（agent 自主 read 执行的 skill 永远漏） | 用户 `/skill:name` 产生 | 否 |
| **C: 主动声明 tool（采纳）** | 0 | 概率性（agent 偶尔忘记调 tool） | agent 自主决定 | 否 |
| 拦截 read 强制走 tool | 有（开发性 read 误伤） | 概率性 | tool 拦截 | **是** |

方案 A 和 C 误报都是 0，但漏报性质不同：A 的漏报是结构性的（信号层不可区分），C 的漏报是概率性的（可通过 steering 压低）。在"误报零容忍、漏报可接受"约束下，C 严格优于 A。

## Consequences

### 正面

- **误报清零**：只有 agent 明确调 use_skill(start) 才创建 TrackedItem，调研性 read 不再污染数据
- **数据语义清晰**：cancelled（主动放弃）vs abandoned（遗忘）可区分，evolve 能分析 skill description 质量 vs tool 机制问题
- **不破坏 Pi 机制**：read 路径不变，tool 只是声明层

### 负面

- **覆盖率依赖 agent 自觉**：不同模型调 tool 的自觉性不同，tracking 覆盖率会随模型波动。evolve 分析时需意识到"低覆盖率 ≠ skill 没被使用"
- **agent 自主 read 执行的 skill 不追踪**：Pi 官方 progressive disclosure 场景（agent 自主发现并 read SKILL.md 执行）无法覆盖。这是"误报零容忍"的代价
- **name 校验有盲区**：extension 拿不到 Pi 的 resourceLoader.getSkills()，需独立扫描 skills 目录 + system prompt fallback。extension bundled skills 路径依赖 glob 模式，新增 extension 格式变化可能漏扫

### 关联决策

- `cancelled` 替代原 `dismissed`：dismissed 的"误报"语义在主动声明下失效，cancelled = "agent 主动放弃"更精确
- `abandoned` 纯系统状态：不在 tool status 枚举中，agent 不能手动设，确保 evolve 能区分"系统超时"vs"主动放弃"
- createTracker 框架方案 A：triggerEvent 改可选，skill-execution 用 triggerTool，未来 tracker 可选用任一模式
