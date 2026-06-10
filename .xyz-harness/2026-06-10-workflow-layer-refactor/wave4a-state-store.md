# Wave 4a: state-store.ts 提取分析

## 源码定位

| 代码 | 文件 | 行号 |
|------|------|------|
| `persistState()` method | `src/orchestrator.ts` | L966-L982 |
| `reconstructState()` local fn | `src/index.ts` | L140-L185 |
| `orch.persistState()` 外部调用 (1) | `src/index.ts` | L421 |
| `orch.persistState()` 外部调用 (2) | `src/index.ts` | L452 |
| `reconstructState()` 调用 (1) | `src/index.ts` | L207 |
| `reconstructState()` 调用 (2) | `src/index.ts` | L251 |
| `this.persistState()` 内部调用 x13 | `src/orchestrator.ts` | L258,275,324,373,399,444,481,630,754,824,850,877,915 |
| `persistState: () => this.persistState()` 回调 x3 | `src/orchestrator.ts` | L292,365,820 |

## state-store.ts 完整代码

**Export 列表**（函数名 + 签名）:
- `persistState(pi: ExtensionAPI, sessionDir: string, instances: Map<string, WorkflowInstance>): Promise<void>`
- `reconstructState(ctx: ExtensionContext): Promise<Map<string, WorkflowInstance>>`

**Import 列表**:
- `fs` from `"node:fs"`
- `path` from `"node:path"`
- `ExtensionAPI`, `ExtensionContext` from `"@mariozechner/pi-coding-agent"`
- `createInstance`, `deserializeInstance`, `serializeInstance`, `type WorkflowInstance` from `"../domain/state.js"`

```typescript
/**
 * State Store — Workflow instance persistence via JSONL files.
 *
 * Design:
 *   - Each workflow instance gets a dedicated JSONL file under
 *     <sessionDir>/workflow-state/<runId>.jsonl
 *   - persistState uses **rewrite mode** (writeFile overwrite) — always
 *     writes the latest complete snapshot, replacing previous content.
 *   - A "workflow-state-link" pointer entry is appended to the session
 *     JSONL via pi.appendEntry on every persist.
 *   - reconstructState reads pointer entries from session JSONL, then
 *     reads the (single-line) state file for each run.
 *
 * Rewrite mode eliminates the GC problem: no historical entries accumulate
 * in the state file, so there's no need to splice old entries. The file
 * always contains exactly one line — the latest snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  createInstance,
  deserializeInstance,
  serializeInstance,
  type WorkflowInstance,
} from "../domain/state.js";

// ── Persist ───────────────────────────────────────────────────

/**
 * Flush all workflow instances to external JSONL files.
 *
 * For each instance: overwrites `<sessionDir>/workflow-state/<runId>.jsonl`
 * with the current serialized snapshot (rewrite mode), then appends a
 * workflow-state-link pointer entry via pi.appendEntry.
 */
export async function persistState(
  pi: ExtensionAPI,
  sessionDir: string,
  instances: Map<string, WorkflowInstance>,
): Promise<void> {
  for (const instance of instances.values()) {
    const filePath = path.join(sessionDir, "workflow-state", `${instance.runId}.jsonl`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Rewrite mode: overwrite the file with the latest complete snapshot.
    // This avoids unbounded growth — no GC needed because old state is discarded.
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(serializeInstance(instance)) + "\n",
      "utf8",
    );
    pi.appendEntry("workflow-state-link", {
      runId: instance.runId,
      path: filePath,
      updatedAt: new Date().toISOString(),
    });
  }
}

// ── Reconstruct ───────────────────────────────────────────────

/**
 * Reconstruct workflow instances from session JSONL pointer entries.
 *
 * Reads workflow-state-link entries to locate state files, then loads
 * the latest snapshot from each file. With rewrite mode, each file
 * contains exactly one line (the most recent snapshot).
 */
export async function reconstructState(
  ctx: ExtensionContext,
): Promise<Map<string, WorkflowInstance>> {
  const instances = new Map<string, WorkflowInstance>();
  try {
    const entries = ctx.sessionManager.getEntries();
    const pointers = new Map<string, { path: string }>();

    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      const custom = entry as unknown as { customType?: string; data?: unknown };
      if (custom.customType !== "workflow-state-link") continue;
      const data = custom.data as { runId?: string; path?: string } | undefined;
      if (data?.runId && data?.path) {
        // Last pointer wins — same runId may have multiple pointer entries
        // (one per persistState call), but they all point to the same file
        // which is always overwritten with the latest state.
        pointers.set(data.runId, { path: data.path });
      }
    }

    for (const [runId, pointer] of pointers) {
      try {
        const content = await fs.promises.readFile(pointer.path, "utf8");
        const lines = content.split("\n").filter((l) => l.trim());
        // With rewrite mode, the file has exactly one line.
        // Read the last line for robustness (handles edge cases like
        // partial writes or pre-migration append-mode files).
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const parsed = JSON.parse(lastLine) as Parameters<typeof deserializeInstance>[0];
          const instance = deserializeInstance(parsed);
          instances.set(instance.runId, instance);
        }
      // eslint-disable-next-line taste/no-silent-catch
      } catch {
        ctx.ui.notify(`WARN: missing or corrupt state for ${runId}`, "warning");
        // Create a state_lost placeholder so the user can see the run existed
        // but its external state file is unreadable.
        instances.set(runId, createInstance({
          runId,
          name: `(state lost) ${runId}`,
          worker: "(unknown)",
          status: "state_lost",
        }));
      }
    }
  // eslint-disable-next-line taste/no-silent-catch
  } catch {
    // If getEntries fails, return empty map
  }
  return instances;
}
```

