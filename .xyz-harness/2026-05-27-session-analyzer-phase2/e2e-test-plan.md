---
verdict: pass
---

# E2E Test Plan — session-analyzer-phase2

## Test Scenarios

### TS-1: CLI 基本功能验证 (AC-1)
- 执行 `python3 analyze.py --since 7d`，验证 stdout 输出 Markdown 报告
- 执行 `python3 analyze.py --since 7d --format json`，验证输出有效 JSON
- 执行 `python3 analyze.py --since 7d --output /tmp/report.md`，验证文件创建且非空
- 执行 `python3 analyze.py --sample 20 --since 30d`，验证抽样模式正常

### TS-2: 报告内容完整性 (AC-2)
- Markdown 报告包含 8 个 `##` 级章节标题
- JSON 报告包含 7 个 extractor 输出 + miner 聚合结果
- 无 None/NaN 值出现在最终输出中

### TS-3: Top-N 问题有效性 (AC-3)
- 全量分析报告的 Top-N 章节包含 >= 3 个问题
- 每个问题包含 description、impact_sessions、severity、suggestion
- 问题按 severity 降序排列

### TS-4: Skill 健康度有效性 (AC-4)
- 报告中列出所有已安装 skill
- 至少 3 个 skill 标记为 DORMANT
- 每个判定附带 triggers/file_size 支撑数据

### TS-5: 性能基准 (AC-5)
- `time python3 analyze.py --since 365d --format json` 执行时间 < 120s

### TS-6: 回顾性报告产出 (AC-6)
- `~/.pi/agent/evolution-data/reports/` 下存在 retrospective-*.md 文件
- 报告包含至少 3 个可操作洞察

### TS-7: Cron 配置 (AC-7)
- `crontab -l` 输出包含 pi-session-analyzer 条目
- cron 命令路径和参数正确

## Test Environment
- 本地 macOS 开发机
- 需要有 `~/.pi/agent/sessions/` 目录且包含 JSONL 文件
- Python 3.10+ 可用
- 无需额外依赖安装
