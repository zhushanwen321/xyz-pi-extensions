---
verdict: pass
must_fix: 0
review:
  type: integration_review
  round: 1
  timestamp: "2026-05-28T16:00:00"
  target_changeset: "v2 (summarizer + effect-tracker + gc integration)"
  summary: "集成审查：模块接口正确对接，类型传递一致，信号路径统一，GC 时序安全。发现 4 项非阻塞问题，其中 buildJudgeInput 残留与 BLR v2 声称的'已清理'存在差异。"

issues:
  - id: I-1
    severity: LOW
    location: "judge.ts:buildJudgeInput"
    title: "buildJudgeInput 生产死代码但被测试引用"
    description: |
      BLR v2（Issue #4）声称 buildJudgeInput 已在 V2 中删除，但当前 judge.ts 仍完整保留该函数（export）。
      commands.ts 已不再 import 它（仅 import runJudge），生产流水线中 JudgeInput 在 step 3e 内联构造。
      但 evolution-engine/tests/integration.test.mts 仍 import 并测试该函数。
      
      状态：函数在线上是死代码，因测试引用而残留。测试覆盖的是旧 pipeline 行为（raw report 子集写入 tmpDir），
      与新 pipeline（signal 文件 inline JudgeInput）不相关。后续清理时需同步更新测试。

  - id: I-2
    severity: LOW
    location: "commands.ts:handleEvolve / handleEvolveApply / handleEvolveRollback / handleEvolveStats"
    title: "外层 try-catch 包裹降低错误可诊断性"
    description: |
      全部四个 handler 的函数体被 try-catch 包裹，所有错误统一包装为：
      - "Unexpected error in /evolve: ..."
      - "Unexpected error in /evolve-apply: ..."
      - "Unexpected error in /evolve-rollback: ..."
      - "Failed to read stats: ..."（handleEvolveStats 前缀与其他不一致）
      
      各步骤本身已抛出带详细信息的 Error（如 "Session analyzer not found at ..."、
      "Failed to read report: JSON parse error at ..."、"LLM Judge timed out after 120s"），
      外层包装不增加诊断价值。导致：
      a) 上层无法通过 err.message 区分预期错误类型
      b) 调试需手动剥离前缀
      c) handleEvolveStats 使用不同前缀（"Failed to read stats" 而非
         "Unexpected error in /evolve-stats"），风格不统一

  - id: I-3
    severity: INFO
    location: "effect-tracker.ts:KEYWORD_TO_METRIC"
    title: "Token 关键词匹配次序问题（BLR v2 LOW #2 未修复）"
    description: |
      keywords: ["token", "input", "输入"] → field: totalInputTokens
      keywords: ["token", "output", "输出"] → field: totalOutputTokens
      
      对于英文 title "Reduce output token usage"：
      严格匹配（every）两轮均失败 → 宽松匹配（some）"token" 命中第一个映射 → 误匹配到 totalInputTokens。
      
      修复：将 input/output 提到数组首位，使严格匹配阶段即可区分。
      已在 BLR v2 中记录为非阻塞 LOW 问题，当前未修复。

  - id: I-4
    severity: INFO
    location: "summarizer.ts:summarizeReport"
    title: "summarizeReport 部分失败的偶发不一致"
    description: |
      saveMetricsSnapshot(evolutionDir, snapshot) 在 writeFileSync(signalPath, ...) 之前执行。
      如果 writeFileSync 失败（如磁盘满），metrics-history.json 已包含新 snapshot 但 signals/ 缺少对应信号文件。
      
      下次 /evolve 运行会：
      - loadMetricsHistory 返回含该 snapshot 的历史（含无对应信号文件的孤立 snapshot）
      - loadHistory(30) 正常
      - buildEffectReview 仍能找到该 snapshot 作为 before/after 数据
      - summarizeReport 生成新信号文件，但旧孤立 snapshot 留在 metrics-history.json 中
      
      影响：仅造成 metrics-history.json 中有少量无对应信号文件的 snapshot，
      不影响核心数据正确性。可接受但值得记录。

---

# Integration Review — Round 1

## 审查信息

- **审查类型**: 集成审查
- **审查范围**: summarizer.ts → state.ts → judge.ts → commands.ts 流水线
- **审查依据**: 源文件完整阅读 + BLR v2 报告 + 测试引用检查
- **审查目标**: 验证模块接口正确对接、类型传递一致、路径统一、GC 时序安全、错误传播合理

---

## 一、模块间接口对接

### 1.1 summarizer → state

| 接口 | 方向 | 正确性 |
|------|------|--------|
| `saveMetricsSnapshot(evolutionDir, snapshot)` | summarizer → state.ts | ✅ `summarizeReport` step 7 调用，写入 metrics-history.json |
| `loadMetricsHistory(evolutionDir)` | state.ts → commands.ts | ✅ commands.ts step 3a 调用，获取历史快照数组 |

