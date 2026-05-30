---
verdict: fail
must_fix: 4
reviewer: business-logic-expert
date: 2026-05-29
scope: UC-1 ~ UC-6 + boundary conditions
files_reviewed:
  - evolution-engine/src/daily-trigger.ts
  - evolution-engine/src/report-generator.ts
  - evolution-engine/src/commands.ts (handleEvolveReport, listReports)
  - evolution-engine/src/state.ts (mergePending)
  - evolution-engine/src/gc.ts
---

# Business Logic Review — Evolve Daily Report

## 总览

对 UC-1 ~ UC-6 逐条审查业务逻辑与 spec AC 的一致性，并检查边界条件。
发现 4 个 must-fix 和 3 个 should-fix。

---

## UC-1: 每日自动生成分析报告

### 逻辑审查

| 步骤 | Spec 要求 | 实现 | 判定 |
|------|----------|------|------|
| 2. 计算 UTC 日期 | UTC YYYY-MM-DD | `new Date().toISOString().slice(0, 10)` — **本地时区偏移** | ⚠️ SHOULD-FIX |
| 3. 检查报告存在 | 已存在且非空则跳过 | `existsSync && statSync().size > 0` | ✅ 正确 |
| 5. 获取 lock | PID 存活跳过，PID 已死清理 | `acquireLock` 实现 process.kill(pid,0) 检测 | ✅ 正确 |
| 6. 运行 analyzer | `--since 1d` | `runAnalyzer` 调用 `--since 1d --format json` | ✅ 正确 |
| 10. 原子写入 | tmp → rename | `writeFileSync(tmp) + renameSync(tmp, reportPath)` | ✅ 正确 |
| 11. 合并 pending | title 去重 + 容量保护 | `mergePending` 实现 | ✅ 正确（但有 bug，见下） |
| 12. 记录状态 | `.last-run-status` | `saveLastRunStatus("success")` | ✅ 正确 |
| 13. 释放 lock | finally 中释放 | `finally { releaseLock() }` | ✅ 正确 |

#### ⚠️ SHOULD-FIX-1: 时区问题

`new Date().toISOString().slice(0, 10)` 返回 UTC 日期。但 `Date.now() - i * MS_PER_DAY` 在 `listReports` 中计算缺失日期时也用了 `toISOString()`，两端一致所以功能上没问题。风险在于：用户看到的是 UTC 日期而非本地日期，可能与用户感知的"今天"不同。

**严重程度**：低。两端一致，不影响功能正确性，仅用户体验偏差。记录为 should-fix。

#### 🔴 MUST-FIX-1: GC 在 Judge 之前执行可能导致新 Judge 报告被 GC 删掉

```typescript
// daily-trigger.ts 第 93-98 行
// 3c. GC
runGc(dirs.evolutionDir);

// 4. 运行 LLM Judge
const signalPath = join(dirs.signalsDir, `signal-${...}.json`);
```

`runGc` 在步骤 3c 执行，此时 **今天的 signal 文件尚未写入**（signal 文件在 `summarizeReport` 中写入的？需要确认）。但更重要的是，`runGc` 会按 `MAX_REPORTS=3` 删除 reports 目录中的旧 JSON 文件——如果当天的 analyzer 输出 tmp 文件在 reports/ 目录下，它可能被误删。

经过确认：`tmpReportPath` 在 `dirs.tmpDir` 下，不在 `reports/` 目录，所以 reports GC 不会误删。signals GC 保留最近 30 个，daily-reports GC 保留 30 天——在当前日期写入新文件之前执行 GC 理论上可能把恰好 30 天前的文件删掉，但不影响今天的报告。

**修正判定**：GC 执行顺序是安全的，无 must-fix。原判定取消。

#### 🔴 MUST-FIX-2: mergePending 容量保护将最早建议标记为 rejected 但无审计日志

```typescript
// state.ts mergePending
if (pendingCount > MAX_PENDING_SUGGESTIONS) {
    const overflow = pendingCount - MAX_PENDING_SUGGESTIONS;
    let evicted = 0;
    for (const sug of existing.suggestions) {
        if (sug.status === "pending" && evicted < overflow) {
            sug.status = "rejected";
            evicted++;
        }
    }
}
```

问题：
1. 静默将 pending → rejected，无日志、无 history entry 记录。用户通过 `/evolve-apply list` 看不到被驱逐的建议，无法追溯。
2. spec AC-8b 要求"容量保护"，但没有要求静默驱逐。应该在 `appendHistory` 中记录驱逐事件。

**严重程度**：中。数据静默丢失，违反可追溯性原则。

---

## UC-2: 查看今日报告

