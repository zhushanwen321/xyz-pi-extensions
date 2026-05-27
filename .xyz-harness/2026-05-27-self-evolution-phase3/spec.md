---
verdict: pass
---

# Evolution Engine — Pi Agent 自我进化闭环

## Background

Pi Agent 的自我进化系统分为五期路线图（`docs/self-evolution/04-phased-roadmap.md`）。Phase 1（usage-tracker 信号采集）和 Phase 2（pi-session-analyzer Python 脚本）已完成，产出了可用的信号数据和结构化分析报告。

当前状态：
- `~/.pi/agent/evolution-data/` 下已有 daily 汇总、tool-stats、skill-triggers、session-manifest
- `~/.pi/agent/evolution-data/reports/` 下已有回顾性分析 JSON + Markdown 报告
- `~/.pi/agent/scripts/pi-session-analyzer/` 分析脚本可用，支持 `--since 7d --format json` 等参数

本 spec 合并原规划中的 Phase 3（LLM Judge 集成）+ Phase 4（Evolution Engine 闭环）+ Phase 5.5（自动触发规则），一步到位搭建完整的 evolution-engine Extension。

核心洞察：Pi 的所有 LLM 调用都通过 `spawn("pi", ["--mode", "json"])` 子进程实现，extension 本身不做推理。evolution-engine Extension 的角色是**编排+审批+修改**，LLM Judge 推理在独立子进程中完成。

架构分层：
```
Pi Extension (evolution-engine)  ← 命令注册、TUI 渲染、文件读写、子进程编排
  └─ LLM Judge 子进程              ← 读取信号 JSON，分析并生成建议（只读）
  └─ Phase 2 Python 脚本           ← 解析 session 原始数据，产出聚合 JSON
```

所有组件通过文件系统通信：Phase 1 写 evolution-data/ → Phase 2 读并写 reports/ → Evolution Engine 读 reports/ → Judge 返回 JSON → Applier 写目标文件。

## Functional Requirements

### FR-1: `/evolve` 命令 — 完整分析+建议+审批

**触发流程**：

1. 检查 `~/.pi/agent/evolution-data/reports/` 下 7 天内是否有 JSON 报告
2. 若无，自动执行 `python3 ~/.pi/agent/scripts/pi-session-analyzer/analyze.py --since 7d --format json --output <tmp>` 生成报告
3. 若 analyze.py 执行失败（Python 缺失/脚本报错），显示错误信息并终止
4. 读取 JSON 报告，根据 `--target` 参数裁剪信号数据：
   - `all`（默认）：完整报告
   - `claude-md`：仅 token_stats + user_patterns + actionable_issues
   - `skills`：仅 skill_stats + skill_health + actionable_issues
5. 构建 LLM Judge 输入并写入临时文件到 `~/.pi/agent/evolution-data/tmp/`（session 结束时清理）
6. 启动 LLM Judge 子进程：
   ```
   spawn("pi", ["--mode", "json", "-p", "--model", "router-openai/glm-5.1",
                 "--no-session",
                 "--append-system-prompt", <templatePath>,
                 "Task: 分析以下信号数据，生成进化建议..."])
   ```
7. 等待子进程完成（超时 120s），解析 stdout JSON 为 `EvolutionSuggestion[]`
8. 若 Judge 返回非 JSON，记录 raw output 到 evolution-data 目录下，显示错误信息
9. 写入 `pending.json`，逐条 TUI 审批
10. 用户确认后调用 applier 批量应用通过的修改
11. 清理本次产生的临时 flags

