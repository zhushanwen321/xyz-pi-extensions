---
verdict: pass
---

# E2E Test Plan — Evolution Engine

## Test Scenarios

### TS-1: /evolve 全流程闭环（AC-1）

**Preconditions:**
- `~/.pi/agent/evolution-data/daily/` 下有至少 3 天的数据
- `~/.pi/agent/scripts/pi-session-analyzer/` 可执行
- evolution-engine 已安装到 `~/.pi/agent/extensions/evolution-engine/`

**Steps:**
1. 在 Pi 中输入 `/evolve --target all --since 7d`
2. 验证系统自动执行 analyze.py（若报告不存在）
3. 验证 LLM Judge 子进程启动并返回建议
4. 验证 TUI 展示建议列表
5. 对第一条建议输入 `y`（approve）
6. 对第二条建议输入 `n`（skip）
7. 输入 `q`（退出）
8. 验证 summary 显示 "Applied: 1, Skipped: 1"
9. 验证 `pending.json` 中仍有 status=pending 的建议
10. 验证 `history.jsonl` 有一条 apply 记录
11. 验证被修改的文件存在 backup

**Expected:** 完整闭环成功，数据文件正确写入。

### TS-2: /evolve 续批（AC-6）

**Preconditions:** TS-1 执行后，pending.json 有未决策建议。

**Steps:**
1. 输入 `/evolve-apply`
2. 验证显示剩余 pending 建议
3. 对所有建议做决策
4. 验证 pending.json 变为全部非 pending 状态

### TS-3: /evolve-stats 展示（FR-5）

**Steps:**
1. 输入 `/evolve-stats`
2. 验证显示最近 7 天汇总数据
3. 验证工具失败率 Top 5 有数据

### TS-4: /evolve-rollback 回滚（AC-7）

**Preconditions:** TS-1 执行后，history.jsonl 有 apply 记录。

**Steps:**
1. 输入 `/evolve-rollback`
2. 验证展示历史列表
3. 选择第一条记录
4. 验证目标文件恢复到 backup 版本
5. 验证 history.jsonl 新增 rollback 记录

### TS-5: 自动触发规则（AC-5）

**Preconditions:** 无特殊条件。

**Steps:**
1. 启动新 Pi session
2. 检查 `~/.pi/agent/evolution-data/auto-trigger.flags/` 目录
3. 根据实际数据验证是否有 flag 文件
4. 若有 flag，验证 session_start 时显示了提示消息
5. 运行 `/evolve` 后验证 flags 被清理

### TS-6: 分析降级（AC-3）

**Preconditions:** 删除 `~/.pi/agent/evolution-data/reports/` 下所有 JSON 文件。

**Steps:**
1. 输入 `/evolve --target all`
2. 验证系统自动执行 analyze.py
3. 验证 analyze.py 产出新报告
4. 验证后续流程正常

### TS-7: analyze.py 失败处理（AC-3）

**Preconditions:** 临时重命名 analyze.py 使其不可用。

**Steps:**
1. 输入 `/evolve --target all`
2. 验证显示错误信息（含 stderr）
3. 验证不阻塞 Pi

### TS-8: diff 冲突处理（AC-4）

**Preconditions:** 手动修改目标文件使 Judge 的 diff 不匹配。

**Steps:**
1. 运行 `/evolve`，对有冲突的建议 approve
2. 验证该建议标记为 failed
3. 验证后续建议照常执行
4. 验证 summary 包含 "Skipped: 1 (diff conflict)"

### TS-9: 0 条建议场景（AC-1 边界）

**Preconditions:** 使用极少量数据（1 天、1 session）。

**Steps:**
1. 输入 `/evolve --target all --since 1d`
2. 验证即使 0 条建议也不报错
3. 验证 pending.json 写入空 suggestions 数组

### TS-10: 除零保护（AC-5 边界）

**Preconditions:** 清空 daily/ 目录（模拟新用户）。

**Steps:**
1. 启动新 Pi session
2. 验证 monitor 不报错（除零保护）
3. 验证无 flag 文件被创建

## Test Environment

- **Runtime:** Pi 进程（xyz-pi 或原版 pi）
- **Data:** 使用真实 `~/.pi/agent/evolution-data/` 数据
- **LLM:** glm-5.1（Judge 子进程固定模型）
- **Python:** 系统 python3，pi-session-analyzer 可执行
- **Git:** 测试目标文件应在 git 仓库中（验证 commit 行为）
