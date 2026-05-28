---
verdict: "PASS_WITH_ISSUES"
must_fix:
  - "跨文件类型/常量重复: CompatibleMessage 与 MinimalAgentMessage 重复定义"
  - "跨文件常量重复: IC_SUMMARY_CUSTOM_TYPE / IC_RECALL_PROMPT_TYPE 在 index.ts 和 context-handler.ts 中各定义一次"
  - "Record<string, unknown> + as 绕过类型检查: segment-tracker.ts 中多处 using assertion 而非结构化类型"
  - "import 包名不符合项目规范: recall-tool.ts 使用 @earendil-works/* 而非 @mariozechner/*"
review_metrics:
  P0: 4
  P1: 8
  P2: 0
  P3: 1
  total_files: 7
  files_with_issues: 6
  score: 6.5
---

# TypeScript 代码品味审查报告 — Infinite Context Engine

**审查日期**: 2026-05-29
**审查范围**: `infinite-context/src/` 下 7 个源文件（types, segment-tracker, tree-compactor, context-handler, recall-tool, commands, index）
**参考标准**: `.codetaste/essence.md` + `.codetaste/ts/taste.md`

---

## 汇总

| 指标 | 值 |
|------|-----|
| 审查文件数 | 7 |
| 存在问题文件 | 6 (types.ts 无问题) |
| P0 (必须修复) | 4 |
| P1 (推荐修复) | 8 |
| P2 (安全防御) | 0 |
| P3 (细节) | 1 |
| **总体评分** | **6.5/10** |

**评价**: 整体架构清晰，职责划分合理，命名规范，注释到位。主要问题集中在：类型重复定义（P0）、Record 断言绕过类型检查（P0）、包名规范违反（P0）、少量魔法数字和代码重复（P1）。代码质量在中上水平，P0 修复后可提升至 7.5+。

---

## P0 — 原则违反（必须修复）

### 1. 跨文件类型重复定义

| 位置 | 描述 | 建议 |
|------|------|------|
| `context-handler.ts` L19-L32 + `index.ts` L47-L55 | `MinimalAgentMessage` 和 `CompatibleMessage` 本质上是同一类型（都可兼容 Pi AgentMessage），各定义一份 | 抽到 `types.ts` 中作为 `PiCompatibleMessage` 统一导出 |
| `context-handler.ts` L67-L74 + `index.ts` L40-L43 | `IC_SUMMARY_CUSTOM_TYPE` 和 `IC_RECALL_PROMPT_TYPE` 常量在 index.ts 和 context-handler.ts 中各定义一次 | 统一在 `types.ts` 中定义，其他地方 import |

**违背原则**: `taste.md "消除一切重复——包括跨文件重复的类型定义"`

**修复方案**:

在 `types.ts` 中新增：

```typescript
/** Pi AgentMessage 兼容类型（供 context-handler 和 index 使用） */
export interface PiCompatibleMessage {
  role: string;
  content?: string | ContentPart[];
  customType?: string;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** CustomMessage customType 常量 */
export const IC_SUMMARY_CUSTOM_TYPE = "ic-summary" as const;
export const IC_RECALL_PROMPT_TYPE = "ic-recall-prompt" as const;
```

`context-handler.ts` 和 `index.ts` 改 import 引用，删除本地定义。

---

### 2. `Record<string, unknown>` + `as` 绕过类型检查

**segment-tracker.ts** 中多处使用 `as` 断言而非结构化类型：

| 函数 | 位置 | 代码 | 问题 |
|------|------|------|------|
| `extractUserText` | L48 | `const msg = message as Record<string, unknown>` | 内部用 `Record<string, unknown>` 逐一访问字段，类型逃逸 |
| `extractToolCalls` | L62 | `const r = result as Record<string, unknown>` | 同上 |
| `isSegmentEntry` | L36 | `(entry as CustomEntry).customType === SEGMENT_ENTRY_TYPE` | 类型断言绕过 |
| `isTurnEntry` | L41 | `(entry as CustomEntry).customType === TURN_ENTRY_TYPE` | 同上 |

**违背原则**: `taste.md "类型即契约"` + `"用 as 绕过类型检查"`

**修复方案**:

```typescript
// extractUserText — 使用 discriminated union + 类型守卫
function extractUserText(message: unknown): string {
  if (message === null || message === undefined) return "";
  // 先用结构化断言收窄
  if (typeof message !== "object") return "";
  const msg = message as { role?: unknown; content?: unknown };
  // 或者先检查 role
  // ...
}
```

更好的方式是定义入口类型：

```typescript
interface TurnEndMessage {
  role: string;
  content?: string | Array<{ type: string; text: string }>;
}
```

`isSegmentEntry` / `isTurnEntry` 可改为类型守卫 + 中间变量：

```typescript
function isSegmentEntry(entry: SessionEntry): entry is CustomEntry<SegmentEntryData> {
  if (entry.type !== "custom") return false;
  const custom = entry as CustomEntry;  // 只在类型守卫函数中做一次断言
  return custom.customType === SEGMENT_ENTRY_TYPE;
}
```