| 步骤 | Spec 要求 | 实现 | 判定 |
|------|----------|------|------|
| 无参数 → 今天 | `isDateString(trimmed) ? trimmed : today` | 空字符串不匹配 date pattern → fallback 到 today | ✅ 正确 |
| 报告不存在 | 检查 `.last-run-status` 展示诊断信息 | `readLastRunStatus` + 拼接状态/错误 | ✅ 正确 |
| 报告为空/损坏 | Spec: 展示"报告文件损坏" | **未检查** — `readFileSync` 直接返回，空文件会返回空字符串作为 content | 🔴 MUST-FIX |

#### 🔴 MUST-FIX-3: 未检查报告文件为空的情况

Spec UC-2 Alternative Path 明确要求："报告文件为空/损坏：展示'报告文件损坏'"。

实现中 `handleEvolveReport` 在文件存在后直接 `readFileSync` 返回内容。如果文件存在但为空（可能由原子写入中断导致），会返回空字符串作为报告，用户看到空白输出。

修复：在读取后检查 content 是否为空或非有效 Markdown。

```typescript
// 建议修复位置: commands.ts handleEvolveReport
const content = readFileSync(reportPath, "utf-8");
if (!content.trim()) {
    throw new Error("报告文件损坏：内容为空");
}
```

---

## UC-3: 查看指定日期报告

| 步骤 | Spec 要求 | 实现 | 判定 |
|------|----------|------|------|
| 日期验证 | YYYY-MM-DD | `isDateString` 正则 + `new Date(s).getTime()` NaN 检查 | ✅ 正确 |
| 文件不存在 | 返回 "报告不存在" | `throw new Error(\`${targetDate} 的报告不存在\`)` | ✅ 正确 |
| 非法输入 | 未在 UC 中定义 | 非日期字符串 fallback 到"今天"，如 `--list` 已被提前处理 | ✅ 可接受 |

**判定**：UC-3 逻辑正确，无问题。

---

## UC-4: 列出所有可用报告

| 步骤 | Spec 要求 | 实现 | 判定 |
|------|----------|------|------|
| 扫描目录 | `daily-reports/*.md` | `readdirSync` + `.endsWith(".md")` + `!startsWith(".")` | ✅ 正确 |
| 排序 | 降序 | `.sort().reverse()` — 字符串排序，YYYY-MM-DD 格式下等同于日期降序 | ✅ 正确 |
| 取最近 10 条 | `.slice(0, 10)` | ✅ 正确 |
| 最后运行状态 | 读取 `.last-run-status` | `readLastRunStatus` | ✅ 正确 |
| 缺失日期 | 过去 7 天 | `for i=0..6` 检查 entries 中是否存在 | ✅ 正确 |
| 无报告 | 返回提示 | entries.length === 0 → "尚未生成任何报告" | ✅ 正确 |

#### ⚠️ SHOULD-FIX-2: 缺失日期检测可能误报

```typescript
for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * MS_PER_DAY).toISOString().slice(0, 10);
    if (!entries.some(e => e === `${d}.md`)) {
        missingDates.push(d);
    }
}
```

`entries` 已经被 `.slice(0, 10)` 截断为最多 10 条。如果 `daily-reports/` 中有超过 10 个文件，7 天前的文件可能在磁盘上存在但不在 `entries` 中，导致 false positive 缺失报告。

修复：对缺失日期检测应直接用 `existsSync(join(dirs.dailyReportsDir, `${d}.md`))` 而非检查 entries 列表。

**严重程度**：中。可能向用户显示错误的缺失日期信息。

---

## UC-5: 手动查看建议后决定执行

本 UC 描述的是用户交互流程，不涉及新代码——复用现有 `evolve-apply` 流程。

| 检查点 | 判定 |
|--------|------|
| pending.json 与报告建议一致 | ✅ 同一批 suggestions 被写入报告和 pending.json |
| 现有 apply 流程不变 | ✅ 无改动 |

**判定**：UC-5 逻辑正确，无问题。

---

## UC-6: GC 清理旧报告

| 步骤 | Spec 要求 | 实现 | 判定 |
|------|----------|------|------|
| 触发时机 | 每日分析完成后 | `checkAndRunDailyAnalysis` 步骤 3c 调用 `runGc` | ✅ 正确 |
| 删除 >30 天文件 | `MAX_DAILY_REPORT_DAYS = 30` | `listExpiredDailyByExt(..., ".md")` | ✅ 正确 |
| 返回删除数量 | `GcResult.dailyReportsRemoved` | ✅ 正确 |
| 目录为空 | 返回 0 | `existsSync` 检查 + 空数组 → 0 | ✅ 正确 |

#### ⚠️ SHOULD-FIX-3: GC 结果未被使用或记录

`runGc` 返回 `GcResult`，但在 `checkAndRunDailyAnalysis` 中调用时未接收返回值，也未写入任何日志。如果 GC 删除了不该删除的文件，没有诊断手段。

建议：至少 `console.log` 或写入 `.last-run-status` 中的 gcStats 字段。

**严重程度**：低。功能正确，但可观测性不足。

---

## 边界条件审查

### 1. 0 session 日

