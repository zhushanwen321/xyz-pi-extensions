---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  issues_found: 0
  must_fix_count: 0
  low_count: 0
  info_count: 0
  duration_estimate: "5"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-03 14:30
- 审查模式：Dev（L1 + L2）
- 审查对象：use-cases.md + 源代码（4 files）
- 模拟数据路径数：6（2 主流程 + 3 异常路径 + 1 边界）

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 批量代码审查自适应模型 | ✅ 完整 | `handleAgentCall` → `resolveModel` → `resolveModelForScene` → 候选排序 → AgentPool | — |
| UC-2 | 显式模型覆盖 | ✅ 完整 | `handleAgentCall` → `resolveModel` → 直接 return `opts.model` → AgentPool `--model` | — |

## 问题清单

无。所有 UC 主流程 + 异常路径在代码层面均有完整对应。

## 执行路径详情（Dev 模式）

### UC-1: 批量代码审查自适应模型

**模拟数据（主流程）：**

```json
{
  "workflow_script": "agent({ scene: \"coding\", prompt: \"审查代码提交中的潜在缺陷\" })",
  "model_policy_config": {
    "scenes": { "coding": ["router-openai/glm-5.1", "deepseek-v3"] },
    "models": {
      "openrouter": { "plan": "zai", "models": { "router-openai/glm-5.1": { "modelId": "glm-5.1" } } },
      "opencode-go": { "plan": "opencode-go", "models": { "deepseek-v3": { "modelId": "deepseek-v3" } } }
    },
    "plans": {
      "zai": { "peak": { "start": 9, "end": 23 }, "priority": 1 },
      "opencode-go": { "priority": 2 }
    }
  }
}
```

**执行路径（主流程）：**

```
Worker 发送 type:"agent-call" → handleWorkerMessage(runId, instance, msg)
→ handleAgentCall(runId, instance, callId, opts)
  → resolveModel(opts)  [model-resolver.ts:10]
    → opts.model = undefined（未传 explicit model）→ 跳过
    → opts.scene = "coding" → 调用 resolveModelForScene("coding") [advisor.ts:124]
      → loadConfig() → 获取 model-policy.json [advisor.ts:127]
      → config.scenes["coding"] = ["router-openai/glm-5.1", "deepseek-v3"] [advisor.ts:133]
      → readCache() → computeQuotaSnapshot() [advisor.ts:140-141]
      → computePeakRecommend(now, config, snapshot) [advisor.ts:142]
        → findPeakPlan → "zai" (priority=1, has peak config) [advisor.ts:195]
        → 当前时间非 peak 时段 → { result: "ok", reason: "Off-peak" }
      → 候选收集 [advisor.ts:149-169]:
        • "router-openai/glm-5.1" → provider=openrouter, plan=zai, priority=1, isPeakAvoid=false
        • "deepseek-v3" → provider=opencode-go, plan=opencode-go, priority=2, isPeakAvoid=false
      → 排序：非 avoid 优先 → 两候选均非 avoid → priority 1 < 2 → openrouter/glm-5.1 胜出
      → 返回 "openrouter/glm-5.1"（最佳候选非 avoid → 跳过最后的 all-avoid 守卫） [advisor.ts:176-185]
    ← resolved = "openrouter/glm-5.1" [model-resolver.ts:14]
    → console.log 记录模型 [model-resolver.ts:15]
    → 返回 "openrouter/glm-5.1" [model-resolver.ts:20]
  → enrichedOpts = { ...opts, model: "openrouter/glm-5.1" }  [orchestrator.ts:240]
  → trace node: model = "openrouter/glm-5.1" [orchestrator.ts:245]
  → executeWithRetry → agentPool.enqueue(enrichedOpts) [orchestrator.ts:256]
    → buildArgs(opts) → args = ["--mode", "json", "-p", "--no-session", "--model", "openrouter/glm-5.1", prompt]
    → spawn pi 子进程 [agent-pool.ts:145]
  → 任务完成 → trace node 更新 status="completed", result=result [orchestrator.ts:274-280]
  → budget 累计 + checkBudget [orchestrator.ts:283-286]
```

**异常路径 AP-1（Peak 时段 — 候选被 avoid）：**

```json
{
  "variant": "Peak 时段（15:00，zai plan peak 9-23）",
  "quota_data": { "zai": { "pct": 60, "resetSec": 3600 } }
}
```

```
computePeakRecommend(now=15:00)
  → inPeak = true (9 ≤ 15 < 23) [advisor.ts:92]
  → quota.pct=60 > 50 (PEAK_WINDOW_THRESHOLD) [advisor.ts:101]
  → resetSec=3600 < winSec=18000 → 窗口后半段
  → peakInFirstHalf: peak(9-23) 与窗口前半段(now-2.5h ~ now)重叠 → true [advisor.ts:117]
  → quota.pct(60) > PEAK_WINDOW_THRESHOLD(50) → avoid [advisor.ts:119]
  → return { result: "avoid", reason: "Peak hours, >50% window (60%), peak overlaps early window" }

resolveModelForScene:
  → peakRecommend.result = "avoid" [advisor.ts:142]
  → peakPlanName = "zai" [advisor.ts:144]
  → 候选收集：
    • "router-openai/glm-5.1" → plan=zai == peakPlanName → isPeakAvoid=true [advisor.ts:166]
    • "deepseek-v3" → plan=opencode-go != peakPlanName → isPeakAvoid=false
  → 排序：deepseek-v3 (non-avoid) > router-openai/glm-5.1 (avoid)
  → best = deepseek-v3, isPeakAvoid=false
  → 返回 "opencode-go/deepseek-v3" ✓（避开了 peak 候选） [advisor.ts:181-184]
```

