---
verdict: pass
---

# Use Cases — Evolve Daily Report

## UC-1: 每日自动生成分析报告

- **Actor:** Pi Agent 系统（session_start 事件触发）
- **Preconditions:**
  - Pi 进程启动，session 开始
  - `~/.pi/agent/evolution-data/` 目录存在
  - Python analyzer 脚本已安装
- **Main Flow:**
  1. session_start 事件触发 `checkAndRunDailyAnalysis`
  2. 计算 UTC 日期 YYYY-MM-DD
  3. 检查 `daily-reports/YYYY-MM-DD.md` 是否存在且非空
  4. 若已存在 → 结束（AC-2）
  5. 获取 lock 文件（AC-8a）
  6. 运行 Python analyzer（`--since 1d`）
  7. 运行 summarizer → 信号摘要
  8. 运行 LLM Judge → 建议列表
  9. 生成 Markdown 报告（AC-3）
  10. 写入临时文件 → rename 为最终文件（原子操作）
  11. 合并建议到 pending.json（title 去重 + 容量保护）（AC-4, AC-7, AC-8b）
  12. 写入 `.last-run-status`（success）
  13. 释放 lock
- **Alternative Paths:**
  - **Lock 被占用（PID 存活）:** 跳过本次执行，不等待
  - **Stale lock（PID 已死）:** 清理 stale lock，继续执行
  - **Analyzer 脚本不存在:** 记录错误到 `.last-run-status`，不阻塞 session（AC-8）
  - **Judge 失败:** 同上
  - **0 session 日:** 仍然生成报告，各章节显示"无数据"
- **Postconditions:**
  - `daily-reports/YYYY-MM-DD.md` 存在且非空
  - `pending.json` 包含新建议（去重后）
  - `.last-run-status` 记录成功状态
- **Module Boundaries:** daily-trigger.ts → (summarizer.ts, judge.ts, state.ts, report-generator.ts, gc.ts)

**AC 覆盖:** AC-1, AC-2, AC-3, AC-4, AC-7, AC-8, AC-8a, AC-8b

---

## UC-2: 查看每日分析报告

- **Actor:** Pi Agent 用户（通过 AI 助手调用）
- **Preconditions:**
  - 至少一份每日报告存在
- **Main Flow:**
  1. 用户执行 `/evolve-report`（无参数）
  2. 系统计算今天的 UTC 日期
  3. 读取 `daily-reports/YYYY-MM-DD.md`
  4. 文件存在 → 展示 Markdown 内容（AC-5）
- **Alternative Paths:**
  - **报告不存在:** 检查 `.last-run-status`，展示"今天的报告尚未生成" + 错误摘要
  - **报告文件为空/损坏:** 展示"报告文件损坏"
- **Postconditions:** 用户看到报告内容
- **Module Boundaries:** commands.ts (handleEvolveReport) → state.ts (read)

**AC 覆盖:** AC-5

---

## UC-3: 查看指定日期的分析报告

- **Actor:** Pi Agent 用户
- **Preconditions:** 无
- **Main Flow:**
  1. 用户执行 `/evolve-report 2026-05-28`
  2. 系统读取 `daily-reports/2026-05-28.md`
  3. 文件存在 → 展示内容（AC-5）
- **Alternative Paths:**
  - **文件不存在:** 返回"2026-05-28 的报告不存在"
- **Postconditions:** 用户看到指定日期的报告
- **Module Boundaries:** commands.ts (handleEvolveReport) → fs

**AC 覆盖:** AC-5

---

## UC-4: 列出所有可用报告

- **Actor:** Pi Agent 用户
- **Preconditions:** 无
- **Main Flow:**
  1. 用户执行 `/evolve-report --list`
  2. 系统扫描 `daily-reports/` 目录
  3. 按 `.md` 文件名降序排列，取最近 10 条
  4. 读取 `.last-run-status` 获取最后运行状态
  5. 检查今天是否已生成、过去 7 天缺失日期
  6. 格式化输出列表（AC-6）
- **Alternative Paths:**
  - **无报告:** 返回"尚未生成任何报告"
  - **`.last-run-status` 不存在:** 省略状态信息
- **Postconditions:** 用户看到报告列表、今日状态、缺失日期
- **Module Boundaries:** commands.ts (handleEvolveReport) → state.ts (read)

**AC 覆盖:** AC-6

---

## UC-5: 手动查看建议后决定执行

- **Actor:** Pi Agent 用户
- **Preconditions:**
  - 每日报告已生成
  - `pending.json` 包含 pending 建议
- **Main Flow:**
  1. 用户阅读每日报告中的改进建议
  2. 用户决定执行建议 #0
  3. 用户告诉 AI "执行报告里的建议 #0"
  4. AI 调用 `evolve-apply action=apply index=0`
  5. 系统执行 apply 流程（与现有 /evolve-apply 行为一致）
- **Alternative Paths:**
  - **用户用 /evolve-apply:** 走现有交互流程
  - **无 pending 建议:** 返回"无可执行建议"
- **Postconditions:** 建议被 apply 或 skip
- **Module Boundaries:** 沿用现有 evolve-apply 流程（applier.ts, state.ts）

**AC 覆盖:** AC-4（pending.json 与报告一致）, AC-11（现有流程不变）

---

## UC-6: GC 清理旧报告

- **Actor:** Pi Agent 系统（随每日分析自动触发）
- **Preconditions:**
  - `daily-reports/` 目录存在
- **Main Flow:**
  1. 每日分析完成后，`runGc` 被调用
  2. 扫描 `daily-reports/*.md` 文件
  3. 删除超过 30 天的文件
  4. 返回删除数量（AC-9）
- **Alternative Paths:**
  - **目录为空:** 返回 0
- **Postconditions:** 只保留最近 30 天的报告
- **Module Boundaries:** gc.ts (runGc)

**AC 覆盖:** AC-9

---

## UC-AC 覆盖映射表

| UC | 覆盖的 AC |
|----|-----------|
| UC-1 | AC-1, AC-2, AC-3, AC-4, AC-7, AC-8, AC-8a, AC-8b |
| UC-2 | AC-5 |
| UC-3 | AC-5 |
| UC-4 | AC-6 |
| UC-5 | AC-4, AC-11 |
| UC-6 | AC-9 |
| (所有 Task) | AC-10, AC-11 |