`saveMetricsSnapshot` 内部自行 `loadMetricsHistory` + `push` + 滑动窗口裁剪（MAX=30），不修改传入的 `metricsHistory` 引用。这是正确的行为——commands.ts 在 step 3b-2 手动 `push` 返回值到自己的局部副本。

### 1.2 summarizer → commands

| 接口 | 正确性 |
|------|--------|
| `summarizeReport(report, metricsHistory, evolutionDir, reportPath) → SignalReport` | ✅ |
| `SignalReport.metricsSnapshot: MetricsSnapshot` | ✅ commands.ts step 3b-2 将其 push 入 metricsHistory |

信号文件路径统一使用 `join(evolutionDir, "signals", "signal-${date}.json")`，与 commands.ts 的 `dirs.signalsDir` 等价指向同一目录。

### 1.3 commands → effect-tracker

| 接口 | 正确性 |
|------|--------|
| `buildEffectReview(recentHistory, metricsHistory) → EffectReview[]` | ✅ |
| `loadHistory(evolutionDir, 30)` 获取 recentHistory | ✅ |
| metricsHistory 在传入前已包含新 snapshot（step 3b-2 push） | ✅ |

`findLatestSnapshot(metricsHistory)` 返回最新 snapshot（含当前轮的 T2），
`findSnapshotBefore(metricsHistory, applyDate)` 返回 apply 时刻的快照（T0/T1）。
changePercent = (T2 - before) / before，语义正确。

`effectReview` 非空时回写信号文件：
```
writeFileSync(effectSignalPath, ...)
```
同一文件被回写，覆盖 step 3b 的初版。路径一致。

### 1.4 commands → judge

| 接口 | 正确性 |
|------|--------|
| 内联构造 `JudgeInput { target, reportPath: signalPath, promptFilePath: "" }` | ✅ |
| `runJudge(judgeInput, dirs.templateDir) → EvolutionSuggestion[]` | ✅ |
| `runJudge` 内部读 `input.reportPath`（信号文件），不再读原始报告 | ✅ |

### 1.5 commands → state

| 接口 | 正确性 |
|------|--------|
| `loadPending(evolutionDir) → PendingFile | null` | ✅ |
| `savePending(evolutionDir, pending)` | ✅ |
| `appendHistory(evolutionDir, entry)` | ✅ |
| `loadMetricsHistory(evolutionDir) → MetricsSnapshot[]` | ✅ |
| `loadHistory(evolutionDir, 30) → HistoryEntry[]` | ✅ |

---

## 二、signalsDir 可用性

`Dirs.signalsDir` 定义为 `join(evolutionDir, "signals")`，在 `index.ts:makeDirs()` 创建并注入：

| 使用者 | 使用方式 | 一致性 |
|--------|----------|--------|
| commands.ts | `join(dirs.signalsDir, "signal-${date}.json")` | ✅ 通过 Dirs 获取 |
| summarizer.ts | `join(evolutionDir, "signals", "signal-${date}.json")` | ✅ 等价路径，因不持有 Dirs，传参 evolutionDir |
| gc.ts | `join(evolutionDir, "signals")` | ✅ 同样的等价路径 |

**结论**: `signalsDir` 在所有需要的地方可用。summarizer 和 gc 不持有 `Dirs` 对象，但通过传参 `evolutionDir` 构造等价路径，与 `Dirs.signalsDir` 完全一致。

---

## 三、MetricsSnapshot 类型传递一致性

`MetricsSnapshot` 类型在 `types.ts` 定义，通过 import 在各模块间传递：

```
types.ts: MetricsSnapshot (interface)
  ↑ import                    ↑ import                    ↑ import
state.ts ────────────────── summarizer.ts ────────────── effect-tracker.ts
loadMetricsHistory() → [ ]   extractMetricsSnapshot() → 1  buildEffectReview(_, [ ])
saveMetricsSnapshot(1)       computeTrends(1, 1)         findSnapshotBefore([ ], date)
                             summarizeReport() → SignalReport  findLatestSnapshot([ ])
                                  ↑
                              commands.ts
                              metricsHistory: MetricsSnapshot[]
                              metricsHistory.push(signalReport.metricsSnapshot)
```

**字段一致性**: 所有函数签名使用同一 `MetricsSnapshot` 类型。summarizer.ts 的 `COMPARABLE_FIELDS` 中引用的 `keyof MetricsSnapshot` 与 effect-tracker.ts 的 `KEYWORD_TO_METRIC` 中标注的 `field: keyof MetricsSnapshot` 一致。✅

