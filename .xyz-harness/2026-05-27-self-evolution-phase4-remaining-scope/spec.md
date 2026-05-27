---
title: "Self-Evolution Phase 4 & 5 Remaining Scope Analysis"
date: 2026-05-27
status: draft
verdict: pass
---

# Self-Evolution Phase 4 & 5 Remaining Scope Analysis

## 1. Background

Pi Agent 的自我进化系统设计文档位于 `docs/self-evolution/`，定义了 5 期路线图。当前 main 分支（`ea4b8b0`）已合并了 Phase 1-3 的工作：

| Phase | 状态 | 交付物 |
|---|---|---|
| Phase 1: 信号采集增强 | **已完成** | `usage-tracker` 增强 + `evolution-data/` 目录 + 每日汇总 |
| Phase 2: Session 分析脚本 | **已完成** | `pi-session-analyzer` Python 脚本（独立于本仓库，位于 `~/.pi/agent/scripts/`） |
| Phase 3: LLM Judge + Evolution Engine | **部分完成** | `evolution-engine` extension 已创建，含完整骨架代码 |
| Phase 4: 闭环自动化 | **未开始** | roadmap 定义了目标，尚未实施 |
| Phase 5: 高级特性 | **未开始** | 候选列表已定义 |

## 2. Current State Assessment

### 2.1 已实现 — Phase 3 在 feat-self-evolution-3 中做的合并

Phase 3 的提交（`0576467`）创建了 `evolution-engine/` extension，包含：

**完整文件清单（2291 行 TS）：**

| 文件 | 行数 | 功能 |
|---|---|---|
| `src/index.ts` | 484 | Extension 工厂：注册 4 个 tool + 4 个 command + session_start 事件 |
| `src/commands.ts` | 506 | 4 个 handler：evolve / evolve-apply / evolve-stats / evolve-rollback |
| `src/judge.ts` | 317 | LLM Judge：spawn pi 子进程，JSONL 解析，输出校验 |
| `src/applier.ts` | 258 | Apply/Rollback：备份 → diff 应用 → git commit → 回滚 |
| `src/monitor.ts` | 327 | 自动触发：token-decline / skill-dormant / error-spike 三条规则 |
| `src/state.ts` | 94 | 持久化：pending.json + history.jsonl |
| `src/types.ts` | 158 | 全部类型定义 |
| `src/widget.ts` | 147 | TUI 渲染函数 |
| `src/templates/*.txt` | 3 文件 | session-quality / prompt-optimize / skill-health |

**关键设计决策：**
- Judge 通过 `spawn("pi", ["--mode", "json", ...])` 调用独立 pi 进程
- 不依赖 workflow extension，自己管理 agent 子进程
- Path 白名单只允许 `~/.pi/agent/` 下的 `.md` 文件
- 4 个 command（`/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback`）已注册
- 自动触发规则在 `session_start` 时检查，结果通过 `ctx.ui.notify` 提示

### 2.2 缺失清单 — 对比 roadmap 中 Phase 4 的 D4.1-D4.4

| Roadmap 交付物 | 当前状态 | 差距分析 |
|---|---|---|
| D4.1: evolution-engine extension | **骨架完成** | 核心代码已存在（2291 行），但未经过端到端验证 |
| D4.2: 四个 Command | **已注册** | `/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback` 全部可用 |
| D4.3: 审批交互流程 | **部分实现** | 有 evolve-apply 的 list/apply/skip 三种 action，但非交互式 TUI（逐条 yes/no/skip）而是通过参数传递 |
| D4.4: 安全回滚机制 | **已实现** | 备份 + git commit + rollback 全部可用 |
| Phase 3 D3.3: 建议质量评估 | **未执行** | LLM Judge 的建议质量从未经过人工评估（7/10 门控） |
| merge-reviewer 模板 | **缺失** | roadmap 提到 4 个模板，实际只有 3 个（缺 merge-reviewer） |

### 2.3 Phase 5 候选特性评估

| 特性 | 优先级 | 前置依赖 | 备注 |
|---|---|---|---|
| P5.1: Skill A/B 测试 | 中 | Phase 4 稳定运行 | 需要 workflow 的 parallel 能力 |
| P5.2: 进化仪表盘 | 低 | Phase 4 数据积累 | 可与 xyz-agent GUI 集成 |
| P5.3: 跨 Agent 技能迁移 | 低 | 无硬依赖 | 独立工作，优先级最低 |
| P5.4: 进化策略的进化 | 中 | Phase 4 运行 4+ 周 | 需要足够的进化历史数据 |
| P5.5: 自动触发规则 | **已实现** | — | `monitor.ts` 中已实现 3 条规则 |

### 2.4 自动触发规则的状态

Phase 5.5 的"自动触发规则"已在 Phase 3 中提前实现：
- `token-decline`：连续 3 天 token/session 超过基线
- `skill-dormant`：skill 超过 30 天未触发
- `error-spike`：错误率相对增长超过 50%

这些在 `session_start` 事件中自动检查，通过 flag 文件管理冷却期和过期清理。