不在项目的 CLAUDE.md 白名单中，不符合豁免条件。

---

### 3. import 包名不符合项目规范

| 文件 | 行 | 当前 import | 应为 |
|------|-----|------------|------|
| `recall-tool.ts` | L7 | `import { Text } from "@earendil-works/pi-tui"` | `import { Text } from "@mariozechner/pi-tui"` |
| `recall-tool.ts` | L8 | `import { StringEnum } from "@earendil-works/pi-ai"` | `import { StringEnum } from "@mariozechner/pi-ai"` |

**违背原则**: CLAUDE.md 明确要求 `import 统一使用 @mariozechner/*`（两个 pi 都认识的公约数），`@earendil-works/*` 在原版 pi 上不兼容。

**修复方案**: 将两处 import 改为 `@mariozechner/pi-tui` 和 `@mariozechner/pi-ai`。

---

## P1 — 偏好违反（推荐修复）

### 1. busy-wait 轮询模式

**文件**: `commands.ts` L57-L62

```typescript
while (compactor.isCompressing() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
```

**问题**: 每 500ms 轮询一次直到 deadline，浪费 clock ticks。即使用了 `await` 不阻塞事件循环，仍然是不优雅的轮询模式。

**违背原则**: `taste.md "结构先于一切"` — 异步操作应使用基于事件/回调的 completion 通知。

**建议**: `triggerCompression` 已经接受 `onComplete` 回调。只需将压缩超时改为 Promise 封装：

```typescript
const result = await new Promise<CompactResult>((resolve) => {
  compactor.triggerCompression(pi, ctx, segments, compactor.getTree(), resolve);
  // 超时保护
  setTimeout(() => {
    if (compactor.isCompressing()) {
      ctx.ui.notify("树压缩超时，正在后台继续...");
      // resolve with current state
    }
  }, 35_000);
});
```

### 2. 未使用变量

**文件**: `context-handler.ts` L128-L130

```typescript
const _treeSegIds = collectTreeSegIds(tree.root);
void _treeSegIds;
```

**问题**: `_treeSegIds` 被赋值但从未使用，`void` 只是抑制 lint 警告。collectTreeSegIds 的计算白白浪费。

**建议**: 删除这两行，或添加注释说明未来用途并在需要时再调用。

### 3. 代码重复 — 压缩重试逻辑

**文件**: `tree-compactor.ts`

`runCompression` (L206-L278) 和 `handleCompressionFailure` 中的重试块 (L300-L340) 几乎完全重复相同的逻辑：
- 都 spawn Pi 子进程
- 都收集 stdout
- 都设超时
- 都校验输出
- 都构建树

**建议**: 提取公共 `spawnAndValidate` 方法：

```typescript
private spawnAndValidate(
  prompt: string,
  segments: readonly Segment[],
): Promise<{ result: TreeNode[] | ValidateError; timedOut: boolean; exitCode: number | null }> {
  // ... 公共 spawn + 收集 + 超时逻辑
}
```

`runCompression` 和 `handleCompressionFailure` 中只调用此方法。

### 4. 死函数 / 空实现

**文件**: `segment-tracker.ts` L189-L193

```typescript
private writeSegmentFile(ctx: ExtensionContext, segment: Segment): void {
  void ctx;
  void segment;
}
```

**问题**: 空函数体 + `void` 抑制。被 `handleTurnEnd` 调用，但什么都不做。这是 TODO 的半成品残留。

**违背原则**: `essence.md "消除一切无意义的代码"` — 空函数增加阅读负担和调用开销。

**建议**: 如果暂时不实现，移除调用和函数体，或明确标记 `@todo` 并用 `if (false)` 守卫包裹调用。

### 5. 魔法数字缺少命名常量

| 文件 | 行 | 值 | 位置 | 建议 |
|------|----|----|------|------|
| `tree-compactor.ts` | L54 | `80` | `firstSentence` 截断长度 | 命名为 `SUMMARY_MAX_CHARS = 80` |
| `tree-compactor.ts` | L67 | `200` | `validateTreeOutput` JSON 片段截断 | 命名为 `ERROR_SNIPPET_MAX = 200` |
| `context-handler.ts` | L48 | `200_000` | `DEFAULT_CONTEXT_WINDOW` | 已命名 ✅，但无注释说明为什么是 200k |
| `commands.ts` | L56 | `35_000` | 命令超时 | 应与 `COMPRESSION_TIMEOUT_MS` 关联或复用 |
| `segment-tracker.ts` | L28 | `500` | `MAX_TURN_ENTRIES` | 已命名，但无注释说明选值依据 |

**违背原则**: `taste.md "语义化命名"`（ESLint `no-magic-numbers`）

