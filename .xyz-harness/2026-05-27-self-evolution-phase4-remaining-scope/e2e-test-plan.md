---
verdict: pass
---

# E2E Test Plan — Self-Evolution Phase 4

## Test Scenarios

### Scenario 1: Analyzer CLI 接口验证
- **AC:** D4.1
- **前置条件:** `~/.pi/agent/scripts/pi-session-analyzer/analyze.py` 存在，`~/.pi/agent/evolution-data/daily/` 下有至少 1 天数据
- **步骤:**
  1. `python3 ~/.pi/agent/scripts/pi-session-analyzer/analyze.py --since 7d --format json --output /tmp/test-report.json`
  2. 解析输出 JSON，验证顶层键包含 `tool_stats`, `token_stats`, `skill_stats`
  3. 验证 `tool_stats.total_calls` 是数字 ≥ 0
- **预期:** 报告生成成功，schema 与 `judge.ts` 的 `extractReportSubset` 引用的键一致

### Scenario 2: Judge 模板渲染
- **AC:** D4.1, D3.3
- **前置条件:** Scenario 1 通过，报告文件存在
- **步骤:**
  1. 调用 `buildJudgeInput(report, "claude-md", tmpDir)` 
  2. 验证返回的 `reportPath` 文件存在且非空
  3. 验证 `promptFilePath` 文件存在且包含信号数据
- **预期:** 临时文件正确生成，target 映射到正确模板

### Scenario 3: merge-reviewer Target 支持
- **AC:** merge-reviewer 模板
- **前置条件:** Task 2 完成
- **步骤:**
  1. 调用 `buildJudgeInput(report, "merge-reviewer", tmpDir)`
  2. 验证不抛错
  3. 验证 `TARGET_TEMPLATE["merge-reviewer"]` === `"merge-reviewer.txt"`
  4. 验证模板文件 `templates/merge-reviewer.txt` 存在
- **预期:** 新 target 类型正常工作

### Scenario 4: Apply + Rollback 完整流程
- **AC:** D4.4
- **前置条件:** 有 pending suggestion（含合法 diff），目标文件在白名单路径下
- **步骤:**
  1. 创建临时 `.md` 文件在 `~/.pi/agent/` 下
  2. 构造 suggestion（targetPath 指向临时文件，diff 修改一行内容）
  3. 调用 `applySuggestion(suggestion, backupDir)`
  4. 验证 `result.success === true`
  5. 验证文件内容已变更
  6. 验证备份文件存在
  7. 调用 `rollbackSuggestion(historyEntry)`
  8. 验证文件内容恢复原始
- **预期:** Apply 修改文件，Rollback 恢复文件

### Scenario 5: 路径白名单安全
- **AC:** D4.4
- **前置条件:** 无
- **步骤:**
  1. 构造 suggestion（targetPath = `/etc/passwd`）
  2. 调用 `applySuggestion(suggestion, backupDir)`
  3. 验证 `result.success === false`
  4. 验证 `result.reason` 包含 "not allowed"
- **预期:** 非白名单路径被拒绝

### Scenario 6: 自动触发规则（已有数据验证）
- **AC:** P5.5 (verify existing)
- **前置条件:** `evolution-data/daily/` 下有 14 天数据，`skill-triggers.json` 存在
- **步骤:**
  1. 准备 healthy 数据（均匀 token 消耗、活跃 skills、低错误率）
  2. 调用 `checkAutoTriggerRules(evolutionDir)`
  3. 验证返回空数组
  4. 准备 decline 数据（最近 3 天 token/session 远高于基线）
  5. 调用 `checkAutoTriggerRules(evolutionDir)`
  6. 验证返回包含 `token-decline` flag
- **预期:** 健康数据无 flag，异常数据触发 flag

### Scenario 7: D3.3 建议质量门控
- **AC:** D3.3
- **前置条件:** 有真实 session 数据，analyzer 可运行
- **步骤:**
  1. 运行 analyzer 生成报告
  2. 使用 3 个模板分别运行 Judge（session-quality, prompt-optimize, skill-health）
  3. 对每个 Judge 输出评分（格式、字段、置信度、可操作性、相关性）
  4. 综合分 ≥ 7/10
- **预期:** 3 个模板的输出质量均达到门控标准

## Test Environment

- **OS:** macOS (development machine)
- **Node.js:** v24.x（支持 `--experimental-strip-types`）
- **Python:** 3.x（analyzer 运行时）
- **Pi:** xyz-pi 全局安装，`pi --mode json` 可用
- **数据:** `~/.pi/agent/evolution-data/` 下至少 7 天的 daily JSON + `skill-triggers.json`
- **Extension 安装:** `evolution-engine` 通过 symlink 安装到 `~/.pi/agent/extensions/`
