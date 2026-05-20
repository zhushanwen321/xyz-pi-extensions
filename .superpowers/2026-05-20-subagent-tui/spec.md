---
verdict: pass
---

# Subagent Extension TUI 优化

## 目标

优化定制版 subagent extension（`~/.pi/agent/extensions/subagent/index.ts`）的并行执行体验，解决执行时间不可见、TUI 展示混乱、streaming 更新无节流等问题。

## Background

定制版 subagent extension 在并行执行时存在三个体验问题：
1. 无执行时间信息 — 无法判断哪个 agent 慢、总体耗时多少
2. TUI 展示混乱 — 并行运行时 streaming 更新无节流，collapsed 模式显示过多 tool call 细节
3. 临时文件残留 — SIGKILL 时 finally 不执行，`os.tmpdir()` 下残留 `pi-subagent-*` 目录

此外 `getFinalOutput` 在最后一条 assistant 消息只有 tool_use 时返回空字符串，丢失有效输出。

## Complexity Assessment

**L1（简单）**— 单文件修改，无跨服务依赖，无新存储引擎。

| 维度 | 评估 |
|------|------|
| 领域影响 | 扩展现有渲染逻辑，无新概念 |
| 存储影响 | 仅临时文件路径变更 |
| 数据流 | 同步，短路径 |
| API 影响 | 无新端点 |
| 非功能 | 无特殊要求 |

## 改动范围

仅修改 `/Users/zhushanwen/Code/useful-dev-tools/claude-code-tool/custom-tools/subagent/index.ts`（1754 行）。

不改：
- 颜色区分系统
- agent 发现逻辑（`agents.ts`）
- chain/single 模式的核心执行逻辑
- Pi 官方版（`pi-mono/.../examples/extensions/subagent/`）

## Constraints

- 仅修改 `/Users/zhushanwen/Code/useful-dev-tools/claude-code-tool/custom-tools/subagent/index.ts`（当前 1754 行）
- 不改 agent 发现逻辑（`agents.ts`）、chain/single 模式的核心执行逻辑、Pi 官方版
- 不加颜色区分系统
- Pi TUI 组件：`Container`、`Text`、`Markdown`、`Spacer`，theme 通过 `getMarkdownTheme()` 和 `theme.fg()` 使用
- `Ctrl+O to expand` 是 Pi TUI 内置功能，不需要代码实现

## Acceptance Criteria

- **AC1**：并行执行时，TUI 显示每个 agent 的耗时（格式：234ms / 3.5s / 2m15s）；运行中 agent 显示 elapsed + `last @ HH:MM:SS`
- **AC2**：并行 streaming 更新频率 <= 500ms（`ThrottleState`），单个 agent 完成时强制发送
- **AC3**：并行 collapsed 模式改为表格式汇总（每 agent 一行：状态/耗时/turns/token/成本），不再显示 tool call 细节
- **AC4**：并行模式任意 agent 失败 → 返回结果 `isError: true`，工具 description 包含失败指引
- **AC5**：`getFinalOutput` 能从多条 assistant 消息中找到最后一条包含非空 text 的输出
- **AC6**：临时文件使用固定子目录 `os.tmpdir()/pi-subagent/`，每次执行时清理超过 1 小时的文件
- **AC7**：single/chain 模式 existing 渲染行为不变（collapsed 仍显示 tool call，expanded 仍显示完整细节），仅在标题行加入耗时
- **AC8**：single/chain 模式的 streaming 不加节流（只有并行模式需要，因为并行时多个 agent 同时推送更新）

## Architecture Decision: 数据模型 + 渲染分离

将 `renderResult` 中的"数据准备"和"TUI 渲染"职责分离为三层：

1. **数据模型层** — 纯接口定义（`DurationInfo`、`AgentResultView`、`ParallelSummaryView`）
2. **构建层** — 从原始 `SingleResult` 构建视图模型的纯函数
3. **渲染层** — 只依赖视图模型和 theme 的纯函数

`renderResult` 变成分发器：构建视图模型 -> 调对应渲染函数。

理由：`renderResult` 当前约 200 行，三个模式三条分支。加入时间显示和表格式布局后原地修改会让它难以维护。数据模型和渲染分离后，每层可独立理解和测试。

## 优化项详细设计

### 1. 执行时间记录与显示

**数据模型变更：**

