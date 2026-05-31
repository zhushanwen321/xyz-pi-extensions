---
verdict: fail
must_fix: 3
reviewer: ai-taste-review
date: 2026-05-31
scope: context-engineering/src/ (index.ts, compressor.ts, config.ts, recall-store.ts, commands.ts)
taste_docs: essence.md + ts/taste.md
---

# 代码品味审查 — context-engineering 插件

## 摘要

5 个源文件，940 行。整体架构清晰（config / compressor / recall-store / commands / index 职责分明），类型使用较好（无 `any`）。主要问题集中在：compressor.ts 严重超长（539 行），多处魔法数字未命名，index.ts 中 `as unknown as` 桥接 + 空 catch 违反品味原则。

---

## MUST_FIX（3 项）

### MF-1: compressor.ts 539 行 — 严重超出 300 行结构阈值

**文件**: `compressor.ts`
**行号**: 全文件 (1–539)
**原则**: 结构先于一切 — "单文件超过 300 行应审视是否需要拆分，超过 500 行几乎一定需要"
**优先级**: MUST_FIX

compressor.ts 包含消息类型定义（~100 行）、turn 检测逻辑（~40 行）、L0/L1/L2 三个处理函数（~300 行）、工具配对校验、格式化函数。职责过多。

**修复方向**: 按职责拆分为 3 个文件：
1. `types.ts` — 消息类型接口（TextContent, AssistantMessage, AgentMessage 等）+ CompressionStats + TurnBoundary
2. `compressor.ts` — 核心管线入口 `compressContext()` + `validateToolPairing()` + turn 检测
3. `levels.ts` — `processL0()`, `processL1()`, `processL2()` + 各级别的格式化辅助函数

### MF-2: 多处魔法数字未语义化命名

**文件**: `compressor.ts`
**行号**: L188–189, L207, L254, L344, L370
**原则**: 显式优于隐式 — 语义化命名；"86400 → TOKEN_EXPIRY_SECONDS"
**优先级**: MUST_FIX

| 行号 | 魔法数字 | 含义 | 建议命名 |
|------|---------|------|---------|
| L188–189 | `0.4` (×2) | bash 截断首尾保留比例 | `HEAD_TAIL_RATIO` |
| L207 | `0.4` | L1 fallback 截断保留比例 | `FALLBACK_KEEP_RATIO` |
| L254 | `0.4` | L1 压缩比阈值 | `COMPRESSION_RATIO_THRESHOLD` |
| L344 | `60000` | 分钟→毫秒转换 | `MILLIS_PER_MINUTE`（或 `config.expireMinutes * 60 * 1000` 也可，但 60000 更需命名） |
| L370 | `60000` | 同上 | 同上 |

注意 `0.4` 在 L188/L207/L254 反复出现，可能是同一个常量（head/tail 保留比例），也可能是两个不同语义的常量恰好值相同。需要作者确认后分别命名。

**修复方向**: 提取为顶层 `const`，如 `const MILLIS_PER_MINUTE = 60_000;`，`const HEAD_TAIL_RATIO = 0.4;`，`const COMPRESSION_TARGET_RATIO = 0.4;`。

### MF-3: index.ts 空 catch 吞掉错误

**文件**: `index.ts`
**行号**: L65
**原则**: 反馈不断裂 — "catch 块只有 console.error 是不可接受的"，no-silent-catch
**优先级**: MUST_FIX

```typescript
} catch { return {}; }
```

context 事件处理器中 catch 完全沉默。如果 compressContext 抛异常，返回空对象 `{}` 让 Pi 继续用原始消息，但没有任何日志、没有任何统计标记。问题会在沉默中积累。

**修复方向**: 在 catch 中至少记录错误信息。可以 `console.error("[context-engineering] compression failed:", error)` 并在 stats 中标记。或者用一个 `lastError` 变量供 `/context-stats` 命令展示。

---

## LOW（4 项）

### L-1: index.ts 中 `as unknown as` 桥接缺乏类型安全保障

**文件**: `index.ts`
**行号**: L61, L62, L64
**原则**: 类型即契约 — "Record<string, unknown> + as 断言组合" / "用 as 绕过类型检查而非用类型收窄"
**优先级**: LOW

```typescript
const msgs = event.messages as unknown as CompressorMessage[];
const result = compressContext(msgs, config, store, ctx.getContextUsage() as unknown as Parameters<typeof compressContext>[3]);
return { messages: result.messages as unknown as (typeof event.messages)[number][] };
```

三处 `as unknown as` 桥接 Pi Extension API 的外部类型和内部类型。这是 Pi 扩展的已知模式（外部类型和内部类型结构相同但 TS 不兼容），在当前架构下难以避免。但按品味文档，应：
1. 收敛到一个边界转换函数，而非散落三处
2. 在注释中说明为什么这是安全的（结构相同但类型不兼容）

