---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 5
  issues_found: 11
  must_fix_count: 0
  low_count: 5
  info_count: 6
reviewer: ts-taste-check
date: 2026-05-31
scope:
  - context-engineering/src/compressor.ts
  - context-engineering/src/index.ts
  - context-engineering/src/config.ts
  - context-engineering/src/recall-store.ts
  - context-engineering/src/commands.ts
methodology: ts-taste-check SKILL.md → essence.md + ts/taste.md
---

# TypeScript 代码品味审查报告

## 总体评价

**结论：PASS（无必须修复项）**

代码质量整体优秀。模块职责划分清晰，类型安全到位，命名一致性强，错误处理合理。compressor.ts 虽然是最大文件（534 行），但内部按 L0/L1/L2 三个压缩层级和辅助函数组织，逻辑自洽、函数粒度合理（最长函数 `processL0` ~70 行），不构成拆分压力。

发现的问题均为 P1 偏好级别或信息性建议，不影响代码正确性和可维护性。

---

## 文件级审查

### compressor.ts（534 行）

**职责**：L0/L1/L2 压缩引擎 + 消息类型定义 + turn 边界检测 + tool 配对校验。单一职责：上下文压缩。

**类型定义（L1-57）**：AgentMessage discriminated union 设计良好，通过 `role` 字段可安全收窄。ToolResultMessage.details 标注 `unknown` 合理——这是 Pi 运行时传入的黑盒数据，扩展不应假设其结构。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 类型安全 | L58 `details?: unknown` | 可接受。Pi 运行时的黑盒数据，扩展无权定义其结构 | — |
| P1 | 魔法数字 | L174 `0.4`、L408 `0.4` | 截断比例 `0.4` 出现两次，语义是"保留 40% 预算给 head/tail" | 提取为 `const TRUNCATION_RETAIN_RATIO = 0.4` 并注释意图 |
| P1 | 魔法数字 | L399 `200000` | L2 fallback 估算中的上下文窗口大小，硬编码为 200K tokens | 提取为 `const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000`，或从 config 读取 |
| P1 | 隐式常量 | L160 `0.4 * 2`（head + tail 各 40%） | head/tail 分配比例隐含在 `Math.floor(maxChars * 0.4)` 中，中间 20% 丢失 | 注释说明"head 40% + tail 40%，中间 20% 用于省略标记" |
| Info | 命名 | L296 `estimateMessageChars` | 函数名暗示这是粗略估算，但实际上逻辑覆盖了所有 role 分支且计算精确 | 命名可接受，文档意图明确 |
| Info | 结构 | L186 `condenseToolResult` | 逻辑稍复杂（~45 行）：head/tail 分离 + middle 正则过滤 + fallback | 可接受，函数内部注释清晰，拆分收益不大 |

**统计**：P1: 3 | Info: 2

### index.ts（146 行）

**职责**：扩展入口，注册 event/tool/command。纯胶水层，不含业务逻辑。

**类型断言（L73-76）**：`event.messages as unknown as CompressorMessage[]` — 这是 Pi Extension API 类型不匹配的已知约束。compressor 定义了包含 `BashExecutionMessage` 的 AgentMessage 联合类型，而 Pi 的 `ContextEvent.messages` 类型不包含该变体。运行时数据确实包含所有类型。这是合理的边界适配。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 反馈 | L83-85 `catch {}` | context 事件处理器 catch 块为空，压缩失败时无任何日志输出 | 至少加 `console.error("[context-engineering] compression failed:", error)` ，避免问题静默恶化 |
| Info | 结构 | L72-85 `pi.on("context")` | 整个 handler 含 try-catch 约 14 行，逻辑紧凑 | 可接受 |
| Info | 类型 | L73-76 双重 `as unknown as` | Pi API 类型与本地类型不兼容的已知约束 | 可在注释中说明"Pi runtime guarantees this shape" |

**统计**：P1: 1 | Info: 2

### config.ts（144 行）

**职责**：配置类型定义 + 默认值 + 深合并 + 命令参数解析。单文件三职责，但每个职责独立且体量小（各 ~30-40 行），拆分收益不明显。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 魔法数字 | L46-60 DEFAULT_CONFIG | 配置值散落在字面量中（30min、4000 chars、8000 chars 等） | 可接受。这些是配置默认值，语义由字段名承载。如果未来需要文档化配置项，提取为带注释的常量 |
| Info | 边界校验 | L88-109 `loadConfig` | 读取外部文件后用 `deepMerge` 合并，无运行时 schema 校验 | Pi 扩展环境中可接受——配置来源是用户手动编辑的 settings.json，且 deepMerge 保证不破坏默认值结构 |
| Info | 类型安全 | L67 `deepMerge<T>` | 泛型函数内部用 `Record<string, unknown>` + 递归，类型擦除是深合并的固有特性 | 可接受。返回值类型由调用方的泛型参数约束 |