`SingleResult` 接口新增字段：
```typescript
startTime: number;          // Date.now() at spawn
endTime?: number;           // Date.now() at completion
durationMs?: number;        // endTime - startTime
lastActivityTime: number;   // 最后一次收到 message/tool_result 的时间
```

**记录时机：**
- `startTime`：`runSingleAgent` 中 spawn 子进程前设置
- `lastActivityTime`：每次收到 `message_end` 或 `tool_result_end` 事件时更新
- `endTime` / `durationMs`：进程 close 或 abort 时设置

**显示格式：**
- `< 1s`：显示毫秒如 `234ms`
- `1s-60s`：显示一位小数如 `3.5s`
- `> 60s`：显示分秒如 `2m15s`

**运行中 agent 显示 elapsed + 最后活动绝对时间戳：**
```
  agent-b  ⏳  12s  2 turns  last @ 14:32:07
```

**已完成 agent 显示耗时：**
```
  agent-a  ✓   3s  2 turns  ↑5.2k ↓1.1k  $0.0123
```

### 2. Streaming 更新节流

新增 `ThrottleState` 类：
```typescript
class ThrottleState {
    private lastEmitTime = 0;
    private readonly intervalMs: number;
    
    constructor(intervalMs = 500) { this.intervalMs = intervalMs; }
    
    shouldEmit(): boolean {
        const now = Date.now();
        if (now - this.lastEmitTime >= this.intervalMs) {
            this.lastEmitTime = now;
            return true;
        }
        return false;
    }
    
    forceEmit(): void {
        this.lastEmitTime = Date.now();
    }
}
```

**使用位置：**
- `emitParallelUpdate` 中调用 `throttle.shouldEmit()`，返回 false 则跳过 onUpdate
- 单个 agent 完成时调用 `throttle.forceEmit()` 强制发送最终状态
- 每个 `execute` 调用创建独立的 `ThrottleState` 实例

**仅并行模式节流。** single/chain 模式的 `emitUpdate` 不加节流——它们只有一个 agent 推送更新，频率不会造成 TUI 闪烁。

**节流间隔：500ms**

### 3. 并行视图结构优化

#### Collapsed 模式（表格式汇总）

```
✓ parallel 3/3 succeeded (18s)
  agent-a  ✓   3s  2 turns  ↑5.2k ↓1.1k  $0.0123
  agent-b  ✓   5s  3 turns  ↑3.8k ↓0.9k  $0.0087
  agent-c  ✓  10s  5 turns  ↑8.1k ↓2.3k  $0.0184
  Total: ↑17.1k ↓4.3k  $0.0394  (Ctrl+O to expand)
```

运行中：
```
⏳ parallel 1/3 done, 2 running (8s elapsed)
  agent-a  ✓   3s  2 turns  ↑5.2k ↓1.1k  $0.0123
  agent-b  ⏳   8s  1 turns  last @ 14:32:05
  agent-c  ⏳   8s  0 turns  last @ 14:31:58
```

**关键变化：** 并行 collapsed 模式不再显示 tool call 细节，只显示汇总行。每个 agent 一行，包含状态/耗时/turns/token/成本。

> **注意：** single 和 chain 的 collapsed 模式保留当前行为（显示 tool call 细节），仅并行 collapsed 改为表格式汇总。

#### Expanded 模式（保留细节）

每个 agent 展示完整信息：task 描述、tool call 列表、最终输出、usage 统计、耗时。结构与当前类似，但在 agent 标题行加入耗时。

```
✓ parallel 3/3 succeeded (18s)

─── agent-a ✓ 3s  ↑5.2k ↓1.1k ───
Task: 分析 src/proxy 目录的调用链路
→ read src/proxy/handler.ts
→ grep /authenticate/ in src/proxy/

[最终输出 markdown]

─── agent-b ✓ 5s  ↑3.8k ↓0.9k ───
...
```

### 4. 错误聚合

**规则：** 并行模式中任意一个 agent 失败，返回结果的 `isError` 设为 `true`。

**工具 description 更新：** 在 description 末尾追加：
```
IMPORTANT for parallel mode: isError=true means at least one task failed.
Check each agent's individual status to identify which failed and decide
whether to retry, skip, or handle. Do not treat partial failure as total failure.
```

**最终 content 文本中明确标注失败：**
```
✗ parallel 1/3 failed (18s)
  agent-a  ✓   3s  2 turns  ↑5.2k ↓1.1k
  agent-b  ✗   5s  3 turns  ↑3.8k ↓0.9k  Error: exit code 1
  agent-c  ✓  10s  5 turns  ↑8.1k ↓2.3k
  Total: ↑17.1k ↓4.3k  $0.0394
```