**修复方向**: 提取 `function toCompressorMessages(msgs: ...): CompressorMessage[]` 和 `function fromCompressorMessages(msgs: CompressorMessage[]): ...` 两个边界转换函数，将 `as unknown as` 局限在转换函数内部。

### L-2: `expireToolResult` 接受但未使用 `_originalText` 参数

**文件**: `compressor.ts`
**行号**: L178
**原则**: 显式优于隐式
**优先级**: LOW

```typescript
export function expireToolResult(_originalText: string, id: string): string {
```

参数 `_originalText` 完全未使用（下划线前缀表明有意忽略）。如果未来会用，应该用注释说明；如果确定不用，就移除参数。当前签名给调用者和阅读者一个"这个函数用了原文"的错误暗示。

**修复方向**: 如果确定不用，移除 `_originalText` 参数。所有调用点（L350, L470）也需要同步去掉传入的 `originalText`。如果保留是为了未来扩展，加 `// TODO:` 注释说明。

### L-3: `getMessageTimestamp` 已导出但无调用方

**文件**: `compressor.ts`
**行号**: L165
**原则**: 死代码
**优先级**: LOW

```typescript
export function getMessageTimestamp(msg: AgentMessage): number {
  return msg.timestamp;
}
```

grep 全项目无任何调用方。如果仅为测试导出，应在注释中说明。

**修复方向**: 确认是否需要。如果仅供测试用，加注释说明；否则移除。

### L-4: config.ts `deepMerge` 未校验 override 的值类型

**文件**: `config.ts`
**行号**: L63–87
**原则**: 信任止于边界 — "只在系统边界做验证"
**优先级**: LOW

`deepMerge` 接受 `Record<string, unknown>` 并直接赋值到配置对象。如果 settings.json 中 `context-engineering.expireMinutes` 被误写为字符串 `"30"`，不会报错，运行时 `age > config.expireMinutes * 60000` 会产生 NaN 比较导致所有 toolResult 永不过期。

按品味文档，"处理外部输入时，必须在入口处添加校验"。deepMerge 之后应对结果做运行时校验。

**修复方向**: 在 `loadConfig()` 返回前添加简单的运行时校验，如检查关键字段是 number 类型：
```typescript
const merged = deepMerge(DEFAULT_CONFIG, override);
if (typeof merged.l0.expireMinutes !== "number") throw new Error("...");
```
或者用 Pi 已有的 TypeBox schema 校验。

---

## INFO（3 项）

### I-1: 测试辅助函数在两个测试文件中重复定义

**文件**: `__tests__/compressor.test.ts` + `__tests__/integration.test.ts`
**原则**: 消除重复 — 跨文件重复
**优先级**: INFO

`makeToolResult`, `makeAssistant`, `makeUser`, `makeBashExecution`, `tc`, `MINUTE` 在两个测试文件中完全重复。虽然测试文件不在本次审查范围，但值得指出。

### I-2: recall-store 的 8 字符 UUID 截断有碰撞风险

**文件**: `recall-store.ts`
**行号**: L32
**原则**: 安全无例外
**优先级**: INFO

```typescript
const uuid8 = randomUUID().slice(0, 8);
```

8 个十六进制字符 = 32 bit = ~43 亿空间。单个 session 内碰撞概率极低，但如果 store 足够大（>10000 条），生日碰撞概率约为 1%。不是当前必须修复的问题，但应记录这个限制。

### I-3: commands.ts 的 `formatConfigSummary` 在 enabled/disabled 分支有重复结构

**文件**: `commands.ts`
**行号**: L10–L44
**原则**: 统一优于灵活
**优先级**: INFO

每个 level（L0/L1/L2）都有 `if (enabled) { detailed } else { disabled }` 的分支结构。三段代码结构几乎相同。可以考虑用一个 level 数组 + 统一格式化函数消除重复，但当前可读性尚可，优先级不高。

---

## 通过项

以下方面符合品味要求，值得肯定：

1. **类型无 `any`** — 全项目无 `any` 类型，类型定义完整。
2. **文件职责清晰** — 5 个文件各有明确单一职责（config / compressor / recall-store / commands / index）。
3. **RecallStore 使用工厂函数 + 闭包** — 状态封装良好，不暴露内部 Map。
4. **白名单优于复杂条件** — `parseLevelArgs` 用 Set 白名单校验 target/action。
5. **`expireThinking()` / `expireToolResult()` 统一格式化** — 错误/过期消息走统一路径，符合"一个关注点一条路径"。
6. **`{ ...DEFAULT_CONFIG }` 防止默认值被意外修改** — 注意了浅拷贝防护。