**统计**：P1: 0 | Info: 3

### recall-store.ts（49 行）

**职责**：压缩内容的存储和召回。纯数据结构。

**设计**：工厂函数返回闭包对象（`{ store, recall, clear, size }`），session_start 时重建。遵循 Pi 扩展的 session 隔离规范。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| Info | GC | 全文件 | 无 GC 机制，长 session 中 Map 无限增长 | CLAUDE.md 提到"自行实现 GC"。当前可接受——单 session 内 tool result 数量有限（通常 <100），未来可加 LRU 或 size 上限 |

**统计**：Info: 1

### commands.ts（118 行）

**职责**：命令格式化输出 + 参数处理。纯展示层。

**设计**：`handleContextEngineeringCommand` 直接修改传入的 `config` 对象（L84-99 的 `config.enabled = onOff`）。这是有意为之——命令需要即时生效，config 是引用传递的 session-scoped 对象。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| Info | 副作用 | L84-99 | 命令处理函数直接修改 config 引用 | 可接受。index.ts 传入的是 session-scoped 可变引用，命令效果需要即时反映到后续 context 事件 |

**统计**：Info: 0

---

## 跨文件审查

### 命名一致性 ✅

| 概念 | 命名 | 文件 | 一致性 |
|------|------|------|--------|
| 消息联合类型 | `AgentMessage` | compressor.ts | ✅ 统一 |
| 配置接口 | `ContextEngineeringConfig` | config.ts → index.ts → compressor.ts | ✅ 统一 |
| 存储接口 | `RecallStore` | recall-store.ts → index.ts → compressor.ts | ✅ 统一 |
| 统计接口 | `CompressionStats` | compressor.ts → index.ts → commands.ts | ✅ 统一 |
| 压缩层级 | `l0`/`l1`/`l2` | 全局 | ✅ 统一 |

### 函数复杂度 ✅

所有函数均在 80 行以内（`processL0` 最长约 70 行）。无超长函数。

### 模块依赖图 ✅

```
index.ts → config.ts (loadConfig, parseLevelArgs)
         → recall-store.ts (createRecallStore)
         → compressor.ts (compressContext, CompressionStats)
         → commands.ts (handleContextEngineeringCommand, handleContextStatsCommand)

compressor.ts → config.ts (类型)
              → recall-store.ts (类型)

commands.ts → config.ts (类型, parseLevelArgs)
            → compressor.ts (类型)

config.ts → (无项目内部依赖)
recall-store.ts → (无项目内部依赖)
```

依赖方向正确，无循环依赖。

### 错误处理模式 ✅

| 位置 | 模式 | 评价 |
|------|------|------|
| index.ts L83 catch {} | 空 catch + return {} | ⚠️ 应记录日志 |
| config.ts L97-99 catch (parse) | catch → 默认值 | ✅ 合理降级 |
| config.ts L92-94 catch (read) | catch → 默认值 | ✅ 合理降级 |

项目内错误处理模式统一：catch → 降级/默认值。唯一偏离是 index.ts 的空 catch。

### 类型安全 ✅

无 `any` 使用。`unknown` 仅出现在合理位置：
- `ToolResultMessage.details?: unknown` — Pi 运行时黑盒
- `deepMerge` 内部的 `Record<string, unknown>` — 深合并固有需求
- `ToolCall.arguments: Record<string, unknown>` — LLM 生成的动态参数

所有 `as unknown as` 断言（index.ts L73-76）有明确的 Pi API 类型不兼容原因。

---

## 汇总

| 优先级 | 数量 | 描述 |
|--------|------|------|
| P0（必须修复） | 0 | — |
| P1（推荐修复） | 4 | compressor.ts 魔法数字 ×3、index.ts 空 catch ×1 |
| Info（信息性） | 7 | 命名/结构/设计观察 |

### 建议修复顺序

1. **index.ts 空 catch**（P1）：加 `console.error` 日志。1 行改动。
2. **compressor.ts 魔法数字**（P1）：提取 `TRUNCATION_RETAIN_RATIO`、`FALLBACK_CONTEXT_WINDOW_TOKENS` 常量。~5 行改动。

### 亮点

- **discriminated union** 设计（AgentMessage）使 switch/if 分支类型收窄自然
- **工厂函数 + 闭包** 模式（recall-store）实现 session 隔离，无模块级可变状态
- **L0/L1/L2 三层压缩** 抽象层次清晰，每层独立配置、独立测试
- **tool pairing validation** 在压缩后校验消息配对完整性，防御压缩破坏对话结构
- **保护机制**（protected turn）防止压缩最近 N 轮对话，设计合理