**命令参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--target` | enum | 否 | `all` / `claude-md` / `skills`，默认 `all` |
| `--since` | string | 否 | 同 analyze.py 的 `--since`，默认 `7d` |
| `--sample` | int | 否 | 透传给 analyze.py 的 `--sample` 参数，抽样 session 数。若指定了值则直接传给 analyze.py 调用，不做二次裁剪 |

**TUI 审批交互**：逐条展示建议（标题、严重程度、置信度、原因、建议 diff），用户输入 y/n/e 逐条决策。支持中途退出（已决策的不丢失，pending.json 保留未决策的）。

### FR-2: LLM Judge — 结构化建议生成

**3 套 System Prompt 模板**（位于 extension 源码 `templates/` 目录，作为 `.txt` 文件而非 TypeScript 模块。原因：(1) prompt 是纯文本，无逻辑，不需要 TS 编译；(2) 文本文件方便独立迭代 prompt 而不改动代码；(3) 与 subagent extension 的 temp prompt 文件模式一致）：

| 模板 | 评判场景 | 输入 |
|------|---------|------|
| `session-quality.txt` | session 整体质量分析 | 完整 reports JSON |
| `skill-health.txt` | skill 健康度评估 | skill_stats + skill_health |
| `prompt-optimize.txt` | CLAUDE.md 质量评估 | token_stats + user_patterns + actionable_issues |

每套模板包含：角色定义、评判维度、输出 JSON schema、置信度要求。

**Judge 输出的 EvolutionSuggestion schema**：
```json
{
  "id": "uuid",
  "target": "claude-md",
  "targetPath": "/absolute/path/to/CLAUDE.md",
  "severity": "high",
  "confidence": 0.89,
  "title": "Add rule: ...",
  "description": "建议的具体内容",
  "rationale": "数据支撑（如：8 sessions 中出现此模式）",
  "diff": "unified diff format"
}
```

Judge 子进程固定使用 `router-openai/glm-5.1` 模型，与用户当前模型无关，保证分析质量一致性。

Judge 子进程只具备只读权限（`--no-session`），不修改任何文件。

### FR-3: Applier — 建议应用引擎

**Apply 流程**（每个 suggestion）：

1. 预检查：验证 `targetPath` 存在且 `diff` 可应用
2. 若 diff 应用失败（文件已被修改），跳过该建议，标记为 `failed`，继续下一条
3. 备份原文件到 `~/.pi/agent/evolution-data/backups/<timestamp>/<relative-path>`
4. 应用 unified diff 到目标文件
5. 若目标文件在 git 仓库中，执行 `git add <file> && git commit -m "evolve: <title>"`
6. 若 git commit 失败（不在仓库/无权限），apply 照常执行并给出 warning
7. 记录到 `~/.pi/agent/evolution-data/history.jsonl`
8. Summary 中报告：成功 N、跳过 M（含原因）

### FR-4: `/evolve-apply` 命令 — 应用 pending 中的建议

从 `pending.json` 读取尚未决策的建议，逐条 TUI 审批后应用。用于 `/evolve` 中途退出后的续批。

### FR-5: `/evolve-stats` 命令 — 查看信号统计

读取 `evolution-data/daily/` 和 `tool-stats.json`，展示：
- 最近 7 天总 tool calls、token 消耗、skill 触发排名
- 工具失败率 Top 5
- 与上周对比的趋势箭头（上涨/下降/持平）

### FR-6: `/evolve-rollback` 命令 — 回滚最近进化

展示 `history.jsonl` 中最近的 apply 记录（最多 10 条），用户选择回滚：
1. 从 backup 目录恢复原文件
2. 若之前在 git 中有 commit，执行 `git revert`
3. 记录 rollback 到 history.jsonl

### FR-7: 自动触发规则（monitor.ts）

在 `session_start` 事件中触发，检查 3 条硬编码规则：

| 规则 | 检查逻辑 | 阈值 |
|------|---------|------|
| Token 效率下降 | 最近 7 天 `tokenUsage.totalInput/sessions` 均值 vs 前 7 天 | 连续 3 天上升 |
| Skill 沉睡 | `skill-triggers.json` 中 `lastTriggered` 距今 | > 30 天 |
| 错误率突升 | 最近 3 天 `toolCalls.failures/total` vs 前 30 天均值 | 升高 > 50% |

命中后：写 flag 文件到 `evolution-data/auto-trigger.flags/`（同类型 24h 去重），session_start handler 在命令返回 content 中追加提示消息。每次检查时若条件不再满足则删除对应 flag 文件。**不自动启动分析，不弹窗打断用户。**

**除零保护**：当比较窗口无 session 数据时（如新用户首次使用），分母为 0，该规则自动跳过（不报错、不写 flag）。

### FR-8: `/evolve` 自动分析

当 7 天内报告不存在时，不报错，而是自动执行 `python3 analyze.py --since 7d --format json`。执行期间显示进度提示。

## Acceptance Criteria

### AC-1: `/evolve` 全流程通过
- 执行 `/evolve --target all --since 7d` 完成分析→建议→审批→应用闭环
- pending.json 和 history.jsonl 正确写入
- 被修改的 CLAUDE.md 或 SKILL.md 存在 backup 文件
- 完成闭环流程。若 LLM Judge 返回 0 条建议（数据不足或无需优化场景），也视为通过（pending.json 写入空数组，不报错）

### AC-2: LLM Judge 输出有效
- LLM Judge 子进程在 120s 内返回有效 JSON
- 每条 suggestion 包含所有必需字段（id, target, targetPath, severity, confidence, title, description, rationale, diff）
- confidence 值在 0-1 范围内
- severity 仅为 "high" / "medium" / "low"

### AC-3: 自动分析降级
- 当 reports/ 下无 7 天内报告时，自动执行 analyze.py
- analyze.py 执行失败时显示具体错误信息（stderr），不阻塞 pi 启动
- analyze.py 返回的 JSON 格式正确可被 Judge 消费

### AC-4: diff 应用失败不中断
- 文件已被修改导致 patch 不匹配时，跳过该条，标记 failed
- 后续建议照常应用
- 最终 summary 正确报告 "Applied: 3, Skipped: 1 (diff conflict)"

### AC-5: 自动触发规则
- token 连续 3 天上升时，`auto-trigger.flags/token-decline` 文件被创建
- skill 30 天 zero-trigger 时，`auto-trigger.flags/skill-dormant` 文件被创建
- 错误率上升 50% 时，`auto-trigger.flags/error-spike` 文件被创建
- 24 小时内同类型去重有效

### AC-6: TUI 审批可以中途退出
- `/evolve` 审批过程中用户选择退出，已决策的建议状态保留在 pending.json
- `/evolve-apply` 可以继续处理剩余的 pending 建议

### AC-7: Rollback 恢复
- `/evolve-rollback` 选择一条历史记录后，目标文件恢复到 backup 版本
- 若 backup 文件不存在，显示错误不执行
- rollback 操作记录到 history.jsonl

## Constraints

- **语言**: TypeScript，Pi Extension API
- **LLM Judge 模型**: 固定 `router-openai/glm-5.1`
- **Judge 超时**: 120 秒
- **Python 依赖**: 复用 Phase 2 的 `~/.pi/agent/scripts/pi-session-analyzer/`，不做修改
- **文件系统通信**: 所有组件通过 evolution-data/ 目录下的文件通信，不通过进程间 RPC
- **子进程调用**: evolution-engine 与 subagent extension 同为 `child_process.spawn` 的例外（需更新 CLAUDE.md 运行环境约束）。LLM Judge 通过 `spawn("pi", ["--mode", "json", "-p"])` 启动独立子进程做推理
- **不依赖 subagent extension**: 不通过 subagent tool 调度 Judge。两扩展共享子进程模式但各自独立
- **安装位置**: `~/.pi/agent/extensions/evolution-engine/`

## 业务用例

### UC-1: 用户主动触发进化分析
- **Actor**: Pi 用户
- **场景**: 使用 pi 一段时间后，想看看有没有可以优化的 CLAUDE.md 或 skill 配置
- **预期结果**: 输入 `/evolve` 后，系统自动分析最近的 session 数据，生成 3-10 条有数据支撑的改进建议，用户逐条审批后自动应用

### UC-2: 系统提示优化机会
- **Actor**: Pi 用户
- **场景**: 用户未感知到问题，但系统检测到 token 效率连续下降
- **预期结果**: 下次启动 pi 时看到提示 "Token efficiency declining for 3 days. Consider running /evolve"，用户可选择立即分析或忽略

### UC-3: 应用后回滚
- **Actor**: Pi 用户
- **场景**: 应用了一条 CLAUDE.md 修改建议后，发现 agent 行为变差了
- **预期结果**: 输入 `/evolve-rollback`，从历史列表中选择该次修改，文件恢复到修改前版本

## Out of Scope

- Skill A/B 测试框架（原 Phase 5.1）
- 进化仪表盘 Dashboard（原 Phase 5.2）
- 跨 Agent 技能迁移（原 Phase 5.3）
- 进化策略的进化（原 Phase 5.4）
- 自动应用建议（所有 apply 必须人工确认）
- _render GUI 描述符（首版仅 TUI 审批）
- CLAUDE.md 结构化解析（LLM Judge 直接输出 diff，不解析 AST）
- 自动触发后自动执行分析（仅提示，需用户手动 `/evolve`）

## Complexity Assessment

**High**。涉及多个模块：Pi Extension 工厂函数（commands + TUI 渲染）、LLM Judge 子进程编排（spawn + JSON 解析）、文件系统操作（backup + diff apply + git）、自动触发规则（session_start 事件检查）。预计新增代码量约 1500-2000 行 TypeScript，加上 3 个 prompt 模板文件。核心复杂度在于 LLM Judge 的 prompt 工程和 TUI 审批的交互体验。