## orchestrator.ts 修改清单

### 需要删除的方法/代码段

**整个 `persistState()` 方法体** (L966-L982)，替换为委托：

```typescript
// ── 修改前 ──────────────────────────────────────
  /**
   * Flush the current state to external JSONL files + pointer entries.
   *
   * For each instance: writes a JSONL file under <sessionDir>/workflow-state/<runId>.jsonl
   * and appends a workflow-state-link pointer entry via pi.appendEntry.
   */
  async persistState(): Promise<void> {
    for (const instance of this.instances.values()) {
      const filePath = path.join(this.sessionDir, "workflow-state", `${instance.runId}.jsonl`);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(
        filePath,
        JSON.stringify(serializeInstance(instance)) + "\n",
        "utf8",
      );
      this.pi.appendEntry("workflow-state-link", {
        runId: instance.runId,
        path: filePath,
        updatedAt: new Date().toISOString(),
      });
    }
  }

// ── 修改后 ──────────────────────────────────────
  /**
   * Flush the current state to external JSONL files (delegates to state-store).
   * Kept as instance method to preserve public API used by index.ts.
   */
  async persistState(): Promise<void> {
    await persistInstances(this.pi, this.sessionDir, this.instances);
  }
```

### Import 变更

```typescript
// ── 修改前 ──────────────────────────────────────
import {
  type AgentResult as StateAgentResult,
  createInstance as createStateInstance,
  type ExecutionTraceNode,
  isTerminal,
  serializeInstance,               // ← 删除
  transitionStatus,
  type WorkflowBudget,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";

// ── 修改后 ──────────────────────────────────────
import {
  type AgentResult as StateAgentResult,
  createInstance as createStateInstance,
  type ExecutionTraceNode,
  isTerminal,
  transitionStatus,
  type WorkflowBudget,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";
import { persistState as persistInstances } from "./infra/state-store.js";
```

### 内部调用点（无需修改）

所有 13 处 `this.persistState()` 和 3 处 `persistState: () => this.persistState()` 回调保持不变——方法签名未变，只是实现委托到了 `state-store.ts`。

### 外部调用点（无需修改）

index.ts 中的 `orch.persistState()` 调用（L421, L452）保持不变。

### 可选清理

删除 `serializeInstance` 后，`orchestrator.ts` 不再直接使用 `fs.promises.mkdir` / `fs.promises.appendFile`。`fs` 仍被用于：
- `fs.readFileSync` (L199)
- `fs.existsSync` (constructor)

所以 `import * as fs from "node:fs"` 保留不变。

## index.ts 修改清单

### 需要删除的函数/代码段

**整个 `reconstructState` 本地函数** (L140-L185):

```typescript
// ── 删除 ──────────────────────────────────────
  async function reconstructState(ctx: ExtensionContext): Promise<Map<string, WorkflowInstance>> {
    const instances = new Map<string, WorkflowInstance>();
    try {
      const entries = ctx.sessionManager.getEntries();
      // ... (46 lines total)
    } catch {
      // If getEntries fails, return empty map
    }
    return instances;
  }
```

### Import 变更

```typescript
// ── 修改前 ──────────────────────────────────────
import {
  createInstance,        // ← 删除
  deserializeInstance,   // ← 删除
  isTerminal,
  transitionStatus,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";

// ── 修改后 ──────────────────────────────────────
import {
  isTerminal,
  transitionStatus,
  type WorkflowInstance,
  type WorkflowStatus,
} from "./domain/state.js";
import { reconstructState } from "./infra/state-store.js";
```

### reconstructState 调用点（无需修改）

```typescript
// L207 — session_start handler（无需修改）
const instances = await reconstructState(ctx);

// L251 — session_tree handler（无需修改）
const instances = await reconstructState(ctx);
```

函数签名完全一致（`ctx: ExtensionContext → Promise<Map<string, WorkflowInstance>>`），调用点无需改动。

### fs import 保留说明

`fs` namespace import 保留——`fs.readFileSync` 在 lint tool (L795) 使用。
`readFileSync` named import 保留——在 tool_call handler (L584) 使用。

## 关键设计变更总结

| 维度 | 修改前 (append 模式) | 修改后 (rewrite 模式) |
|------|---------------------|---------------------|
| 写入方式 | `fs.promises.appendFile` — 每次追加一行 | `fs.promises.writeFile` — 每次覆盖整个文件 |
| 文件内容 | N 行历史快照，无限增长 | 恰好 1 行（最新快照） |
| GC 需求 | 需要自行 splice 旧 entries | 不需要 GC（覆盖即丢弃旧状态） |
| 读取策略 | 遍历所有行，最后一个实例 wins | 读取最后一行（即唯一行） |
| 向后兼容 | — | `reconstructState` 仍读最后一行，兼容迁移前的旧文件 |

## 受影响的文件清单

| 文件 | 改动类型 | 改动量 |
|------|---------|--------|
| `src/infra/state-store.ts` | **新建** | ~100 行 |
| `src/orchestrator.ts` | 删除方法体 + 替换为委托 + 调整 import | ~20 行变更 |
| `src/index.ts` | 删除本地函数 + 调整 import | ~50 行删除 + 2 行新增 |
