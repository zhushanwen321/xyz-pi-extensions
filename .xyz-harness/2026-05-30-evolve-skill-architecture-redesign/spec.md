---
verdict: pass
---

# Evolve Skill Architecture Redesign

## Background

当前 `evolution-engine` 是一个约 1500 行的 Pi extension 插件，注册了 5 个 tool + 5 个 command + 1 个 session_start hook。它自己编排 analyzer → summarizer → judge → applier 全链路，包含 LLM Judge 子进程调用、自动触发规则监控、TUI 渲染等功能。

这种架构有两个核心问题：

1. **LLM 能力被浪费**：extension 自己做 summarizer 和 judge（TypeScript 实现），再 spawn 一个 `pi` 子进程做 applier。实际上主 LLM 自己就能分析数据、生成建议、修改文件——不需要这些中间层。
2. **维护成本高**：5 个 tool schema、5 个 command handler、TUI 渲染、锁管理、白名单校验等基础设施代码占了一大半，真正的业务逻辑反而被淹没。

改成 Skill 架构后，LLM 直接读数据、分析、输出建议、修改文件，不需要 TypeScript 编排。

## Functional Requirements

### FR-1: 每日自动数据收集

系统在每天首次 session 启动时自动运行 Python session analyzer，生成当日数据分析。无需 LLM 参与，纯脚本执行。

- **FR-1.1**: `evolve-daily` extension 监听 `session_start` 事件
- **FR-1.2**: 检查当天 `~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json` 是否已存在
- **FR-1.3**: 不存在则执行 `python3 analyze.py --since 1d --format json`，fire-and-forget。Python analyzer 的输出文件名包含日期，幂等写入，并发执行不冲突（后写入者覆盖，内容一致）
- **FR-1.4**: 失败时仅 console.error 日志，不阻塞 session

### FR-2: `/evolve` Skill — 分析使用数据并生成建议

用户触发后，LLM 读取近期使用数据，自行分析趋势和异常，生成进化建议写入 pending.json。

- **FR-2.1**: 触发词：`/evolve`、`evolve`、`进化分析`、`分析使用模式`
- **FR-2.2**: LLM 读取以下数据源（按需，非全部必须）：
  - `~/.pi/agent/evolution-data/daily/*.json` — 每日汇总
  - `~/.pi/agent/evolution-data/daily-reports/*.json` — Python analyzer 深度分析
  - `~/.pi/agent/evolution-data/skill-triggers.json` — skill 使用统计
  - `~/.pi/agent/evolution-data/tool-stats.json` — 工具调用统计
  - `~/.pi/agent/evolution-data/history.jsonl` — 已应用建议历史（用于效果回顾）
  - `~/.pi/agent/evolution-data/metrics-history.json` — 指标趋势
- **FR-2.3**: LLM 自行决定分析范围和深度，支持自然语言指令：
  - `/evolve` → 默认最近 7 天全部维度
  - `/evolve 最近 3 天的 skill 使用` → 聚焦 skill 维度
  - `/evolve since=14d` → 扩大时间窗口
- **FR-2.4**: 建议写入 `~/.pi/agent/evolution-data/suggestions/pending.json`，格式见数据模型
- **FR-2.5**: 建议目标限定为 `~/.pi/agent/` 目录下的 `.md` 文件（CLAUDE.md、SKILL.md 等）

### FR-3: `/evolve-apply` Skill — 管理建议生命周期

用户查看、应用、跳过或回滚进化建议。

- **FR-3.1**: 触发词：`/evolve-apply`、`evolve-apply`、`应用建议`、`/evolve-rollback`、`evolve rollback`
- **FR-3.2**: 无参数或 `list` → 读取 pending.json，展示所有 pending 建议
- **FR-3.3**: `apply N` → 应用第 N 条建议：
  - LLM 用 `edit` 或 `write` 工具直接修改 `targetPath` 指定的文件
  - 修改前用 bash 做 `cp` 备份到 `~/.pi/agent/evolution-data/backups/`
  - 修改后尝试 `git add + commit`
  - 追加记录到 `history.jsonl`（commit 失败时 commitSha 为空，不影响记录）
  - 更新 pending.json 中该建议状态为 `applied`
  - **失败处理**：文件修改失败时（edit 报错、输出为空等），LLM 向用户说明原因，保持 pending 状态，不做任何写入。git commit 失败不影响 apply 结果（文件已修改成功，只是未提交）
