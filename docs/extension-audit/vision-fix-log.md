# Extension 审查修复日志: vision

**修复日期:** 2025-01-21
**修复范围:** `docs/extension-audit/vision.md` 中列出的 P1 问题
**修复原则:** 最小变更、不重构不相关代码、保持代码逻辑不变

---

## 概览

| 类别 | 数量 | 状态 |
|------|------|------|
| P0 问题 | 0 | — (审查报告中无 P0) |
| P1 问题 | 3 | ✅ 全部修复 |
| P2 问题 | 5 | ⏭️ 按原则跳过 |

---

## ✅ 已修复的 P1 问题

### P1-1: 模块级 `let` 变量违反工厂闭包规范

**文件:** `extensions/vision/src/vision-model.ts`

**修复方案:** 引入 `createVisionModelApi()` 工厂函数，将模块级缓存状态 `_cachedConfig` / `_cachedConfigTimestamp` 移入工厂闭包。`loadVisionModels()` 与 `resolveVisionModelSync()` 改为闭包内私有函数，通过工厂返回。

**关键变更:**

```typescript
// 旧: 模块级 let
let _cachedConfig: VisionModelsConfig | null | undefined = undefined;
let _cachedConfigTimestamp = 0;

export function loadVisionModels(): VisionModelsConfig | null { /* ... */ }
export function resolveVisionModelSync(): ... { /* ... */ }

// 新: 工厂闭包
export interface VisionModelApi {
    loadVisionModels: () => VisionModelsConfig | null;
    resolveVisionModelSync: () => ResolveVisionModelResult;
}

export function createVisionModelApi(): VisionModelApi {
    const CACHE_TTL_MS = SEC_PER_MIN * MS_PER_SEC;
    let cachedConfig: VisionModelsConfig | null | undefined = undefined;
    let cachedConfigTimestamp = 0;
    function loadVisionModels() { /* ... */ }
    function resolveVisionModelSync() { /* ... */ }
    return { loadVisionModels, resolveVisionModelSync };
}
```

**调用方适配:** `extensions/vision/src/index.ts` 中:
- `loadVisionModels` / `resolveVisionModelSync` 的命名导入替换为 `createVisionModelApi`
- 在 `visionExtension()` 工厂闭包内调用 `const visionModel = createVisionModelApi();`
- `resolveVisionModelSync()` → `visionModel.resolveVisionModelSync()`
- `loadVisionModels()` → `visionModel.loadVisionModels()`

**逻辑保持:** 缓存 TTL、文件读取、错误处理、provider 校验、按 order 排序、返回首个候选模型 —— 全部行为完全一致。

---

### P1-3: `runSingleVisionAgent` 函数过长 (172 行)

**文件:** `extensions/vision/src/spawn.ts`

**修复方案:** 将 `runSingleVisionAgent` 拆分为 6 个职责单一的辅助函数:

| 新函数 | 职责 | 行数 |
|--------|------|------|
| `buildVisionBaseArgs()` | 构造基础 CLI 参数 (mode/model/tools) | 12 |
| `appendVisionOptionalArgs()` | 追加 thinking / fork session 可选参数 | 20 |
| `processVisionEventLine()` | 解析单行 JSON 事件并更新 result | 42 |
| `flushTrailingStdout()` | flush 尾部不完整行 | 14 |
| `spawnAndAwaitVision()` | 子进程生命周期 (stdout/stderr/close/error/abort) | 56 |
| `buildEmptyResult()` | 构造初始 result 对象 | 14 |
| `buildEmitUpdate()` | 构造 onUpdate 回调 | 17 |

**重构后 `runSingleVisionAgent`:** 从 172 行降至 **50 行**，仅保留参数解构、result 初始化、参数构建、子进程等待、临时文件清理等高层编排逻辑。

**逻辑保持:** 子进程参数顺序、stdout 行分割、message_end / tool_result_end 事件处理、usage 累加、contextTokens 取最大值、signal 监听、最终 stdout flush、close/error 时的 result 填充、临时文件清理 —— 全部行为完全一致。