**注意**: effect-tracker.ts 的 `KEYWORD_TO_METRIC` 中 `field` 类型标注为 `keyof MetricsSnapshot`，
但 `buildEffectReview` 中的 `latest[field]` 取值时仍用 `as number` 断言。如果未来 `MetricsSnapshot` 增加非 number 字段，
这个断言可能通过但运行时返回 `undefined`。这是一个前瞻性风险，当前不造成问题。

---

## 四、信号文件路径一致性

所有信号文件读写均使用 `signal-${date}.json` 命名：

| 位置 | 路径构造 | 一致性 |
|------|----------|--------|
| summarizer.ts step 8: 写入初版 | `join(evolutionDir, "signals", "signal-${snapshot.date}.json")` | ✅ |
| commands.ts step 3c: 回写 effectReview | `join(dirs.signalsDir, "signal-${signalReport.metricsSnapshot.date}.json")` | ✅ |
| commands.ts step 3e: Judge input | `join(dirs.signalsDir, "signal-${signalReport.metricsSnapshot.date}.json")` | ✅ |

三处使用 `snapshot.date`（MetricsSnapshot.date 字段）作为文件名中的日期标识，值来自 `report._meta.analysis_period.until`。一致性通过同一 `signalReport.metricsSnapshot.date` 值保证。✅

GC 清理信号文件时通过 `listJsonByMtime`（按修改时间排序）决定保留/删除，不涉及文件名解析，与路径一致性问题无关。

---

## 五、GC 时序安全分析

**关键问题**: GC（step 3d）在 Judge 读取信号文件（step 4）之前运行。GC 会误删当前轮刚写入的信号文件吗？

**分析**:

```
时序线:
step 3b: writeFileSync(signalPath, ...)            ← 写入新信号文件
step 3c: writeFileSync(effectSignalPath, ...)       ← 可能回写，mtime 更新
step 3d: runGc(evolutionDir)
         → listJsonByMtime(signalsDir)             ← 按 mtime 降序
         → slice(MAX_SIGNALS=30)                    ← 删除末尾（最旧）文件
step 3e: readFileSync(signalPath, ...)              ← 读信号文件
step 4:  runJudge(judgeInput, ...)                  ← 子进程读信号文件
```

**保障条件**:

1. 当前信号文件是 steps 3b/3c 刚刚写入的，mtime 为最新
2. `listJsonByMtime` 降序排列 → 当前文件在索引 0
3. `slice(30)` 从索引 30 开始截断 → 只删除最旧的超出部分
4. 即使积累 60 个信号文件（无 GC 运行 60 天），当前文件仍在保留范围内

**竞态条件**: 所有文件操作为同步（writeFileSync/unlinkSync/readFileSync），无异步时序窗口。✅

**结论**: GC 不会误删当前信号文件，时序安全。✅

---

## 六、buildJudgeInput 状态分析

### 当前状态

- `judge.ts` 中 `buildJudgeInput` 函数完整存在并 export
- `commands.ts` 的 import 只包含 `{ runJudge }`，无 `buildJudgeInput`
- 生产流水线在 commands.ts step 3e 内联构造 JudgeInput（使用信号文件路径）
- `evolution-engine/tests/integration.test.mts` 中 import 并测试 `buildJudgeInput`
- 测试行 403-424：`buildJudgeInput` 将原始报告子集写入 tmpDir 并返回 JudgeInput

### 与 BLR v2 的差异

BLR v2 Issue #4 声称 `buildJudgeInput` 已在 V2 中删除（"V2 的 judge.ts diff 显示 buildJudgeInput 已被移除"）。
**但实际上该函数仍完整存在于当前 judge.ts 中。** 可能的解释：

1. BLR v2 审查的 diff 与实际合并的 changeset 不同步
2. 清理仅修改了 commands.ts 的 import，未删除函数本体

### 影响评估

- 生产代码：无影响（不调用该函数）
- 测试代码：测试仍覆盖该函数，但测试的函数行为与当前生产流水线无关（旧 pipeline 行为）
- 维护成本：若后续重构 judge.ts，测试可能阻碍清理

### 建议

- 删除 `buildJudgeInput` 函数，同时更新测试为新的 signal-file-based JudgeInput 验证
- 或保留并在函数上方标注 `@deprecated`

---

## 七、错误传播链

### 7.1 正常路径

```
summarizer: extractMetricsSnapshot → detectAnomalies → computeTrends
  → compressReport → saveMetricsSnapshot → writeFileSync(signal)
  → 返回 SignalReport ✅

commands:  接 SignalReport → push snapshot → buildEffectReview
  → 回写信号文件 → runGc → runJudge → savePending
  → 返回 CommandResult { content, details } ✅

pi framework: 将 CommandResult 组装为 tool 执行结果
  → renderResult 从 details 获取渲染数据 ✅
```

### 7.2 错误路径

