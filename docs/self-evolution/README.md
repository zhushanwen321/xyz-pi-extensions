# Pi Agent 自我进化系统 — 设计与分期规划

> 状态：draft
> 日期：2026-05-27

## 文档索引

按阅读顺序：

| 序号 | 文档 | 内容 |
|---|---|---|
| 1 | [01-research.md](./01-research.md) | 文章理论分析：GVU 算子、五层进化、提示词优化（DSPy/ZERA/E-SPL/GEPA）、技能进化（SkillX/Ratchet/NSI/SkillForge），与 pi 架构的映射 |
| 2 | [02-signal-analysis.md](./02-signal-analysis.md) | 信号源盘点：session JSONL、usage-stats、skill-memory-keeper、Pi Extension API 事件体系，可提取的 7 类信号详细定义 |
| 3 | [03-framework-design.md](./03-framework-design.md) | 框架设计：三个层次的自我进化架构（Session Analysis Pipeline、Skill Lifecycle Manager、Evolution Engine Extension），GVU 三重映射，与现有组件的集成关系 |
| 4 | [04-phased-roadmap.md](./04-phased-roadmap.md) | 五期分期规划：每期目标、交付物、依赖关系、风险控制、里程碑定义、各期之间的渐进关系 |
| 5 | [05-workflow-integration.md](./05-workflow-integration.md) | 现有 workflow extension 的复用分析：各 Phase 如何使用 workflow 的 agent/parallel/pipeline 能力，可替换和不可替换的部分 |

## 核心结论速览

1. **数据矿已存在**：pi 已有 667 个 session 文件（683MB JSONL），包含完整的 Generator 历史轨迹，只是从未被系统分析
2. **Verifier 缺失是核心瓶颈**：GVU 框架中 Generator 天然存在（session 日志就是），但 Verifier（质量评判）完全空白
3. **半自动优于全自动**：Ratchet 论文的核心发现——LLM 自动生成的技能贡献为 +0.0pp，人类筛选后为 +16.2pp。进化建议应走"LLM Judge 生成 + 人类审批"模式
4. **先做数据采集，再做分析，最后做闭环**：分五期推进，每期都有独立价值，不依赖后续期即可产出
5. **优先 L1（CLAUDE.md）+ L2（Skill 库）**：五层进化中，L1（提示词优化）和 L2（技能库扩充）成本最低、收益最高，应优先实施