- **FR-3.4**: `skip N` → 标记建议为 `rejected`
- **FR-3.5**: `rollback` → 读取 history.jsonl 最近条目：
  - **首选 cp 备份恢复**：从 backups/ 目录恢复原文件，这是最可靠的手段
  - git revert 不作为恢复手段（可能因后续 commit 冲突），仅作为参考信息展示给用户
  - 恢复后尝试 `git add + commit`
  - 追加 rollback 记录到 history.jsonl
  - **失败处理**：备份文件不存在时，向用户说明无法自动恢复，建议手动 git 检查
- **FR-3.6**: LLM 自由处理自然语言指令，不强制参数格式

### FR-4: `/evolve-report` Skill — 查看报告和统计

用户查看历史报告、统计数据。

- **FR-4.1**: 触发词：`/evolve-report`、`evolve-report`、`查看报告`、`进化报告`、`/evolve-stats`、`evolve-stats`
- **FR-4.2**: 无参数 → 显示今天报告
- **FR-4.3**: 指定日期 → 显示该日报告
- **FR-4.4**: `--list` → 列出所有可用报告
- **FR-4.5**: 统计数据（替代原 evolve-stats）：LLM 读取 daily/*.json，自行汇总展示

### FR-5: 删除旧 evolution-engine extension

- **FR-5.1**: 删除整个 `evolution-engine/` 目录
- **FR-5.2**: 删除 `~/.pi/agent/extensions/evolution-engine` symlink
- **FR-5.3**: 保留 `~/.pi/agent/evolution-data/` 数据目录（usage-tracker 仍在写入）
- **FR-5.4**: 保留 `~/.pi/agent/scripts/pi-session-analyzer/` Python 脚本

### FR-6: 创建三个 Skill 和一个 Hook Extension

- **FR-6.1**: 创建 `skills/evolve/SKILL.md`（FR-2）
- **FR-6.2**: 创建 `skills/evolve-apply/SKILL.md`（FR-3）
- **FR-6.3**: 创建 `skills/evolve-report/SKILL.md`（FR-4）
- **FR-6.4**: 创建 `evolve-daily/` hook extension（FR-1）
- **FR-6.5**: 安装三个 skill 的 symlink 到 `~/.pi/agent/skills/`
- **FR-6.6**: 安装 evolve-daily 的 symlink 到 `~/.pi/agent/extensions/`

## Acceptance Criteria

### AC-1: 每日自动收集
- [ ] `evolve-daily` extension 安装后，启动 Pi session 时自动检查当天报告
- [ ] 当天无报告时执行 Python analyzer，生成 JSON 文件
- [ ] 当天已有报告时跳过
- [ ] analyzer 失败时 session 正常启动，仅日志记录
- [ ] 连续多天每天首次启动各生成一份报告

### AC-2: `/evolve` 分析
- [ ] `/evolve` 触发后 LLM 读取数据并输出分析结论和建议
- [ ] 建议写入 `pending.json`，格式与现有兼容（suggestions 数组非空，每条包含 id/title/targetPath/status 必需字段）
- [ ] `/evolve since=14d` → 读取不少于 14 天数据；`/evolve 分析 skill` → 输出聚焦 skill 维度
- [ ] 无数据时给出明确提示而非报错

### AC-3: `/evolve-apply` 操作
- [ ] 无参数展示所有 pending 建议及其摘要
- [ ] `apply N` 成功修改目标文件，备份存在，history.jsonl 有记录
- [ ] `skip N` 标记为 rejected
- [ ] `rollback` 成功恢复文件到修改前状态
- [ ] pending.json 状态同步更新

### AC-4: `/evolve-report` 展示
- [ ] 无参数展示今天报告
- [ ] 指定日期展示对应报告
- [ ] `--list` 列出所有可用报告日期

### AC-5: 清理
- [ ] 旧 `evolution-engine` extension 完全移除，Pi 启动无报错
- [ ] `/evolve`、`/evolve-apply`、`/evolve-report` 命令通过 skill 触发
- [ ] `evolve`、`evolve-apply`、`evolve-report`、`evolve-stats`、`evolve-rollback` 工具不再注册（不作为 tool）

## Constraints

- **语言**: Skill 用中文编写（SKILL.md 中文内容），extension TypeScript
- **数据兼容**: pending.json 格式保持与现有兼容，已有的 pending 建议不丢失
- **不新增依赖**: evolve-daily extension 不引入新 npm 包，只依赖 Pi Extension API 和 Node.js 内置模块
- **Python analyzer 不修改**: `~/.pi/agent/scripts/pi-session-analyzer/` 保持不变
- **usage-tracker 不修改**: 数据采集层保持现有行为
- **数据目录不变**: `~/.pi/agent/evolution-data/` 路径和子目录结构保持兼容

## 业务用例

无业务用例。纯技术性需求——将 Pi agent 的自我进化机制从重量级 extension 改为轻量 skill。

## Data Models

### pending.json（保持现有格式）

```json
{
  "generatedAt": "ISO timestamp",
  "reportUsed": "daily | manual",
  "suggestions": [
    {
      "id": "uuid",
      "target": "claude-md | skill",
      "targetPath": "absolute path to .md file",
      "severity": "high | medium | low",
      "confidence": 0.0-1.0,
      "title": "one-line title",
      "description": "detailed description",
      "rationale": "data-backed reasoning",
      "instruction": "modification instruction for LLM",
      "status": "pending | applied | rejected"
    }
  ]
}
```

### history.jsonl（每行一条，保持现有格式）

```json
{
  "timestamp": "ISO timestamp",
  "action": "apply | rollback",
  "suggestionId": "uuid",
  "targetPath": "absolute path",
  "backupPath": "absolute path",
  "instruction": "modification instruction",
  "title": "suggestion title",
  "commitSha": "git SHA or undefined"
}
```

## Architecture

```
删除:
  evolution-engine/                    # ~1500 行 TS，全部删除
  ~/.pi/agent/extensions/evolution-engine  # symlink 删除

保留（不修改）:
  usage-tracker/                       # 数据采集 extension
  ~/.pi/agent/scripts/pi-session-analyzer/  # Python 分析脚本
  ~/.pi/agent/evolution-data/          # 数据目录

新增:
  skills/evolve/SKILL.md               # 分析 skill
  skills/evolve-apply/SKILL.md         # 应用/回滚 skill
  skills/evolve-report/SKILL.md        # 报告/统计 skill
  evolve-daily/                        # 极简 hook extension (~40 行)
    ├── package.json
    ├── index.ts → src/index.ts
    └── src/index.ts
```

### 数据流

```
自动层（每天一次）:
  Pi session_start
    → evolve-daily extension 检查当天报告
    → 不存在 → python3 analyze.py → daily-reports/YYYY-MM-DD.json
    → 已存在 → 跳过

用户层（按需触发）:
  /evolve       → LLM 读 daily/*.json + daily-reports/*.json + history.jsonl
                  → 自行分析 → 写入 pending.json

  /evolve-apply → LLM 读 pending.json
                  → 展示 / apply / skip / rollback
                  → apply: edit 目标文件 + cp 备份 + git commit
                  → rollback: cp 恢复 / git revert

  /evolve-report→ LLM 读 daily-reports/*.json
                  → 格式化展示
```

## Complexity Assessment

**低复杂度**。核心工作是：

1. 写 3 个 SKILL.md（纯文档，无代码逻辑）
2. 写 1 个 ~40 行的 hook extension（只调 Python 脚本）
3. 删除旧 extension + 更新 symlink

最大的风险点是 SKILL.md 的 prompt 质量——LLM 能否正确理解数据格式并产出高质量建议。但这可以通过迭代优化 prompt 来解决，不需要架构层面的复杂度。
