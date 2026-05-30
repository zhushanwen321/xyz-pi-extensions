---
verdict: CONDITIONAL_PASS
must_fix:
  - id: I-M1
    file: evolution-engine/src/commands.ts
    location: handleEvolve(), step 3d (GC) before step 4 (Judge)
    title: "GC/Judge 执行顺序与 daily-trigger.ts 不一致"
    description: |
      commands.ts 的 handleEvolve 在 step 3d 调用 runGc，然后在 step 4 调用 runJudge。
      daily-trigger.ts 在 step 4 先调 runJudge，step 5 才调 runGc。
      同一 pipeline 的两个入口有不同执行顺序。GC 可能删除 Judge 需要的信号文件。
      业务逻辑审查 V2-M1 已发现此问题，集成审查确认其影响范围覆盖两个入口。
    fix: 将 commands.ts step 3d 的 runGc 移到 step 4 runJudge 之后。
  - id: I-M2
    file: evolution-engine/src/daily-trigger.ts
    location: executePipeline(), step 3b-3c 之间
    title: "daily-trigger 未将 effectReview 写回信号文件，Judge 丢失数据"
    description: |
      daily-trigger.ts step 3b 将 effectReview 设置到内存 signalReport 对象：
        `signalReport.effectReview = effectReview;`
      但没有像 commands.ts 那样将更新后的 signalReport 写回信号文件：
        `writeFileSync(effectSignalPath, JSON.stringify(signalReport, null, 2))`
      step 4 的 Judge 从信号文件读取输入，而文件中没有 effectReview 数据。
      结果：daily-trigger 路径下 Judge 看不到效果回顾信息，/evolve 路径可以看到。
      两个入口给 Judge 的数据不一致。
    fix: 在 daily-trigger.ts step 3b 之后、step 4 之前，添加信号文件重写逻辑（与 commands.ts line 174-175 一致）。
---

# Integration Review v1 — evolve-daily-report

**审查轮次**: 第 1 轮
**审查日期**: 2026-05-29
**审查范围**: daily-trigger.ts ↔ commands.ts ↔ index.ts ↔ state.ts ↔ gc.ts ↔ report-generator.ts 之间的集成点
**前置依赖**: business_logic_review_v2.md（CONDITIONAL_PASS，1 项 MUST-FIX）

---

## 集成点清单

| # | 集成点 | 涉及文件 | 状态 |
|---|--------|----------|------|
| 1 | daily-trigger pipeline 复用 commands.ts 的 analyzer/summarizer/judge | daily-trigger.ts, commands.ts | ⚠ 顺序不一致 |
| 2 | session_start 中 fire-and-forget 调用 | index.ts | ✅ 正确 |
| 3 | handleEvolveReport 与 /evolve 流程一致性 | commands.ts | ✅ 正确（设计不同） |
| 4 | Dirs.dailyReportsDir 传递链 | types.ts, index.ts, gc.ts, state.ts, daily-trigger.ts, commands.ts | ✅ 完整 |
| 5 | /evolve-report command → tool 触发 | index.ts | ⚠ 模式不一致 |
| 6 | GC 对 daily-reports 的清理 | gc.ts | ✅ 正确 |
| 7 | mergePending vs savePending 使用场景 | state.ts, daily-trigger.ts, commands.ts | ✅ 正确 |
| 8 | makeDirs() 目录创建 | index.ts | ✅ 正确 |

---

## MUST-FIX（2 项）

### I-M1: GC/Judge 执行顺序不一致

**来源**: 业务逻辑审查 V2-M1，集成审查确认并补充影响分析

**文件**: `commands.ts` — `handleEvolve()` vs `daily-trigger.ts` — `executePipeline()`

**实际顺序对比**:

```
commands.ts handleEvolve:
  3a. loadMetricsHistory
  3b. summarizeReport（内部写信号文件到 signalsDir）
  3c. buildEffectReview + 写回信号文件
  3d. runGc(dirs.evolutionDir)          ← GC 在 Judge 之前
  3e. 构建 Judge input（读信号文件）
  4.  runJudge                          ← Judge 在 GC 之后

daily-trigger.ts executePipeline:
  3.  summarizeReport（内部写信号文件）
  3b. buildEffectReview（仅内存赋值，不写文件）← 另见 I-M2
  4.  runJudge                          ← Judge 在 GC 之前 ✅
  5.  runGc(dirs.evolutionDir)          ← GC 在 Judge 之后 ✅
```

**风险**: commands.ts 路径下，runGc 删除超过 MAX_SIGNALS=30 的旧信号文件。如果信号文件积累较多，刚在 step 3b 写入的新信号文件可能在 step 3d 被误删（理论上不太可能因为是最新的，但逻辑上是错误的依赖顺序）。更实际的风险是：step 3b 写入的信号文件包含 effectReview，如果 GC 在此之前意外删除了当天之前的信号文件，导致数据不完整。

**修复**: 将 commands.ts step 3d 的 `runGc` 移到 step 4 `runJudge` 之后。与 daily-trigger.ts 保持一致。

---

### I-M2: daily-trigger 未将 effectReview 写回信号文件

**文件**: `daily-trigger.ts` — `executePipeline()`, step 3b