**异常路径 AP-2（全部 avoid）：**

```json
{
  "variant": "场景别名全部使用 zai plan，peak 时段",
  "config_scenes": { "coding": ["deepseek-v3"] },
  "deepseek-v3_plan": "zai"
}
```

```
resolveModelForScene:
  → peakRecommend.result = "avoid", peakPlanName = "zai"
  → 候选收集：deepseek-v3 plan="zai" == peakPlanName → isPeakAvoid=true
  → best = deepseek-v3, best.isPeakAvoid = true → all candidates avoid
  → console.info 日志 → return undefined [advisor.ts:180-182]

model-resolver.ts:
  → resolved = undefined
  → console.warn "could not resolve to a model, using default"
  → return undefined [model-resolver.ts:18-19]

handleAgentCall:
  → resolvedModel = undefined → enrichedOpts = opts (无 model 字段) [orchestrator.ts:240]
  → trace node: model = "default" [orchestrator.ts:245]
  → AgentPool.enqueue(opts) → buildArgs 无 --model → Pi 默认模型
```

**异常路径 AP-3（配置缺失）：**

```json
{
  "variant": "model-policy.json 不存在或无法解析"
}
```

```
resolveModelForScene:
  → loadConfig() → return null（文件不存在或 JSON parse 失败） [advisor.ts:127]
  → console.warn "no config loaded" → return undefined [advisor.ts:128-131]

model-resolver.ts:
  → resolved = undefined
  → console.warn [model-resolver.ts:18]
  → return undefined

  ── 容错覆盖：resolveModel 的 try-catch 层 ──
  若 resolveModelForScene 抛出异常（不返回 undefined）：
  → catch → console.warn "resolveModelForScene failed" [model-resolver.ts:22-24]
  → return undefined [model-resolver.ts:25]

handleAgentCall:
  → 同上 AP-2: enrichedOpts = opts, trace model="default", Pi 默认模型
```

**边界路径（scene + model 同时提供时 explicit model 优先）：**

```json
{
  "variant": "agent({ scene: \"coding\", model: \"minimax/mimo-v2.5-pro\" })"
}
```

```
resolveModel(opts):
  → opts.model = "minimax/mimo-v2.5-pro" → truthy → 直接 return，跳过 scene 检查 [model-resolver.ts:10]
  → scene 参数被静默忽略（行为正确，注释中有说明）
```

**Module Boundaries 验证：**

```
orchestrator.ts (handleAgentCall)
  → model-resolver.ts (resolveModel)
    → advisor.ts (resolveModelForScene)
      → config.ts (loadConfig)
      → quota-providers (readCache, computeQuotaSnapshot)
      → advisor.ts (computePeakRecommend)
    ← string | undefined
  ← enrichedOpts.model
→ AgentPool (buildArgs → --model flag)
```

✅ 边界清晰，职责分离，测试隔离性良好。

---

### UC-2: 显式模型覆盖

**模拟数据（主流程）：**

```json
{
  "workflow_script": "agent({ model: \"minimax/mimo-v2.5-pro\", prompt: \"审查此代码\" })"
}
```

**执行路径（主流程）：**

```
Worker 发送 type:"agent-call" → handleWorkerMessage
→ handleAgentCall(runId, instance, callId, opts)
  → resolveModel(opts) [model-resolver.ts:10]
    → opts.model = "minimax/mimo-v2.5-pro" → truthy → 立即返回
    → 不检查 opts.scene、不调用 resolveModelForScene [model-resolver.ts:10]
  → resolvedModel = "minimax/mimo-v2.5-pro"
  → enrichedOpts = { ...opts, model: "minimax/mimo-v2.5-pro" }
  → trace node: model = "minimax/mimo-v2.5-pro" [orchestrator.ts:245]
  → AgentPool.enqueue(enrichedOpts)
    → buildArgs: opts.model 为真 → args.push("--model", "minimax/mimo-v2.5-pro") [agent-pool.ts:107-108]
    → spawn pi --mode json -p --no-session --model minimax/mimo-v2.5-pro ...
  → 任务完成 → trace node 更新 status, result, completedAt
```

**异常路径：** 无（UC-2 未定义异常路径）

**验证要点：**
- ✅ `resolveModel` 中 `if (opts.model) return opts.model` 的 early return 确保 scene advisor 完全绕过
- ✅ `AgentPool.buildArgs` 正确传递 `--model` 参数到 pi 子进程
- ✅ trace node 记录指定的模型名

---

## 结论

**verdict: pass**

所有 UC 的主流程和异常路径在代码层面均有完整对应实现：

| UC | 主流程 | AP-1 | AP-2 | AP-3 | 后置条件 |
|----|--------|------|------|------|---------|
| UC-1 | ✅ | ✅ | ✅ | ✅ | ✅ |
| UC-2 | ✅ | N/A | N/A | N/A | ✅ |

**零 MUST_FIX。** 代码实现与 use-cases.md 的业务规格完全一致。三个模块（orchestrator → model-resolver → advisor）的职责边界清晰，异常路径的容错（配置缺失、全部 avoid、峰值退化）均有对应处理逻辑。
