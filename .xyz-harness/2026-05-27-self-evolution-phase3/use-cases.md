---
verdict: pass
---

# Use Cases — Evolution Engine

## UC-1: 用户主动触发进化分析

- **Actor**: Pi 用户
- **Preconditions**:
  - evolution-engine 已安装
  - `~/.pi/agent/evolution-data/` 下有至少 3 天的 session 数据
  - pi-session-analyzer 可执行
- **Main Flow**:
  1. 用户在 Pi 中输入 `/evolve`
  2. 系统检查 reports/ 下是否有 7 天内报告
  3. 若无，自动执行 analyze.py 生成报告
  4. 系统启动 LLM Judge 子进程分析信号数据
  5. Judge 返回 EvolutionSuggestion[] 列表
  6. 系统将建议写入 pending.json
  7. TUI 逐条展示建议卡片（标题、严重程度、置信度、原因、diff 预览）
  8. 用户对每条建议输入 y（应用）/ n（跳过）/ e（编辑）/ q（退出）
  9. 对 approved 的建议：备份原文件 → 应用 diff → git commit → 记录 history
  10. 显示 summary：Applied N, Skipped M
- **Alternative Paths**:
  - 3a. analyze.py 执行失败 → 显示错误信息，终止流程
  - 5a. Judge 返回 0 条建议 → 显示 "No actionable suggestions found"，pending.json 写空数组
  - 5b. Judge 返回非 JSON → 记录 raw output，显示错误信息
  - 5c. Judge 超时（>120s） → 显示超时错误
  - 8a. 用户输入 q 中途退出 → 已决策的建议保留在 pending.json，后续可用 /evolve-apply 续批
  - 9a. diff 应用失败（文件已变） → 跳过该条，标记 failed，继续下一条
  - 9b. git commit 失败 → apply 照常执行，显示 warning
- **Postconditions**:
  - pending.json 包含所有建议（含决策状态）
  - history.jsonl 包含 applied/rejected 记录
  - 被修改的文件存在 backup
- **Module Boundaries**: commands.ts (编排) → judge.ts (分析) → state.ts (持久化) → applier.ts (应用) → widget.ts (渲染)
- **AC Coverage**: AC-1, AC-2, AC-3, AC-4, AC-6

## UC-2: 系统提示优化机会

- **Actor**: Pi 系统（自动）
- **Preconditions**:
  - evolution-engine 已安装
  - usage-tracker 已积累足够历史数据
- **Main Flow**:
  1. 用户启动新 Pi session
  2. session_start 事件触发 monitor.checkAutoTriggerRules()
  3. 系统检查 3 条规则（token 下降、skill 沉睡、错误突升）
  4. 若某条规则命中，写 flag 文件到 auto-trigger.flags/
  5. session_start handler 在返回内容中追加提示消息
  6. 用户看到提示 "Token efficiency declining for 3 days. Consider running /evolve"
  7. 用户输入 `/evolve` 触发 UC-1
- **Alternative Paths**:
  - 3a. 无数据（新用户）→ 除零保护，跳过所有规则，不报错
  - 3b. 条件不再满足 → 删除对应 flag 文件
  - 4a. 同类型 24h 内已有 flag → 跳过（去重）
  - 6a. 用户忽略提示 → 不影响任何行为
- **Postconditions**:
  - flag 文件在 auto-trigger.flags/ 中
  - 用户收到了提示消息
- **Module Boundaries**: monitor.ts (检查) → state.ts (flag 文件读写)
- **AC Coverage**: AC-5

## UC-3: 应用后回滚

- **Actor**: Pi 用户
- **Preconditions**:
  - 至少执行过一次成功的 apply（history.jsonl 非空）
  - backup 文件仍然存在
- **Main Flow**:
  1. 用户输入 `/evolve-rollback`
  2. 系统读取 history.jsonl 最近 10 条记录
  3. TUI 展示回滚列表（时间、操作、标题、文件路径）
  4. 用户选择一条记录
  5. 系统从 backup 目录恢复原文件
  6. 系统尝试 git revert（如有对应 commit）
  7. 系统追加 rollback 记录到 history.jsonl
  8. 显示回滚成功信息
- **Alternative Paths**:
  - 4a. 用户取消 → 不执行任何操作
  - 5a. backup 文件不存在 → 显示错误，不执行回滚
  - 6a. git revert 失败 → 文件已恢复，显示 warning
- **Postconditions**:
  - 目标文件恢复到 apply 前的版本
  - history.jsonl 包含 rollback 记录
- **Module Boundaries**: commands.ts (编排) → applier.ts (回滚) → state.ts (历史) → widget.ts (渲染)
- **AC Coverage**: AC-7

## UC-4: 查看信号统计

- **Actor**: Pi 用户
- **Preconditions**:
  - evolution-engine 已安装
  - `~/.pi/agent/evolution-data/` 下有数据
- **Main Flow**:
  1. 用户输入 `/evolve-stats`
  2. 系统读取 daily/ 下最近 7 天数据
  3. 系统聚合 tool calls、token 消耗、skill 触发
  4. TUI 展示 dashboard（总量、排名、趋势箭头）
- **Alternative Paths**:
  - 2a. 无数据 → 显示 "No data available yet"
- **Postconditions**: 无状态变更
- **Module Boundaries**: commands.ts (编排) → widget.ts (渲染)
- **AC Coverage**: FR-5（无直接 AC 映射，功能展示性）

## UC-AC Coverage Matrix

| UC | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 | AC-6 | AC-7 |
|----|------|------|------|------|------|------|------|
| UC-1 | X | X | X | X | | X | |
| UC-2 | | | | | X | | |
| UC-3 | | | | | | | X |
| UC-4 | | | | | | | |

All AC covered by at least one UC.