**问题**: daily-trigger.ts 在 step 3b 执行 `signalReport.effectReview = effectReview`（内存赋值），但没有将更新后的 signalReport 写回信号文件。step 4 的 Judge 从信号文件读取输入（`signalPath = join(dirs.signalsDir, ...)`），文件中没有 effectReview 数据。

**对比 commands.ts 的处理**（line 174-175）:
```typescript
const effectSignalPath = join(dirs.signalsDir, `signal-${signalReport.metricsSnapshot.date}.json`);
writeFileSync(effectSignalPath, JSON.stringify(signalReport, null, 2), "utf-8");
```

commands.ts 在 buildEffectReview 之后会将包含 effectReview 的 signalReport 写回信号文件，确保 Judge 能读到完整数据。

**影响**: daily-trigger 路径下 Judge 缺少效果回顾信息，可能影响建议质量。两个入口给 Judge 的输入数据不一致。

**修复**: 在 daily-trigger.ts step 3b 和 step 4 之间，添加与 commands.ts 一致的信号文件重写逻辑。

---

## SHOULD-FIX（2 项）

### I-S1: /evolve-report command 使用 sendUserMessage 而非直接执行

**文件**: `index.ts` — `/evolve-report` command handler

**问题**: `/evolve-report` 命令使用 `pi.sendUserMessage()` 让 AI 调用 `evolve-report` tool，而其他所有命令（`/evolve`、`/evolve-apply`、`/evolve-stats`、`/evolve-rollback`）直接调用 handler 并通过 `ctx.ui.notify()` 展示结果。

```typescript
// /evolve-report — 委托给 AI
handler: async (args, _ctx) => {
    pi.sendUserMessage(
        `Please call the evolve-report tool with args="${args.trim()}". ...`,
    );
},

// /evolve-stats — 直接执行
handler: async (_args, ctx) => {
    const result = handleEvolveStats(dirs.evolutionDir);
    if (textPart?.type === "text" && ctx.hasUI) {
        ctx.ui.notify(textPart.text, "info");
    }
},
```

**影响**: 
- UX 不一致：用户执行 `/evolve-report` 后看到的是 AI 的 "tool call" 动画而非直接结果
- 依赖 AI 响应：如果 AI 正在处理其他任务，报告显示会延迟
- 额外 token 消耗：sendUserMessage 会触发一次 AI 推理

**可能的设计理由**: 让报告通过 tool 的 renderResult 渲染更丰富的 TUI 展示。但这可以用 command handler 直接调用 handleEvolveReport + notify 来实现，不需要走 AI 中转。

**建议**: 改为直接调用 handleEvolveReport，与其他命令保持一致。如果需要 TUI 渲染，可以在 command handler 中调用 widget 渲染函数。

### I-S2: ANALYZER_SCRIPT 常量在两个文件中重复定义

**文件**: `daily-trigger.ts` line 31-34, `commands.ts` line 38-41

```typescript
// daily-trigger.ts
const ANALYZER_SCRIPT = join(homedir(), ".pi/agent/scripts/pi-session-analyzer/analyze.py");

// commands.ts（完全相同）
const ANALYZER_SCRIPT = join(homedir(), ".pi/agent/scripts/pi-session-analyzer/analyze.py");
```

路径硬编码重复，如果将来 analyzer 安装位置变化，需要同时修改两处。

**建议**: 提取为共享常量（如 `constants.ts` 或在 types.ts 中导出）。

---

## NICE-TO-HAVE（1 项）

### I-N1: makeDirs() 只预创建部分子目录

**文件**: `index.ts` — `makeDirs()`

```typescript
for (const dir of [signalsDir, dailyReportsDir]) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}
```

`signalsDir` 和 `dailyReportsDir` 在启动时预创建，而 `reportsDir` 和 `tmpDir` 在使用时懒创建。虽然功能上没有问题（handleEvolve 和 executePipeline 都有 on-demand 创建），但不够一致。

---

## 验证矩阵

| 集成场景 | 测试方法 | 结果 |
|----------|----------|------|
| session_start 触发 daily analysis | 代码审查: `.catch()` 不阻塞, lock 防重入 | ✅ |
| 同一天不重复生成 | `checkAndRunDailyAnalysis` 检查 reportPath 存在 + size > 0 | ✅ |
| 并发安全 | acquireLock 的 PID 存活检查 + stale lock 清理 | ✅ (TOCTOU 已注释) |
| GC 清理 daily-reports | `listExpiredDailyByExt(dir, 30, ".md")` 正确匹配 .md 文件 | ✅ |
| mergePending 增量合并 + 去重 | title 精确匹配 + 容量保护 + 驱逐审计 | ✅ |
| /evolve-report 读取报告 | existsSync → readFileSync → 空内容检查 | ✅ |
| --list 列出报告 | 10 条限制 + 缺失日期诊断 + today 标记 | ✅ |
| 错误路径不崩溃 | try/catch → saveLastRunStatus("failed") → releaseLock in finally | ✅ |

---

## 总结

2 个 MUST-FIX（均涉及 pipeline 两个入口的不一致），2 个 SHOULD-FIX（命令模式不一致 + 常量重复），1 个 NICE-TO-HAVE。

I-M1 来自业务逻辑审查，集成审查确认其跨文件影响。I-M2 是新发现的集成问题：daily-trigger 路径下 Judge 缺少 effectReview 数据。两者修复量都很小，改完后可 PASS。
