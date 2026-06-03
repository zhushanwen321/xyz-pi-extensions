---
verdict: pass
must_fix: 0
reviewer: ts-taste-reviewer
date: 2026-06-03
scope: packages/model-switch/src/
---

# TypeScript 品味审查 v2 — 修复验证

## 验证项

### 1. advisor.ts — dead variables（原 L54-55）

**状态：已修复 ✅**

`computeStickiness` 中的 `turns` 和 `inputTokens` 在循环中累加后通过 return 返回，无 dead variable。
全文件扫描无其他未使用变量。

### 2. prompt.ts — formatStickinessLine 硬编码阈值

**状态：已修复 ✅**

- `StickinessThresholds` 接口（L36-39）定义 `minTurns` / `minInputTokens`
- `resolveStickinessThresholds(config)` 从 `config.stickiness` 读取，默认值 3 / 20,000
- `formatStickinessLine(stickiness, thresholds)` 使用参数而非硬编码
- 调用链：`formatContextPrompt` → `resolveStickinessThresholds(config)` → `formatStickinessLine(stick, thresholds)`

### 3. index.ts — before_agent_start catch 静默吞错

**状态：已修复 ✅**

```typescript
} catch (err) {
    console.warn("[model-switch] context injection failed:", err);
    return;
}
```

错误信息带前缀 `[model-switch]`，输出 err 对象，格式规范。

## 额外检查

对三个文件做全量扫描，未发现新引入的品味问题：
- 无 `any` 类型
- 无空 catch 块
- 无魔数（常量均提取为命名常量）
- 函数行数均在 80 行以内
- 单文件行数均在 1000 行以内

## 结论

两轮 MUST_FIX 共 2 项，全部修复到位，无回归。
