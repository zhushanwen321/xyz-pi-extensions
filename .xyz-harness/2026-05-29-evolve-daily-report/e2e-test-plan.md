---
verdict: pass
---

# E2E Test Plan — Evolve Daily Report

## Test Scenarios

### TS-1: 首次启动自动生成报告
- **覆盖 AC:** AC-1, AC-3
- **前置条件:** `daily-reports/` 目录为空，`daily/YYYY-MM-DD.json` 中有最近 1 天的 usage 数据
- **步骤:**
  1. 启动 Pi session
  2. 等待每日分析完成（fire-and-forget，需要等待 ~60s）
  3. 检查 `daily-reports/YYYY-MM-DD.md` 是否存在
  4. 验证报告包含"数据概览"、"异常信号"、"趋势变化"、"改进建议"章节
  5. 验证报告中的建议与 `pending.json` 中的建议一致
- **预期:** 报告生成，pending.json 更新

### TS-2: 同一天不重复生成
- **覆盖 AC:** AC-2
- **前置条件:** `daily-reports/YYYY-MM-DD.md` 已存在且非空
- **步骤:**
  1. 启动新的 Pi session
  2. 检查 analyzer 是否被调用（不应被调用）
- **预期:** 不重复运行 pipeline

### TS-3: /evolve-report 查看今天的报告
- **覆盖 AC:** AC-5
- **前置条件:** 今天的报告已生成
- **步骤:**
  1. 执行 `/evolve-report`
  2. 验证返回的 Markdown 内容与文件内容一致
- **预期:** 显示今天的报告

### TS-4: /evolve-report --list 列出报告
- **覆盖 AC:** AC-6
- **前置条件:** 多天的报告存在
- **步骤:**
  1. 执行 `/evolve-report --list`
  2. 验证输出包含报告列表（按日期降序）
  3. 验证显示最后运行状态
  4. 验证显示今天是否已生成
- **预期:** 列表格式正确，信息完整

### TS-5: Pending 增量合并（去重）
- **覆盖 AC:** AC-7, AC-8b
- **前置条件:** `pending.json` 中有一条 pending 建议（title: "减少 bash 失败率"）
- **步骤:**
  1. 运行每日分析，Judge 返回包含相同 title 的建议
  2. 检查 pending.json 中是否只有一条该 title 的建议
  3. 检查原有建议的 status 仍为 "pending"
- **预期:** 不重复追加

### TS-6: 并发 session_start 不重复执行
- **覆盖 AC:** AC-8a
- **前置条件:** 报告不存在，lock 文件不存在
- **步骤:**
  1. 同时启动两个 Pi session
  2. 检查 lock 文件只有一个被写入
  3. 检查只有一个 session 运行了 pipeline
- **预期:** 只生成一份报告

### TS-7: 分析失败不阻塞
- **覆盖 AC:** AC-8
- **前置条件:** Python analyzer 脚本不存在
- **步骤:**
  1. 启动 Pi session
  2. 验证 session 正常启动（不阻塞）
  3. 检查 `.last-run-status` 文件记录了失败信息
- **预期:** session 正常，失败被记录

### TS-8: GC 清理旧报告
- **覆盖 AC:** AC-9
- **前置条件:** `daily-reports/` 中有 35 天前的报告
- **步骤:**
  1. 触发 runGc
  2. 检查 35 天前的报告被删除
  3. 检查 30 天内的报告保留
- **预期:** 旧报告被清理

### TS-9: 现有命令不受影响
- **覆盖 AC:** AC-11
- **前置条件:** 无
- **步骤:**
  1. 执行 `/evolve since=7d`
  2. 执行 `/evolve-apply action=list`
  3. 执行 `/evolve-stats`
  4. 执行 `/evolve-rollback`
  5. 验证所有命令行为与修改前一致
- **预期:** 所有命令正常工作

## Test Environment

- **运行环境:** macOS, Node.js v24+, Pi agent 进程
- **前置安装:** pi-session-analyzer 脚本, Python 3
- **数据准备:** `~/.pi/agent/evolution-data/daily/` 中需要至少 1 天的 usage 数据文件
- **类型检查:** `cd evolution-engine && npx tsc --noEmit`
- **Lint 检查:** `cd xyz-pi-extensions && npm run lint`
