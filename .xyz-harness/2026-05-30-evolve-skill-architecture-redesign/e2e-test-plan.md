---
verdict: pass
---

# E2E Test Plan — Evolve Skill Architecture Redesign

## Test Scenarios

### TS-1: 每日自动收集 (AC-1)

**前置条件**: evolve-daily extension 已安装；Python analyzer 脚本存在。

1. 删除当天 `daily-reports/YYYY-MM-DD.json`（如存在）
2. 启动 Pi session
3. 等待 10 秒
4. 验证 `daily-reports/YYYY-MM-DD.json` 已生成且是有效 JSON
5. 重启 Pi session
6. 验证不会重新生成（文件修改时间不变）

**异常测试**:
- 将 `analyze.py` 暂时重命名 → 启动 Pi → session 正常启动，console 有 error 日志

### TS-2: /evolve 分析 (AC-2)

**前置条件**: evolution-data/ 中有至少 3 天的历史数据。

1. 输入 `/evolve`
2. 验证 LLM 输出包含分析结论和建议列表
3. 验证 `pending.json` 已更新，suggestions 数组非空
4. 验证每条建议包含 id/title/targetPath/status 必需字段
5. 输入 `/evolve since=14d`
6. 验证 LLM 读取了不少于 14 天的数据
7. 删除所有 daily 和 daily-reports 文件
8. 输入 `/evolve`
9. 验证 LLM 给出明确提示而非报错

### TS-3: /evolve-apply 操作 (AC-3)

**前置条件**: pending.json 中有至少 2 条 pending 建议。

**List**:
1. 输入 `/evolve-apply`
2. 验证 LLM 展示所有 pending 建议及其摘要

**Apply**:
1. 输入 `/evolve-apply apply 0`
2. 验证目标文件已修改
3. 验证 `backups/` 中有备份文件
4. 验证 `history.jsonl` 有新记录（action: apply）
5. 验证 pending.json 中第 0 条建议状态为 applied

**Skip**:
1. 输入 `/evolve-apply skip 1`
2. 验证 pending.json 中第 1 条建议状态为 rejected

**Rollback**:
1. 输入 `/evolve-apply rollback`
2. 验证目标文件已恢复到修改前内容
3. 验证 `history.jsonl` 有新记录（action: rollback）

**Apply 失败**:
1. 手动修改 pending.json，将第 N 条建议的 targetPath 改为一个不存在的路径
2. 输入 `/evolve-apply apply N`
3. 验证 LLM 向用户报告失败原因
4. 验证 pending.json 中该建议状态仍为 pending（未被改为 applied）
5. 验证 history.jsonl 没有新增记录

### TS-4: /evolve-report 展示 (AC-4)

**前置条件**: daily-reports/ 中有多个日期的 JSON 报告。

1. 输入 `/evolve-report`
2. 验证显示今天报告内容
3. 输入 `/evolve-report 2026-05-29`（使用实际存在的日期）
4. 验证显示对应日期报告
5. 输入 `/evolve-report --list`
6. 验证列出所有可用报告日期

### TS-5: 清理验证 (AC-5)

**前置条件**: 旧 evolution-engine extension 已安装（symlink 存在）。

1. 执行清理任务（删除目录 + 更新 symlink）
2. 启动 Pi
3. 验证启动无报错
4. 验证 `/evolve` 命令可触发 skill
5. 验证 `/evolve-apply` 命令可触发 skill
6. 验证 `/evolve-report` 命令可触发 skill
7. 验证旧 tool（evolve、evolve-stats 等）不再注册

## Test Environment

- **本地开发机**: macOS, Node.js v24.x
- **Pi 版本**: xyz-pi 0.75.5+
- **数据目录**: `~/.pi/agent/evolution-data/`（使用真实数据或手动构造测试数据）
- **验证方式**: 手动在 Pi TUI 中执行命令，检查输出和文件状态
- **测试顺序**: TS-5（清理）→ TS-1（自动收集）→ TS-2（分析）→ TS-3（apply）→ TS-4（report）