## 3. Gap Analysis: Phase 4 还需要做什么

### 3.1 关键阻塞：端到端验证从未执行

evolution-engine 的代码虽然完整，但存在以下验证空白：

1. **`/evolve` 调用依赖 `pi-session-analyzer` Python 脚本**（`commands.ts` 第 44 行硬编码路径 `~/.pi/agent/scripts/pi-session-analyzer/analyze.py`）
   - 如果脚本不存在或参数不匹配，`/evolve` 会直接失败
   - 需要确认脚本的 CLI 接口与 extension 的调用方式匹配

2. **LLM Judge 质量未验证（D3.3 门控未通过）**
   - roadmap 明确要求：建议质量 ≥7/10 才能进入 Phase 4
   - 当前没有这个评估记录
   - 如果 Judge 输出质量低，整个 `/evolve` 闭环无实际价值

3. **Template 与实际数据 schema 不匹配**
   - 模板期望的输入数据结构（`tool_stats`, `token_stats`, `skill_stats`）可能与 `pi-session-analyzer` 实际输出的 JSON 格式不同
   - `judge.ts` 的 `extractReportSubset` 做了宽松匹配，但实际效果未知

### 3.2 可做的改进（按优先级排序）

#### P0: 端到端验证

| 任务 | 说明 | 工作量 |
|---|---|---|
| 确认 analyzer 脚本接口 | 验证 `analyze.py` 的 CLI 参数和输出格式与 extension 的调用匹配 | 小 |
| 手动跑一次完整闭环 | `/evolve` → 建议 → `/evolve-apply apply index=0` → 验证 diff 正确 | 小 |
| D3.3 建议质量评估 | 对 Judge 输出做人工评分，确认 ≥7/10 | 小 |
| 修复实际发现的问题 | 根据 E2E 测试结果修复 bug | 中 |

#### P1: 缺失功能

| 任务 | 说明 | 工作量 |
|---|---|---|
| 补充 merge-reviewer 模板 | roadmap 定义了 4 个模板，实际只有 3 个 | 小 |
| 改进审批交互 | 当前是参数式（`action=apply index=0`），roadmap 期望交互式逐条确认 | 中 |
| Workflow 集成 | roadmap Phase 4 提到可复用 workflow 的 parallel/pipeline，当前未集成 | 大 |
| `evolve-report` command | roadmap 定义了 4 个 command，实际有 4 个但命名略有差异（有 evolve-stats，无独立的 evolve-report） | 小 |

#### P2: Phase 5 前置准备

| 任务 | 说明 | 工作量 |
|---|---|---|
| _render 协议集成 | 为 GUI 渲染在 details 中添加 `_render` 描述符 | 中 |
| 进化效果追踪 | 每次 apply 后记录效果指标，为 P5.4 做数据准备 | 中 |

## 4. Recommendation

### 4.1 Phase 4 的实际剩余工作

Phase 3 已经把 Phase 4 的大部分骨架搭好了（evolution-engine 2291 行），但 **从未真正跑通**。Phase 4 的核心任务不是"从零实现"，而是：

1. **端到端打通**：确认 Python analyzer → JSON 报告 → LLM Judge → 建议 → Apply 全链路可运行
2. **质量验证**：执行 D3.3 门控，确认 LLM Judge 建议质量达标
3. **修复实际问题**：E2E 测试中发现的 bug
4. **补充缺失模板**：merge-reviewer
5. **改进体验**：审批交互、错误提示

估计工作量：**1-2 周**（而非 roadmap 原定的 2-3 周），因为骨架已存在。

### 4.2 Phase 5 的实施建议

Phase 5 的 5 个候选特性中：
- **P5.5 已提前实现**（monitor.ts），不需要再做
- **P5.1/P5.4 有价值但依赖 Phase 4 稳定运行 4+ 周的数据积累**
- **P5.2/P5.3 优先级低**

建议 Phase 5 采用渐进式策略：先让 Phase 4 跑通并积累数据，再根据实际效果决定 P5.1-P5.4 的优先级。

### 4.3 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| LLM Judge 建议质量不达标 | 中 | 高 | D3.3 门控：优化 prompt 模板、增加 few-shot 示例、切换模型 |
| Python analyzer 脚本不存在或接口不匹配 | 中 | 高 | 用 TS 重写核心分析逻辑（直接读取 daily JSON，不需要解析 session JSONL） |
| evolution-engine 与实际 pi 运行时不兼容 | 低 | 中 | 在 pi 中安装并实际运行测试 |

## 5. Actionable Next Steps

1. **检查 `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` 是否存在**，确认 CLI 接口
2. **在 pi 中安装 evolution-engine**（`ln -s` 到 `~/.pi/agent/extensions/`）
3. **运行 `/evolve` 做一次完整测试**，记录所有失败点
4. **修复发现的问题**
5. **执行 D3.3 建议质量评估**
6. **补充 merge-reviewer 模板**
7. **提交并通过 Phase 4 gate**