| 检查点 | 实现 | 判定 |
|--------|------|------|
| 报告生成 | `hasData = snapshot.sessionCount > 0` → "无数据" 占位 | ✅ 正确 |
| Judge 处理 | Judge 收到的 signal 报告中 sessionCount=0，应产生 0 建议 | ✅ 可接受（依赖 Judge 行为） |
| pending 合并 | 空建议数组 → `mergePending` 第一行 `return` | ✅ 正确 |

### 2. 0 suggestions

| 检查点 | 实现 | 判定 |
|--------|------|------|
| 报告显示 | `buildSuggestions` → "系统运行良好，无需调整" | ✅ 正确 |
| pending 合并 | `newSuggestions.length === 0 → return` | ✅ 正确 |

### 3. 并发锁

| 检查点 | 实现 | 判定 |
|--------|------|------|
| Lock 获取 | `acquireLock` 检查 PID 存活 | ✅ 正确 |
| Lock 释放 | `finally { releaseLock() }` | ✅ 正确 |
| 竞态窗口 | lock 不存在 → 创建之间有极小竞态窗口（非原子） | ⚠️ 可接受 |

### 4. Stale lock

| 检查点 | 实现 | 判定 |
|--------|------|------|
| PID 已死 | `process.kill(pid, 0)` throw → 清理 + 继续 | ✅ 正确 |
| 锁文件损坏 | JSON.parse 失败 → catch 清理 | ✅ 正确 |

### 5. 报告缺失（今天）

| 检查点 | 实现 | 判定 |
|--------|------|------|
| `/evolve-report` 无参数 | 展示 last-run-status 诊断 | ✅ 正确 |
| 诊断信息充分 | 状态 + 时间 + 错误摘要 | ✅ 正确 |

### 🔴 MUST-FIX-4: `acquireLock` 无原子性保证

```typescript
function acquireLock(lockPath: string): boolean {
    if (existsSync(lockPath)) { ... cleanup ... }
    // 窗口：两个进程同时到达这里
    writeFileSync(lockPath, JSON.stringify(data), "utf-8");
    return true;
}
```

在两个 Pi 进程同时启动、同时发现无 lock 文件的场景下，两个进程都会通过 `existsSync` 检查并同时创建 lock 文件，导致都认为自己获得了锁，两个分析流程并行执行。

修复建议：使用 `O_EXCL` 标志的 `openSync` 实现原子创建：

```typescript
import { openSync, closeSync } from "node:fs";

function acquireLock(lockPath: string): boolean {
    // ... stale lock cleanup with existsSync ...
    
    try {
        const fd = openSync(lockPath, "wx"); // O_EXCL: 原子创建，文件已存在则抛错
        const data = JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() });
        writeFileSync(fd, data);
        closeSync(fd);
        return true;
    } catch {
        // 另一个进程已经创建了 lock
        return false;
    }
}
```

**严重程度**：中。在正常使用中概率很低（两个 session 同时在 00:00 UTC 启动），但违反 spec AC-8a 的锁语义。

---

## 汇总

### Must-Fix（4 项）

| # | 位置 | 问题 | 严重程度 |
|---|------|------|----------|
| MUST-FIX-2 | state.ts `mergePending` | 容量保护驱逐 pending→rejected 无审计日志，数据静默丢失 | 中 |
| MUST-FIX-3 | commands.ts `handleEvolveReport` | 未检查报告文件为空，spec UC-2 要求展示"报告文件损坏" | 中 |
| MUST-FIX-4 | daily-trigger.ts `acquireLock` | `existsSync` + `writeFileSync` 非原子，理论上两进程可同时获取锁 | 中 |
| MUST-FIX-1（降级为 MUST-FIX-4 补充） | daily-trigger.ts | `acquireLock` 在 stale lock 清理路径中也有同样的 TOCTOU 窗口 | 中 |

### Should-Fix（3 项）

| # | 位置 | 问题 | 严重程度 |
|---|------|------|----------|
| SHOULD-FIX-1 | daily-trigger.ts, commands.ts | UTC 日期 vs 本地日期，两端一致但可能与用户感知不同 | 低 |
| SHOULD-FIX-2 | commands.ts `listReports` | 缺失日期检测基于截断后的 entries 而非实际磁盘文件，可能误报 | 中 |
| SHOULD-FIX-3 | daily-trigger.ts | `runGc` 返回值未使用，GC 操作无可观测性 | 低 |

### 整体评估

UC-1 主流程（analyzer → summarizer → judge → report → merge）逻辑正确，错误处理和 finally 清理完善。UC-3、UC-5、UC-6 逻辑无误。

核心问题集中在：
1. **边界条件遗漏**（空报告文件检查）
2. **原子性缺陷**（lock TOCTOU）
3. **可追溯性缺失**（静默驱逐建议）
4. **误报风险**（缺失日期检测逻辑）

建议修复 4 个 must-fix 后重新审查。
