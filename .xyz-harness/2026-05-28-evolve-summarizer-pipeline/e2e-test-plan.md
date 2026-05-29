---
verdict: pass
---

# E2E Test Plan — Evolve Summarizer Pipeline

## Test Scenarios

### TS-1: Signal Summarizer 压缩验证 (AC-1)
**Objective:** 745KB 原始报告经 summarizer 后产物 <= 10KB

**Steps:**
1. 读取 `~/.pi/agent/evolution-data/reports/retrospective-2026-05-27.json`（745KB 原始报告）
2. 调用 `summarizeReport(report, [])` 获取 SignalReport
3. 序列化为 JSON，检查 size <= 10240 bytes
4. 验证 compressed 字段包含 top-N 截断后的数据
5. 验证 anomalies 数组包含预期的异常检测项

### TS-2: Metrics History 滑动窗口 (AC-3)
**Objective:** metrics-history.json 最多保留 30 条

**Steps:**
1. 创建空的 metrics-history.json
2. 连续写入 31 个 MetricsSnapshot
3. 调用 `loadMetricsHistory()` 读取
4. 验证返回 30 条（最老一条被删除）
5. 验证保留的是最新的 30 条

### TS-3: 趋势计算 (AC-4)
**Objective:** 只有 ±20% 以上的变化才写入趋势

**Steps:**
1. 构造 previous snapshot（bashFailureRate=0.10, editRetryRate=0.09, totalToolCalls=500）
2. 构造 current snapshot（bashFailureRate=0.08, editRetryRate=0.12, totalToolCalls=510）
3. 调用 `computeTrends(current, previous)`
4. 验证 trends 包含 editRetryRate（+33%，超过阈值）
5. 验证 trends 不包含 totalToolCalls（+2%，未超过阈值）

### TS-4: Effect Review (AC-5)
**Objective:** Apply 后下次 evolve 能看到效果数据

**Steps:**
1. 构造 history: 1 条 apply 记录（3 天前），`metricsSnapshotDate` = 4 天前
2. 构造 metricsHistory: 3 个 snapshot（5 天前、2 天前、今天）
3. 调用 `buildEffectReview(history, metricsHistory)`
4. 验证返回 1 条 EffectReview
5. 验证 before/after 值来自正确的 snapshot

### TS-5: Data GC (AC-6)
**Objective:** reports 保留 <= 3, signals 保留 <= 30, daily 保留 <= 90 天

**Steps:**
1. 创建 reports/ 目录，放入 5 个 JSON 文件
2. 调用 `runGc(evolutionDir)`
3. 验证 reports/ 只剩 3 个文件（最新的保留）
4. 验证返回 GcResult.reportsRemoved = 2

### TS-6: Judge stdin 传输 (AC-7)
**Objective:** Judge 通过 stdin 接收 prompt

**Steps:**
1. 创建一个小的 signal JSON 文件（< 1KB）
2. 构造 JudgeInput 指向该文件
3. 调用 `runJudge(input, templateDir)`
4. 验证 pi 子进程被 spawn 且 stdin 是 pipe（通过 spawn 参数检查）
5. 验证返回结果不为空（或正常重试后返回）

### TS-7: End-to-End Evolve Flow (AC-2)
**Objective:** /evolve 完整流程不再报 "Empty Judge output"

**Steps:**
1. 确保存在一份原始报告（或 mock analyzer 产出）
2. 调用 `handleEvolve({ target: "all", since: "7d", sample: undefined }, dirs)`
3. 验证不抛出 "Empty Judge output" 错误
4. 验证 pending.json 被正确生成
5. 验证 signals/ 目录下生成了 signal JSON

## Test Environment

- **Runtime:** Node.js (Pi extension process)
- **Data:** 使用现有的 `~/.pi/agent/evolution-data/` 下的真实数据
- **Mocking:** Judge 子进程调用需要 mock（pi 可能不可用），其余模块可用真实数据测试
- **Type checking:** `npx tsc --noEmit` 必须通过
- **Linting:** `npm run lint` 必须 0 error
