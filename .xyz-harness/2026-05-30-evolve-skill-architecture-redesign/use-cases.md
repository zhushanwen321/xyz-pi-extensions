---
verdict: pass
---

# Use Cases — Evolve Skill Architecture Redesign

## UC-1: 每日自动数据收集

- **Actor**: Pi 系统（evolve-daily extension）
- **Preconditions**: Pi 已安装 evolve-daily extension；Python analyzer 脚本存在
- **Main Flow**:
  1. 用户启动 Pi session
  2. evolve-daily 监听 `session_start` 事件
  3. 检查 `~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json` 是否存在
  4. 不存在 → 执行 `python3 analyze.py --since 1d --format json --output <path>`，fire-and-forget
  5. 已存在 → 跳过
- **Exception Paths**:
  - E1: analyzer 执行失败 → console.error 日志，session 正常继续
- **Postconditions**: 当天的 JSON 报告文件存在于 daily-reports/
- **Module Boundaries**: evolve-daily extension → Python analyzer → 文件系统
- **Spec AC 覆盖**: AC-1

## UC-2: 手动触发进化分析

- **Actor**: 用户
- **Preconditions**: Pi session 中；evolution-data 目录有历史数据
- **Main Flow**:
  1. 用户输入 `/evolve` 或自然语言变体
  2. LLM 读取 daily/*.json、daily-reports/*.json、history.jsonl 等数据
  3. LLM 自行分析趋势和异常
  4. 生成进化建议列表
  5. 写入 `pending.json`（格式见 spec 数据模型）
- **Alternative Paths**:
  - A1: `/evolve since=14d` → 读取不少于 14 天数据
  - A2: `/evolve 分析 skill` → 聚焦 skill 维度
- **Exception Paths**:
  - E1: 无数据 → 给出明确提示而非报错
- **Postconditions**: pending.json 包含 1+ 条 pending 状态建议
- **Module Boundaries**: evolve skill → 文件系统（读数据、写 pending.json）
- **Spec AC 覆盖**: AC-2

## UC-3: 应用进化建议

- **Actor**: 用户
- **Preconditions**: pending.json 中存在 pending 状态建议
- **Main Flow**:
  1. 用户输入 `/evolve-apply apply N`
  2. LLM 读取 pending.json，找到第 N 条建议
  3. LLM 用 bash 做 `cp` 备份到 backups/
  4. LLM 用 edit/write 修改 targetPath 指定的文件
  5. LLM 尝试 git add + commit
  6. LLM 追加记录到 history.jsonl
  7. LLM 更新 pending.json 中该建议状态为 applied
- **Exception Paths**:
  - E1: edit 失败 → 说明原因，保持 pending，不做任何写入
  - E2: git commit 失败 → 继续，commitSha 为空
  - E3: 备份失败 → 中止 apply，等同于文件修改失败
- **Postconditions**: 目标文件已修改；备份存在于 backups/；history.jsonl 有新记录；pending.json 状态更新
- **Module Boundaries**: evolve-apply skill → 文件系统（edit、cp、git、JSON 读写）
- **Spec AC 覆盖**: AC-3

## UC-4: 跳过进化建议

- **Actor**: 用户
- **Preconditions**: pending.json 中存在 pending 状态建议
- **Main Flow**:
  1. 用户输入 `/evolve-apply skip N`
  2. LLM 读取 pending.json，找到第 N 条建议
  3. 更新状态为 rejected
  4. 写回 pending.json
- **Postconditions**: pending.json 中第 N 条建议状态为 rejected
- **Module Boundaries**: evolve-apply skill → 文件系统（JSON 读写）
- **Spec AC 覆盖**: AC-3

## UC-5: 回滚进化建议

- **Actor**: 用户
- **Preconditions**: history.jsonl 中存在 applied 记录；backups/ 中有备份文件
- **Main Flow**:
  1. 用户输入 `/evolve-apply rollback`
  2. LLM 读取 history.jsonl 最近一条 applied 记录
  3. 从 backups/ 恢复原文件（cp）
  4. 尝试 git add + commit
  5. 追加 rollback 记录到 history.jsonl
- **Exception Paths**:
  - E1: 备份文件不存在 → 向用户说明无法自动恢复，建议手动 git 检查
- **Postconditions**: 目标文件恢复到修改前状态；history.jsonl 有 rollback 记录
- **Module Boundaries**: evolve-apply skill → 文件系统（cp 恢复、git、JSON 读写）
- **Spec AC 覆盖**: AC-3

## UC-6: 查看报告

- **Actor**: 用户
- **Preconditions**: daily-reports/ 中存在 JSON 报告
- **Main Flow**:
  1. 用户输入 `/evolve-report` 或 `/evolve-report YYYY-MM-DD`
  2. LLM 读取对应日期的 JSON 报告
  3. 格式化展示关键信息
- **Alternative Paths**:
  - A1: `/evolve-report --list` → 列出所有可用报告日期
  - A2: 无参数 → 显示今天报告
- **Postconditions**: 用户看到格式化的报告内容
- **Module Boundaries**: evolve-report skill → 文件系统（读 JSON）
- **Spec AC 覆盖**: AC-4

## UC-7: 查看统计数据

- **Actor**: 用户
- **Preconditions**: daily/ 目录中存在历史汇总数据
- **Main Flow**:
  1. 用户输入 `/evolve-stats`
  2. LLM 读取 daily/*.json
  3. 自行汇总展示趋势统计
- **Postconditions**: 用户看到统计数据
- **Module Boundaries**: evolve-report skill → 文件系统（读 JSON）
- **Spec AC 覆盖**: AC-4

## UC-8: 系统清理和迁移

- **Actor**: 开发者
- **Preconditions**: 旧 evolution-engine extension 已安装
- **Main Flow**:
  1. 删除 evolution-engine/ 目录
  2. 删除 `~/.pi/agent/extensions/evolution-engine` symlink
  3. 安装 3 个 skill 的 symlink 到 `~/.pi/agent/skills/`
  4. 安装 evolve-daily extension 的 symlink 到 `~/.pi/agent/extensions/`
- **Postconditions**: 旧 extension 完全移除；新 skill 和 extension 可用；Pi 启动无报错
- **Module Boundaries**: 文件系统（目录删除、symlink 创建）
- **Spec AC 覆盖**: AC-5

## Coverage Mapping

| UC | Spec AC |
|----|---------|
| UC-1 | AC-1 |
| UC-2 | AC-2 |
| UC-3 | AC-3 (apply) |
| UC-4 | AC-3 (skip) |
| UC-5 | AC-3 (rollback) |
| UC-6 | AC-4 |
| UC-7 | AC-4 |
| UC-8 | AC-5 |
