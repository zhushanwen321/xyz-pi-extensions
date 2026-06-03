# evolve-daily

每日进化数据采集器 — 每天首次 session 自动运行 Python 分析器，生成使用报告。

## 功能

- **自动采集**：每天首次启动 Pi 时自动运行 `analyze.py` 分析 session 数据
- **JSON 报告**：输出到 `~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json`
- **配套 skills**：内置 `/evolve`、`/evolve-apply`、`/evolve-report` 三个 skill

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/evolve-daily \
      ~/.pi/agent/extensions/evolve-daily

# npm 方式（正式）
pi install npm:@zhushanwen/pi-evolve-daily
```

## 使用

安装后自动生效，无需手动操作。

| Skill | 说明 |
|-------|------|
| `/evolve` | 分析使用模式，生成进化建议 |
| `/evolve-apply` | 应用/跳过/回滚进化建议 |
| `/evolve-report` | 查看每日报告和使用统计 |

## 依赖

- Python 3 + `analyze.py`（位于 `~/.pi/agent/scripts/pi-session-analyzer/`）

## 文件结构

```
evolve-daily/
├── index.ts
├── src/
│   └── index.ts    # 入口 — session_start 事件中触发分析
└── skills/
    ├── evolve/
    ├── evolve-apply/
    └── evolve-report/
```