**建议**: 
- `firstSentence(80)` → `firstSentence(text, SUMMARY_MAX_CHARS)`
- 错误 snippet 截断加命名常量
- `35_000` 改为 `COMPRESSION_TIMEOUT_MS + 5_000` 明确表达"命令超时比压缩超时多5秒缓冲"

### 6. 重复逻辑 — 树恢复

**文件**: `recall-tool.ts` L125-L137

```typescript
function loadTreeFromEntries(ctx: ExtensionContext): CompactTree | undefined {
  const entries: SessionEntry[] = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && (entry as CustomEntry).customType === "ic-compact-tree") {
      return (entry as CustomEntry<CompactTree>).data;
    }
  }
  return undefined;
}
```

**问题**: 此逻辑与 `TreeCompactor.restoreState` 中的 entry 遍历逻辑重复，且使用了 `as CustomEntry` 断言（P0 同类问题）。

**建议**: 在 `TreeCompactor` 上暴露 `getLatestTree(ctx)` 静态方法，或在 `TreeCompactor` 中增加 `loadFromEntries(entries)` 方法供 `RecallTool` 调用，消除重复。

### 7. 函数签名参数冗余

**文件**: `recall-tool.ts` L146

```typescript
executeRecall(
  nodeId: string,
  mode: "structure" | "content",
  tree: CompactTree | undefined,
  sessionId: string,
  ctx: ExtensionContext,
): ...
```

**问题**: `sessionId: string` 完全可以从 `ctx.sessionManager.getSessionId()` 推导，不需要作为参数传入。

**建议**: 删除 `sessionId` 参数，在内部直接从 `ctx` 获取。

### 8. 异步操作无 loading 反馈

**文件**: `commands.ts` — `/context-status` 命令未显示进度或 loading 状态。

**问题**: 虽然 `context-status` 本身是同步查询，但 `tree-compact` 命令执行时用了 busy-wait，用户只在开始和结束时收到通知，中间 30s+ 无反馈。

**建议**: 在 busy-wait 过程中每 5 秒更新一次状态："正在压缩 (已等待 X 秒)..."

---

## P2 — 安全防御（无发现）

审查了所有文件，未发现：
- 敏感数据泄露（日志/API Key/密码）
- `eval()` 或动态执行
- timing-safe 比较缺失
- `v-html` 使用（不涉及 Vue）

---

## P3 — 细节

### 1. 隐式依赖

**文件**: `segment-tracker.ts` L187-L193

`writeSegmentFile` 是一个 TODO 空函数，但 `handleTurnEnd` 在 L175 处已经调用了它。这创建了一个隐式契约：未来某天必须有文件系统实现来补充此函数。如果后续开发者忘记实现，调用仍然"成功"但什么都不做，属于静默失败模式。

**违背原则**: `taste.md "隐式依赖"` — 函数签名承诺了行为但未履行，形成隐式依赖。

**建议**: 要么移除调用和函数，要么 `@throws` 或抛出明确的 `NotImplementedError` 让遗漏变得可见。

---

## 各文件详细评分

| 文件 | 行数 | P0 | P1 | P3 | 评价 | 质量 |
|------|------|----|----|----|------|------|
| `types.ts` | 73 | 0 | 0 | 0 | 干净，模块边界清晰 | ★★★★★ |
| `segment-tracker.ts` | 213 | 1 | 2 | 1 | Record<string,unknown> 断言 + 死函数 | ★★★☆☆ |
| `tree-compactor.ts` | 337 | 0 | 2 | 0 | 重试逻辑重复，魔法数字 | ★★★★☆ |
| `context-handler.ts` | 293 | 1 | 1 | 0 | 类型重复定义，未用变量 | ★★★☆☆ |
| `recall-tool.ts` | 269 | 1 | 2 | 0 | 包名错误，恢复逻辑重复 | ★★★☆☆ |
| `commands.ts` | 172 | 0 | 2 | 0 | busy-wait，魔法数字 | ★★★★☆ |
| `index.ts` | 149 | 1 | 0 | 0 | 类型/常量重复定义 | ★★★☆☆ |

---

## 建议重构顺序

1. **P0 — import 包名修正**（`recall-tool.ts`，2行改动，风险最低，立刻可做）
2. **P0 — 类型/常量统一到 types.ts**（修改 `types.ts` + `context-handler.ts` + `index.ts`，中等范围）
3. **P0 — Record<string, unknown> + as 断言消除**（修改 `segment-tracker.ts`，需重构类型守卫）
4. **P1 — 删除死函数/未用变量**（`segment-tracker.ts` + `context-handler.ts`，低风险）
5. **P1 — 魔法数字命名**（`tree-compactor.ts` + `commands.ts`，低风险）
6. **P1 — 消除重试逻辑重复**（`tree-compactor.ts`，中等风险，需提取方法）
7. **P1 — busy-wait 改 promise**（`commands.ts`，低风险）
8. **P1 — 消除 recover 逻辑重复**（`recall-tool.ts` + `tree-compactor.ts`，中等范围）

P0 修复后建议重新评分，预期可达 **7.5/10**。