```
summarizer 失败 (writeFileSync/saveMetricsSnapshot 抛错)
  → 未被单独 catch
  → 冒泡到 commands.ts handleEvolve 的 catch 块
  → 包装为 "Unexpected error in /evolve: <原始错误>"
  → tool execute 抛出，Pi 框架捕获
  → 用户看到 "Error: Unexpected error in /evolve: ..."
```

### 7.3 外包装评估

外层 catch 在所有四个 handler 中使用：

| Handler | 错误前缀 | 与其他一致？ |
|---------|---------|-------------|
| handleEvolve | `"Unexpected error in /evolve: "` | 基准 |
| handleEvolveApply | `"Unexpected error in /evolve-apply: "` | ✅ |
| handleEvolveRollback | `"Unexpected error in /evolve-rollback: "` | ✅ |
| handleEvolveStats | `"Failed to read stats: "` | ❌ 前缀不同 |

内部 throw 的 Error 格式：
- `"Session analyzer not found at ..."` — 预期错误，用户只需知道未安装
- `"Failed to run session analyzer: ..."` — 包含 subprocess stderr
- `"Failed to read report: ..."` — 含 JSON parse 错误位置
- `"LLM Judge failed: ..."` — 含子进程返回码
- `"LLM Judge returned empty output after 2 attempts..."` — 含保存的诊断路径

外层包装后，上述具体信息被拼接到 `"Unexpected error in /evolve: "` 后面，信息未丢失但：
- 外层调用方（如 /evolve command handler）无法通过 `err.message.startsWith("Session analyzer")` 区分错误类型
- handleEvolveStats 使用不同前缀，风格不一致

### 7.4 部分失败场景

**场景: writeFileSync 信号文件失败**

```
saveMetricsSnapshot(evolutionDir, snapshot)  → 成功（写入 metrics-history.json）
writeFileSync(signalPath, ...)                → 失败（抛异常）
↓
下次 /evolve 加载: metricsHistory 包含该孤立 snapshot
buildEffectReview 使用该孤立 snapshot 作为 before/after 数据（功能正常）
signal 文件由下次 summarizeReport 重新生成
```

影响：metrics-history.json 中产生无法通过信号文件回溯的孤立 snapshot。非严重问题。

---

## 八、综合结论

### 集成正确性

| 维度 | 状态 | 说明 |
|------|------|------|
| 模块接口 | ✅ | summarizer → state → commands → effect-tracker → judge 数据流完整 |
| signalsDir 可用 | ✅ | 所有消费方通过 Dirs 或 evolutionDir 参数等价访问 |
| 类型传递 | ✅ | MetricsSnapshot 类型在四模块间一致传递 |
| 信号路径 | ✅ | signal-{date}.json 命名一致，commands.ts 与 summarizer.ts 路径等价 |
| GC 时序 | ✅ | 当前信号文件始终为最新，不会被 GC 误删 |
| error propagation | ⚠️ | 功能正确但诊断性降低，见 I-2 |

### 问题汇总

| # | 标题 | 严重度 | 影响 | 
|---|------|--------|------|
| I-1 | buildJudgeInput 生产死代码 | LOW | 清理时需移除，测试需更新 |
| I-2 | 外层 try-catch 降低诊断性 | LOW | 影响错误分类和调试效率 |
| I-3 | Token 关键词匹配次序 | INFO | 英文 title 可能误匹配（已有 BLR v2 LOW #2 记录）|
| I-4 | summarizeReport 部分失败不一致 | INFO | 产生孤立 snapshot，不影响数据正确性 |

### 最终裁定

**verdict: pass**
**must_fix: 0**

无阻塞性集成问题。I-1（buildJudgeInput 残留）和 I-2（错误包装）建议在后续清理阶段修复。
I-3（关键词匹配）和 I-4（部分失败）为可接受的已知限制。

**修复优先级建议**:
1. I-1 — 删除 `buildJudgeInput` 并更新测试（代码整洁度，与 BLR v2 对齐）
2. I-2 — 移除外层 try-catch 或统一错误前缀（调试体验）
3. I-3 — 关键词语序调整（简单修复，高收益）
4. I-4 — 监控但无需立即修复（罕见场景）

### 与 BLR v2 的比较

| BLR v2 问题 | 集成审查中的状态 | 说明 |
|-------------|----------------|------|
| #1 滞后一轮 (MUST_FIX) | ✅ 已验证修复 | metricsHistory.push 修复确认正确 |
| #2 关键词歧义 (LOW) | ❌ 未修复 | 重新记录为 I-3 |
| #4 buildJudgeInput (INFO) | ❗ 声称已清理但实际残留 | 重新记录为 I-1 |
| #6 外层 try-catch (INFO) | ❌ 未修复 | 重新记录为 I-2，且发现前缀不一致 |
