---
verdict: pass
---

# Use Cases — Self-Evolution Phase 4

## UC-1: 用户通过 /evolve 获取进化建议

- **Actor:** Pi Agent 用户
- **Preconditions:**
  - evolution-engine extension 已安装到 `~/.pi/agent/extensions/`
  - `usage-tracker` 已运行至少 7 天，`evolution-data/daily/` 有数据
  - `pi-session-analyzer` 已安装在 `~/.pi/agent/scripts/`
- **Main Flow:**
  1. 用户在 pi session 中输入 `/evolve`
  2. Extension 查找最近 7 天的分析报告（`reportsDir` 下）
  3. 如无报告，调用 `analyze.py` 生成（`--since 7d --format json --output`）
  4. 读取报告 JSON，调用 `buildJudgeInput` 裁剪数据
  5. 调用 `runJudge` spawn pi 子进程作为 LLM Judge
  6. 解析 Judge 输出为 `EvolutionSuggestion[]`
  7. 保存到 `pending.json`
  8. 返回建议摘要（index + severity + title）给用户
- **Alternative Paths:**
  - 2a. analyzer 脚本不存在 → 抛错 "Session analyzer not found"
  - 3a. analyzer 运行超时（60s）→ 抛错 "Failed to run session analyzer"
  - 6a. Judge 输出非 JSON → 保存原始输出到 `judge-raw-*.txt`，抛错
- **Postconditions:**
  - `pending.json` 包含 pending 状态的建议
  - 用户看到建议摘要，可继续用 `/evolve-apply` 操作
- **Module Boundaries:** commands.ts → judge.ts → pi subprocess → state.ts
- **Spec AC Coverage:** D4.1, D3.3

## UC-2: 用户审批并应用进化建议

- **Actor:** Pi Agent 用户
- **Preconditions:**
  - UC-1 已完成，`pending.json` 存在
- **Main Flow:**
  1. 用户输入 `/evolve-apply action=list`
  2. Extension 显示所有 pending 状态的建议（含 diff 预览）
  3. 用户选择一条建议，输入 `/evolve-apply action=apply index=0`
  4. Extension 校验路径白名单、文件存在性
  5. 备份原文件到 `backups/` 目录
  6. 应用 unified diff 到目标文件
  7. 尝试 `git add + commit`
  8. 更新 `pending.json` 状态为 "applied"
  9. 记录到 `history.jsonl`
  10. 返回成功信息
- **Alternative Paths:**
  - 4a. 路径不在白名单 → 返回 "path not allowed"
  - 6a. diff 冲突 → 标记 "failed"，返回冲突原因
  - 7a. git commit 失败 → 不阻塞 apply，记录 warning
  - 用户跳过: `/evolve-apply action=skip index=1` → 标记 "rejected"
- **Postconditions:**
  - 目标文件已修改
  - 备份文件存在于 `backups/` 目录
  - `history.jsonl` 新增一条 apply 记录
- **Module Boundaries:** commands.ts → applier.ts → state.ts
- **Spec AC Coverage:** D4.3, D4.4

## UC-3: 用户回滚已应用的进化建议

- **Actor:** Pi Agent 用户
- **Preconditions:**
  - UC-2 已完成，`history.jsonl` 有 apply 记录
  - 备份文件仍然存在
- **Main Flow:**
  1. 用户输入 `/evolve-rollback index=1`
  2. Extension 加载 history（最近 20 条）
  3. 校验 index 有效且 action === "apply"
  4. 如果有 commitSha → 尝试 `git revert`
  5. 如果 revert 失败或无 commitSha → `copyFileSync(backup → target)`
  6. 尝试 `git add + commit` rollback 操作
  7. 记录 rollback 到 `history.jsonl`
  8. 返回成功信息
- **Alternative Paths:**
  - 3a. index 无效 → 抛错 "Invalid index"
  - 3b. 非 apply 记录 → 抛错 "Cannot rollback a 'skip' action"
  - 4a. git revert 失败 → fallback 到文件恢复
  - 5a. 备份文件不存在 → 返回 "backup file not found"
- **Postconditions:**
  - 目标文件恢复为 apply 前的内容
  - `history.jsonl` 新增一条 rollback 记录
- **Module Boundaries:** commands.ts → applier.ts → state.ts
- **Spec AC Coverage:** D4.4

## UC-4: 系统自动检测进化信号

- **Actor:** evolution-engine (自动触发)
- **Preconditions:**
  - `usage-tracker` 已运行，`evolution-data/` 有数据
- **Main Flow:**
  1. Pi session 启动，触发 `session_start` 事件
  2. Extension 调用 `checkAutoTriggerRules(evolutionDir)`
  3. 加载最近 14 天 daily 数据
  4. 检查 token-decline 规则（最近 3 天 token/session > 基线）
  5. 检查 skill-dormant 规则（skill > 30 天未触发）
  6. 检查 error-spike 规则（错误率增长 > 50%）
  7. 命中的规则写入 `auto-trigger.flags/` 目录
  8. 清理过期 flag（> 7 天）
  9. 通过 `ctx.ui.notify` 提示用户
- **Alternative Paths:**
  - 无数据 → 返回空数组，无提示
  - flag 在 24h 冷却期内 → 跳过
- **Postconditions:**
  - 有效 flag 文件存在于 `auto-trigger.flags/`
  - 用户收到 "Consider running /evolve" 提示
- **Module Boundaries:** monitor.ts → daily JSON → flag files
- **Spec AC Coverage:** P5.5

## UC-5: merge-reviewer 模板分析合并模式

- **Actor:** Pi Agent 用户
- **Preconditions:**
  - UC-1 的 preconditions
  - `templates/merge-reviewer.txt` 已创建
- **Main Flow:**
  1. 用户输入 `/evolve target=merge-reviewer`
  2. Extension 使用 `TARGET_TEMPLATE["merge-reviewer"]` 映射
  3. `extractReportSubset` 提取 tool_stats + error_stats + user_patterns
  4. Judge 使用 merge-reviewer 模板分析合并效率、审查模式、工具优化
  5. 返回建议
- **Alternative Paths:**
  - target 未识别 → fallback 到 "all"
- **Postconditions:**
  - 合并相关的进化建议生成
- **Module Boundaries:** commands.ts → judge.ts → templates/merge-reviewer.txt
- **Spec AC Coverage:** merge-reviewer 模板

## UC-Coverage Mapping

| UC | Spec AC |
|----|---------|
| UC-1 | D4.1, D3.3 |
| UC-2 | D4.3, D4.4 |
| UC-3 | D4.4 |
| UC-4 | P5.5 |
| UC-5 | merge-reviewer 模板 |