### 5. `getFinalOutput` 改善

**当前逻辑：** 从最后一条消息往前找，取第一个 assistant 消息的第一个 text part。

**问题：** 如果最后一条 assistant 只有 tool_use 没有 text，返回空字符串，即使前面的 assistant 消息中有有效输出。

**改为：** 从最后一条消息往前搜索所有 assistant 消息，取第一条包含非空 text 的 assistant 的 text content。空字符串不匹配（`text.trim()` 检查）。

```typescript
function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text" && part.text.trim()) return part.text;
            }
        }
    }
    return "";
}
```

### 6. 临时文件清理加固

**当前问题：** 用 `os.tmpdir()` 下随机目录 + `finally` 清理，SIGKILL 时 finally 不执行，残留文件。

**改为：**
- 固定子目录 `os.tmpdir()/pi-subagent/`
- 每次执行 subagent 工具时，先扫描该目录，删除超过 1 小时的文件
- 写入时用 `withFileMutationQueue` 保持不变

```typescript
const TEMP_SUBDIR = "pi-subagent";
const MAX_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

function getTempDir(): string {
    return path.join(os.tmpdir(), TEMP_SUBDIR);
}

function cleanupOldTempFiles(): void {
    const dir = getTempDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
    }
    const now = Date.now();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > MAX_TEMP_AGE_MS) fs.unlinkSync(filePath);
        } catch { /* ignore */ }
    }
}
```

`writePromptToTempFile` 改为写入 `getTempDir()` 下，不再每次创建新目录。

## 视图模型定义

```typescript
interface DurationInfo {
    startTime: number;
    endTime?: number;
    durationMs?: number;
    lastActivityTime: number;
}

interface AgentResultView {
    name: string;
    source: string;
    status: "running" | "succeeded" | "failed";
    duration: DurationInfo;
    turns: number;
    tokens: { input: number; output: number };
    cost: number;
    model?: string;
    task: string;
    toolCalls: DisplayItem[];
    finalOutput: string;
    errorMessage?: string;
    stopReason?: string;
}

interface ParallelSummaryView {
    total: number;
    succeeded: number;
    failed: number;
    running: number;
    isDone: boolean;
    agents: AgentResultView[];
    aggregateTokens: { input: number; output: number };
    aggregateCost: number;
    totalDurationMs?: number; // max(agents.duration.durationMs)，即 wall-clock 总耗时（所有 agent 同时启动，所以等于最慢 agent 的耗时）
}
```

## 新增函数清单

| 函数 | 职责 |
|------|------|
| `formatDuration(ms: number): string` | ms -> 人可读时间（234ms / 3.5s / 2m15s） |
| `formatTimestamp(epochMs: number): string` | Date.now() -> HH:MM:SS |
| `buildAgentResultView(r: SingleResult, now?: number): AgentResultView` | SingleResult -> 视图模型 |
| `buildParallelSummaryView(results: SingleResult[]): ParallelSummaryView` | 多个结果 -> 汇总视图模型 |
| `renderAgentRow(view: AgentResultView, theme): string` | 单个 agent collapsed 行 |
| `renderAgentDetail(view: AgentResultView, theme): Container \| Text` | 单个 agent expanded（chain 的每个 step 也复用此函数） |
| `renderParallelTable(view: ParallelSummaryView, theme): Text` | 并行 collapsed 表格 |
| `renderParallelDetail(view: ParallelSummaryView, theme): Container` | 并行 expanded详情 |

| `cleanupOldTempFiles(): void` | 清理过期临时文件 |
| `getTempDir(): string` | 返回固定临时目录路径 |

> **注意：** chain 模式不需要独立的渲染函数。expanded 时循环调 `renderAgentDetail`（加 step 编号前缀），collapsed 时保留当前行为（显示 tool call 细节 + 耗时），不使用 `renderAgentRow`。chain 和 single 的渲染差异仅在分发器中处理。

## 不变的项

- `mapWithConcurrencyLimit` — JS 单线程下无竞态问题，保持现状
- chain/single 模式的渲染也走视图模型，但结构简单，只需在现有基础上加时间显示
- `agents.ts` — 不碰
- agent 发现、权限校验、project agent 确认流程 — 不碰