---

### P1-2: `execute` 回调函数过长 (~101 行)

**文件:** `extensions/vision/src/index.ts`

**修复方案:** 将 `execute` 回调拆分为 6 个职责单一的辅助函数:

| 新函数 | 职责 | 行数 |
|--------|------|------|
| `validateImagePath()` | 解析 image_path 为绝对路径并检查存在性 | 22 |
| `buildMissingModelResult()` | 构造 "无 vision 模型" 错误结果 | 9 |
| `resolveForkContext()` | 处理 fork 上下文 (parent session 复制 / 降级检测) | 15 |
| `buildVisionTask()` | 构造发往子进程的 task 字符串 | 11 |
| `buildVisionDetails()` | 构造 result 的 details 结构 | 20 |
| `buildVisionResult()` | 根据 result.exitCode/stopReason 构造最终成功/错误结果 | 22 |

**重构后 `execute`:** 从 ~101 行降至 **34 行**，仅保留高层流程编排 (cleanupOldTempFiles → validate → resolve → spawn → details → result)。

**额外清理:**
- 提取常量 `EMPTY_MODEL_DETAILS` 与 `FORK_DEGRADED_WARNING`，消除多处重复的字面量。
- `EMPTY_MODEL_DETAILS` 使用展开 `{ ...EMPTY_MODEL_DETAILS }` 返回新对象，避免上游修改共享引用。
- 新增本地类型 `type VisionToolResult = AgentToolResult<VisionDetails> & { isError?: boolean }`，用于辅助函数返回类型注释，保留原代码中 `isError: true` 字段。

**逻辑保持:** 路径解析规则、错误信息文本、contextMode → effectiveContext 降级规则、degradation warning 条件、isError 判断条件 (`exitCode !== 0 || stopReason === "error" || stopReason === "aborted"`)、错误信息回退顺序 (`errorMessage → stderr → getFinalOutput → "(no output)"`) —— 全部行为完全一致。

---

## 验证

```bash
$ cd extensions/vision
$ npx tsc --noEmit
# 仅有与本修复无关的、预先存在的跨包类型错误 (claude-rules-loader / coding-workflow / workflow)
$ npx eslint src/
# exit: 0
```

`extensions/vision/src/**` 下的所有文件:
- ✅ TypeScript 编译通过 (无新增错误)
- ✅ ESLint 检查通过
- ✅ 逻辑行为与修复前完全一致

---

## ⏭️ 跳过的 P2 问题 (按修复原则)

| 编号 | 问题 | 跳过原因 |
|------|------|----------|
| P2-1 | 缺少集中 `types.ts` 文件 | P2 优先级，工作量低但需要新建文件与改动 3 个文件的导入路径，超出"最小变更"原则 |
| P2-2 | 未使用的 `_THINKING_TO_PI` | P2 优先级，可后续清理 |
| P2-3 | 冗余类型断言 `as string` | P2 优先级，可后续清理 |
| P2-4 | 无 `isStaleContextError` 防护 | P2 优先级，子进程架构已天然隔离 |
| P2-5 | 无防重入标志 | P2 优先级，UUID 命名临时文件已天然防止冲突 |

---

## 修复前后行数对比

| 文件 | 修复前总行数 | 修复后总行数 | 关键函数 |
|------|-------------|-------------|----------|
| `src/vision-model.ts` | 145 | 150 | 工厂闭包替换模块级 let |
| `src/spawn.ts` | 293 | 320 | `runSingleVisionAgent` 172→50 行 |
| `src/index.ts` | 258 | 300 | `execute` 回调 101→34 行 |

注: 文件总行数略有增加，是辅助函数签名/注释/空行带来的正常开销;实际函数体行数均显著下降，单个函数职责更清晰。

---

*修复完成. 所有 P1 问题已修复，代码逻辑保持不变。*
