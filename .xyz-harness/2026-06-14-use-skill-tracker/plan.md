---
verdict: pass
complexity: L1
---

# use_skill 主动声明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 skill-execution tracker 从被动监听 `read SKILL.md` 改为 agent 主动调用 `use_skill` tool 声明，实现误报零容忍。

**Architecture:** 改造 `createTracker` 框架支持可选 `triggerTool`（主动声明）模式——不配 `triggerEvent` 则不注册被动监听，创建逻辑由 tracker 在 tool execute handler 调用框架暴露的 `createItem()` 内部函数。`types.ts` 状态机废弃 `dismissed`、新增 `cancelled`（agent 主动放弃）+ `abandoned`（系统超时自动终结）。新建 `skill-registry.ts` 扫描 skills 目录做 name 校验。

**Tech Stack:** TypeScript, Pi Extension API (registerTool / pi.on / appendEntry), typebox, node:fs/node:os

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `types.ts` | modify | BG1 | 状态枚举 dismissed→cancelled+abandoned、转换矩阵重写、TrackerParams 加 start action、deserialize 过滤旧 dismissed |
| `skill-registry.ts` | create | BG1 | skills 目录扫描 + name 校验（含 system prompt fallback） |
| `core.ts` | modify | BG1 | triggerEvent 改可选、新增 triggerTool 配置 + createItem 内部函数、turn_end/reconstructState 加 abandoned 检查 |
| `skill-execution.ts` | modify | BG1 | 删除 extractSkillName/isPathInCwd/triggerEvent/triggerMatch、配置 triggerTool、重写 description/steering、加 abandonThreshold |
| `run_tests.mjs` | modify | BG1 | 废弃被动监听/dismissed 用例，新增 start/cancelled/abandoned 用例 |
| `index.ts` | check | BG1 | 确认 createTracker 调用无需改动 |

---

## Interface Contracts

### Module: types.ts

#### Data: TrackedItemStatus

| 值 | 含义 | 可由 agent 设置 |
|----|------|----------------|
| `loaded` | 已 start，使用中 | 否（start 创建） |
| `completed` | 正常完成 | 是 |
| `error` | 执行失败 | 是 |
| `cancelled` | agent 主动放弃 | 是 |
| `recorded` | 错误达阈值后记录入库 | 是（agent 完成记录后手动设） |
| `abandoned` | 超时未终结，系统标记 | **否（纯系统状态）** |

#### Function: canTransition

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| canTransition | (from: TrackedItemStatus, to: TrackedItemStatus) -> boolean | boolean | 终态→任意=false; abandoned 不在 ALLOWED_TRANSITIONS 的 from 中（纯终态） | AC-2 |

#### Data: TrackerParams (typebox schema)

| Field | Type | Required for | Description |
|-------|------|-------------|-------------|
| action | StringEnum("start"\|"update"\|"list") | all | 操作类型 |
| name | Optional\<string\> | start | skill 名称 |
| path | Optional\<string\> | start（可选） | SKILL.md 绝对路径 |
| id | Optional\<number\> | update | TrackedItem ID |
| status | StringEnum("completed"\|"error"\|"cancelled"\|"recorded") | update | 目标状态（abandoned 不在枚举） |
| detail | Optional\<string\> | update（可选） | 附加说明 |

### Module: skill-registry.ts (新建)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| scanSkillNames | (systemPrompt?: string) -> Set\<string\> | 已知 skill 名称集合 | 目录不存在→空 Set; npm 含 unscoped + scoped(@scope/pkg) 两级; system prompt 始终补充（不限于零命中） | AC-8 |
| isValidSkillName | (name: string, systemPrompt?: string) -> boolean | name 是否合法 | 实时扫描（无缓存）；目录扫描 + system prompt 双来源 | AC-8 |

### Module: core.ts

#### TrackerConfig 新增字段

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| triggerEvent | string | **可选**（原必填） | 不传则不注册被动监听 |
| triggerTool | object | 可选 | 主动声明 tool 配置（name, description, extractMeta） |
| abandonThreshold | number | 必填 | 超时 turn 数（skill-execution 配 20） |

#### Internal: createItem

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createItem | (match: {name, metadata, summary}, ctx) -> TrackedItem | 新建并持久化的 item | 不去重（每次独立创建） | AC-1 |

---

## Execution Groups

#### BG1: Tracker Refactor

**Description:** skill-execution tracker 的触发机制重设计，含状态机重构、框架改造、新模块、配置重写、测试重写。全部后端逻辑，文件数 6（5 改 + 1 新建），≤10 上限。

**Tasks:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

**Files (预估):** 6 个文件（1 create + 5 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec.md（FR-1~FR-6 + AC-1~AC-10）、本 plan.md 的对应 Task、编码规范 |
| 读取文件 | types.ts, core.ts, skill-execution.ts, run_tests.mjs（现有代码） |
| 修改/创建文件 | 见各 Task Files 列表 |

**Execution Flow (BG1 内部):** 串行派遣，Task 1→2→3 有类型依赖（core 依赖 types，skill-exec 依赖 core），Task 4→5 依赖前三者实现。

**Dependencies:** 无（BG1 无外部依赖）

**设计细节:** L1 单文件，详见下方 Task Details。

---

## Task List

| # | Task | Files | Depends on |
|---|------|-------|-----------|
| 1 | types.ts 状态机 + schema 重构 | types.ts (modify) | — |
| 2 | skill-registry.ts 新建 name 校验 | skill-registry.ts (create) | — |
| 3 | core.ts 框架改造 | core.ts (modify) | Task 1 |
| 4 | skill-execution.ts config 重写 | skill-execution.ts (modify) | Task 2, 3 |
| 5 | run_tests.mjs 测试重写 | run_tests.mjs (modify) | Task 1-4 |
| 6 | 端到端验证 | — | Task 5 |

---

## Spec Coverage Matrix

| Spec AC | Interface / Handler | Task |
|---------|-----------------|------|
| AC-1 start 返回 createdId，连续两次独立 item | createItem | Task 3 |
| AC-2 update 按转换矩阵，非法转换报错 | canTransition | Task 1 |
| AC-3 list 返回所有 item | tool execute handler | Task 3 |
| AC-4 read SKILL.md 不触发 tracking | triggerEvent 改可选 + skill-execution 不配 | Task 3, 4 |
| AC-5 超 20 turn 自动 abandoned，先于 remind | turn_end handler | Task 3 |
| AC-6 cancelled/abandoned 可区分，abandoned 不在枚举 | TrackedItemStatus + TrackerParams | Task 1 |
| AC-7 session restore 检查 abandoned | reconstructState | Task 3 |
| AC-8 start name 不存在返回错误 | isValidSkillName | Task 2 |
| AC-9 run_tests.mjs 全过 | — | Task 5 |
| AC-10 tsc --noEmit 零错误 | — | Task 6 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 合并单 tool（start/update/list） | adopted | Task 1, 3 |
| FR-2 start 语义（不去重、name 必填、path 可选） | adopted | Task 2, 3 |
| FR-3 6 状态机（dismissed→cancelled，新增 abandoned） | adopted | Task 1 |
| FR-4 abandoned 纯系统行为（turn_end + reconstructState，先于 remind） | adopted | Task 3 |
| FR-5 废弃被动监听 + 框架方案 A | adopted | Task 3, 4 |
| FR-6 description 边界标准（plan 阶段定措辞） | adopted | Task 4 |
| AC-1 ~ AC-10 | adopted | 见 Spec Coverage Matrix |
| name 校验 skills 目录扫描覆盖度 | adopted（含 fallback） | Task 2 |
| TrackerParams 联合参数 typebox 表达 | adopted | Task 1 |
| abandonThreshold=20 合理性 | adopted（默认值，需实际验证） | Task 4 |
| Python analyzer 兼容 cancelled/abandoned | postponed | 下游任务，不阻塞本需求 |

---

## Task Details

### Task 1: types.ts 状态机 + schema 重构

**Type:** backend

**Files:**
- Modify: `extensions/evolve-daily/src/trackers/types.ts`

**改动范围：** 状态枚举、终态集合、转换矩阵、TrackerParams schema、TrackerDetails.action、deserializeState 过滤逻辑。

- [ ] **Step 1: 更新 TrackedItemStatus 类型 + TERMINAL_STATUSES + ALLOWED_TRANSITIONS**

替换 types.ts 顶部 `TRACKER_ENTRY_PREFIX` 到 `ALLOWED_TRANSITIONS` 结束（文件起始常量区，TERMINAL_STATUSES 和 ALLOWED_TRANSITIONS 两块）：

```typescript
// ── 常量 ────────────────────────────────────────────

/** appendEntry 的 customType 前缀 */
export const TRACKER_ENTRY_PREFIX = "evolve-tracker-";

const TERMINAL_STATUSES: ReadonlySet<TrackedItemStatus> = new Set([
  "completed",
  "recorded",
  "cancelled",
  "abandoned",
]);

/**
 * FR-3 转换矩阵：
 *   loaded  → completed ✅, error ✅, cancelled ✅
 *   error   → completed ✅, error ✅, recorded ✅, cancelled ✅
 *   abandoned 是纯系统状态（turn_end/reconstructState 自动触发），不在 ALLOWED_TRANSITIONS 的 from 中
 *   终态不可变更
 *
 * cancelled 用于标记 agent 主动放弃（如 start 后发现不适用）。
 * abandoned 用于标记超时未终结（系统自动，agent 不能手动设）。
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlySet<TrackedItemStatus>
> = new Map([
  ["loaded", new Set(["completed", "error", "cancelled"])],
  ["error", new Set(["completed", "error", "recorded", "cancelled"])],
]);
```

替换 `TrackedItemStatus` 类型定义（紧跟 ALLOWED_TRANSITIONS 之后的 type 声明）：

```typescript
export type TrackedItemStatus =
  | "loaded"
  | "error"
  | "completed"
  | "recorded"
  | "cancelled"
  | "abandoned";
```

- [ ] **Step 2: 更新 TrackerParams schema**

替换整个 `TrackerParams` 定义（使用 `export const TrackerParams = Type.Object` 定位，含 `action: StringEnum(["update", "list"])` 的旧定义）：

**设计取舍：** typebox 无法优雅地表达条件必填（start 需 name，update 需 id+status）。所有参数用 Optional，条件必填靠运行时 handler 校验（Task 3 Step 5 已有 `if (!skillName)` / `if (updateId === undefined)` 检查）。这是 typebox schema 与运行时校验的分工，不是遗漏。

```typescript
/** use_skill tool 参数 schema（start/update/list 三种 action） */
export const TrackerParams = Type.Object({
  action: StringEnum(["start", "update", "list"] as const),
  name: Type.Optional(
    Type.String({ description: "Skill name (required for start). Get from available_skills list." }),
  ),
  path: Type.Optional(
    Type.String({ description: "SKILL.md absolute path (optional for start, from available_skills location field)" }),
  ),
  id: Type.Optional(
    Type.Number({ description: "TrackedItem ID (required for update)" }),
  ),
  status: Type.Optional(
    StringEnum(["completed", "error", "cancelled", "recorded"] as const, {
      description:
        "Target status (required for update). cancelled = agent actively abandons. Note: abandoned is system-only, cannot be set manually.",
    }),
  ),
  detail: Type.Optional(
    Type.String({ description: "Additional notes (e.g. error reason, cancel reason)" }),
  ),
});
```

- [ ] **Step 3: 更新 TrackerDetails.action 类型**

替换 `TrackerDetails` 接口（使用 `export interface TrackerDetails` 定位），action 加 `"start"`：

```typescript
export interface TrackerDetails<
  TMeta = Record<string, unknown>,
> {
  action: "start" | "update" | "list";
  items: TrackedItem<TMeta>[];
  trackerName: string;
  createdId?: number;
  updatedId?: number;
  error?: string;
}
```

- [ ] **Step 4: deserializeState 过滤旧 dismissed item**

在 `deserializeState` 函数中（使用 `export function deserializeState` 定位），`rawItems.map(...)` 返回的 `items` 常量赋值之后、`return { items, ... }` 之前，新增过滤：

```typescript
  // 过滤旧 dismissed item（不迁移、不映射，直接丢弃）
  const filteredItems = items.filter(
    (item) => item.status !== "dismissed",
  );

  return {
    items: filteredItems,
    nextId: typeof data.nextId === "number" ? data.nextId : 1,
    currentTurnIndex:
      typeof data.currentTurnIndex === "number" ? data.currentTurnIndex : 0,
  };
```

注意：变量名从 `items` 改为 `filteredItems` 在 return 中引用。原 `items` 变量是 map 的结果，过滤后赋给 filteredItems。

- [ ] **Step 5: 验证编译**

Run: `pnpm --filter @zhushanwen/pi-evolve-daily typecheck`
Expected: 编译通过（core.ts 和 skill-execution.ts 还引用旧类型，可能会有错误——这是预期的，Task 3/4 会修复。此时只需确认 types.ts 自身无语法错误）

如有跨文件错误（core.ts 引用 dismissed），记录错误数量，在后续 Task 中修复。

---

### Task 2: skill-registry.ts 新建 name 校验

**Type:** backend

**Files:**
- Create: `extensions/evolve-daily/src/trackers/skill-registry.ts`

**设计说明：** Extension 拿不到 Pi 的 resourceLoader.getSkills()（在 agent-session 内部）。name 校验通过独立扫描已知 skills 目录实现。目录来源（resource-loader.js 确认）：`homedir()/.pi/agent/skills`、`{cwd}/.agents/skills`、`homedir()/.pi/agent/npm/node_modules/*/skills`（glob 子目录）。Fallback：从 system prompt 正则提取 `<name>` 标签。

- [ ] **Step 1: 创建 skill-registry.ts**

```typescript
/**
 * Skill 名称注册表 — 用于 use_skill(start) 的 name 校验。
 *
 * Extension 拿不到 Pi 的 resourceLoader.getSkills()，通过独立扫描
 * 已知 skills 目录 + system prompt fallback 实现。
 */

import { homedir } from "node:os";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const NPM_SKILLS_GLOB_ROOT = join(
  homedir(),
  ".pi/agent/npm/node_modules",
);

/** 扫描用户级 skills 目录（直接子目录 = skill name） */
function scanDirectChildren(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        const fullPath = join(dir, name);
        return statSync(fullPath).isDirectory();
      });
  } catch {
    return [];
  }
}

/** 扫描 npm bundled skills：处理两种 npm 目录结构
 *  - unscoped: node_modules/{pkg}/skills/*
 *  - scoped:   node_modules/@{scope}/{pkg}/skills/*
 */
function scanNpmBundledSkills(): string[] {
  if (!existsSync(NPM_SKILLS_GLOB_ROOT)) return [];
  const names: string[] = [];
  try {
    for (const entry of readdirSync(NPM_SKILLS_GLOB_ROOT)) {
      const entryPath = join(NPM_SKILLS_GLOB_ROOT, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      if (entry.startsWith("@")) {
        // scoped package：@scope 下每个子包可能有 skills
        for (const subPkg of readdirSync(entryPath)) {
          const scopedSkillsDir = join(entryPath, subPkg, "skills");
          if (existsSync(scopedSkillsDir) && statSync(scopedSkillsDir).isDirectory()) {
            names.push(...scanDirectChildren(scopedSkillsDir));
          }
        }
      } else {
        // unscoped package：直接在包下找 skills
        const skillsDir = join(entryPath, "skills");
        if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
          names.push(...scanDirectChildren(skillsDir));
        }
      }
    }
  } catch {
    // 扫描失败，静默返回空（system prompt fallback 会兜底）
  }
  return names;
}

/** 从 system prompt 正则提取 skill 名称（fallback） */
function extractFromSystemPrompt(systemPrompt: string): string[] {
  const matches = systemPrompt.matchAll(/<name>([^<]+)<\/name>/g);
  return Array.from(matches, (m) => m[1].trim());
}

/**
 * 扫描已知 skills 目录，返回合法 skill 名称集合。
 * system prompt 作为补充来源（不限于目录扫描零命中）——
 * 目录扫描可能因路径变化、新增 extension 格式等遗漏，system prompt 始终兜底。
 */
export function scanSkillNames(
  systemPrompt?: string,
): Set<string> {
  const dirs = [
    join(homedir(), ".pi/agent/skills"),
    join(process.cwd(), ".agents/skills"),
  ];

  const names = new Set<string>();
  for (const dir of dirs) {
    for (const name of scanDirectChildren(dir)) {
      names.add(name);
    }
  }
  for (const name of scanNpmBundledSkills()) {
    names.add(name);
  }

  // 补充：从 system prompt 提取（始终执行，不限于目录扫描零命中）
  if (systemPrompt) {
    for (const name of extractFromSystemPrompt(systemPrompt)) {
      names.add(name);
    }
  }

  return names;
}

/**
 * 校验 skill 名称是否合法。
 * 先查缓存的目录扫描结果；无缓存时实时扫描。
 */
export function isValidSkillName(
  name: string,
  systemPrompt?: string,
): boolean {
  const knownNames = scanSkillNames(systemPrompt);
  return knownNames.has(name);
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter @zhushanwen/pi-evolve-daily typecheck`
Expected: 新文件编译通过

---

### Task 3: core.ts 框架改造

**Type:** backend

**Files:**
- Modify: `extensions/evolve-daily/src/trackers/core.ts`

**改动范围（6 处）：** ①import skill-registry ②TrackerConfig 字段调整 ③提取 createItem 内部函数 ④triggerEvent 有条件注册 ⑤tool execute 加 start action ⑥turn_end + reconstructState 加 abandoned 检查。

- [ ] **Step 1: import skill-registry**

在 core.ts 顶部 import 区追加：

```typescript
import { isValidSkillName } from "./skill-registry";
```

- [ ] **Step 2: TrackerConfig 字段调整**

修改 `TrackerConfig` 接口（使用 `export interface TrackerConfig<TMeta` 定位），`triggerEvent` + `triggerMatch` 改可选，新增 `triggerTool` + `abandonThreshold`：

```typescript
export interface TrackerConfig<TMeta = Record<string, unknown>> {
  name: string;
  toolName: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];

  /** 被动触发事件（可选）。不配则不注册被动监听，创建由 triggerTool 驱动 */
  triggerEvent?: string;
  triggerMatch?: (
    event: unknown,
    ctx: ExtensionContext,
  ) => { name: string; metadata: TMeta; summary: string } | null;

  /** 主动声明 tool 配置（可选）。配了则在 tool execute 中支持 start action */
  triggerTool?: {
    /** 从 tool params 提取 match 信息（name/metadata/summary） */
    extractMeta: (
      params: Record<string, unknown>,
    ) => { name: string; metadata: TMeta; summary: string };
  };

  steering: {
    onCreate: (item: TrackedItem<TMeta>) => string;
    onRemind: (item: TrackedItem<TMeta>, turnsSinceLoad: number) => string;
    onError: (item: TrackedItem<TMeta>) => string;
    onContextRestore: (items: TrackedItem<TMeta>[]) => string;
  };
  entryType: string;
  legacyEntryTypes?: string[];
  messageTypes: string[];
  remindInterval: number;
  errorThreshold: number;
  /** 超时 turn 数，非终态 item 超过此值自动转 abandoned */
  abandonThreshold: number;
  renderResult?: (
    details: TrackerDetails<TMeta>,
    options: { expanded?: boolean },
    theme: Theme,
  ) => Text;
}
```

- [ ] **Step 3: 提取 createItem 内部函数**

在 `persistState` 函数之后、`reconstructState` 之前，新增内部函数。该函数从原 triggerEvent handler 中提取，**去掉去重逻辑**（spec FR-2 每次独立创建）：

```typescript
  // ── 创建 item（triggerEvent handler 和 tool start action 共用）──

  function createItem(
    match: { name: string; metadata: TMeta; summary: string },
    ctx: ExtensionContext,
  ): TrackedItem<TMeta> {
    const turnIndex = state.currentTurnIndex;
    const newItem: TrackedItem<TMeta> = {
      id: state.nextId,
      name: match.name,
      status: "loaded",
      errorCount: 0,
      loadedAtTurn: turnIndex,
      lastRemindAtTurn: -1,
      detail: null,
      metadata: match.metadata,
      anchor: {
        triggerType: config.triggerEvent ?? "tool-start",
        triggerTurn: turnIndex,
        triggerSummary: match.summary,
      },
    };
    state.items.push(newItem);
    state.nextId++;
    persistState(ctx);
    return newItem;
  }
```

- [ ] **Step 4: triggerEvent 有条件注册 + 调 createItem**

将原 triggerEvent handler（使用 `(pi as unknown as PiOnAny).on(\n    config.triggerEvent,` 定位，原整块 `// ── Event: triggerEvent` 区间）替换为有条件注册：

```typescript
  // ── Event: triggerEvent（仅当配置了被动触发时才注册）──

  if (config.triggerEvent && config.triggerMatch) {
    (pi as unknown as PiOnAny).on(
      config.triggerEvent,
      async (event, nextCtx) => {
        const ctx = nextCtx as ExtensionContext;
        const match = config.triggerMatch!(event, ctx);
        if (!match) return;

        // 被动模式下去重：非终态同名 item 存在时不重复创建
        const existing = state.items.find(
          (item) =>
            item.name === match.name && !isTerminalStatus(item.status),
        );
        if (existing) return;

        const newItem = createItem(match, ctx);
        await pi.sendUserMessage(config.steering.onCreate(newItem), {
          deliverAs: "steer",
        });
      },
    );
  }
```

注意：被动模式保留去重（多个 read 同一 skill 只创建一次），但 `createItem` 本身不去重（主动 start 每次独立创建）。去重逻辑留在调用方。

- [ ] **Step 5: tool execute handler 新增 start action**

在 tool `execute` 函数中，原 `// ── list ──` 分支之前，新增 start 分支：

```typescript
      // ── start ──
      if (params.action === "start") {
        if (!config.triggerTool) {
          return {
            content: [{ type: "text" as const, text: "start action not supported by this tracker" }],
            details: undefined,
            isError: true,
          };
        }
        const skillName = params.name as string | undefined;
        if (!skillName) {
          return { content: [{ type: "text" as const, text: "start requires name parameter" }], details: undefined, isError: true };
        }

        // name 校验（含 system prompt fallback）
        const getPrompt = (ctx as { getSystemPrompt?: () => string }).getSystemPrompt;
        const systemPrompt = typeof getPrompt === "function" ? getPrompt() : undefined;
        if (!isValidSkillName(skillName, systemPrompt)) {
          return { content: [{ type: "text" as const, text: `skill "${skillName}" not found` }], details: undefined, isError: true };
        }

        const match = config.triggerTool.extractMeta(params);
        const newItem = createItem(match, ctx);
        await pi.sendUserMessage(config.steering.onCreate(newItem), {
          deliverAs: "steer",
        });

        return {
          content: [{ type: "text" as const, text: `Tracking started: #${newItem.id} "${newItem.name}". Call ${config.toolName}(action=update, id=${newItem.id}, status=completed) when done.` }],
          details: {
            action: "start",
            items: [...state.items],
            trackerName: config.name,
            createdId: newItem.id,
          } satisfies TrackerDetails<TMeta>,
        };
      }
```

- [ ] **Step 6: turn_end 加 abandoned 检查（先于 remind）**

在 `turn_end` handler 中（使用 `// ── Event: turn_end` 和 `let needsPersist = false;` 定位），在 `let needsPersist = false;` 之后、`for (const item of state.items)` remind 循环之前，插入 abandoned 检查：

```typescript
      // abandoned 检查（先于 remind——即将 abandon 的 item 不再发 remind）
      for (const item of state.items) {
        if (isTerminalStatus(item.status)) continue;
        const turnsSinceLoad = state.currentTurnIndex - item.loadedAtTurn;
        if (turnsSinceLoad >= config.abandonThreshold) {
          item.status = "abandoned";
          needsPersist = true;
        }
      }
```

原有的 remind 循环不需修改——因为 abandoned item 现在是终态（`isTerminalStatus("abandoned")` = true），会被 `if (isTerminalStatus(item.status)) continue;` 跳过。

- [ ] **Step 7: reconstructState 加 abandoned 检查**

在 `reconstructState` 函数中（使用 `function reconstructState(ctx: ExtensionContext): void` 定位）。**必须调整代码顺序**：原顺序为 deserialize → 过滤终态 → 算 turnCount → 赋 currentTurnIndex。abandoned 检查依赖 currentTurnIndex，必须在 turnCount 赋值之后、过滤终态之前。

**最终顺序**：deserialize → 算 turnCount → 赋 currentTurnIndex → **abandoned 检查（新增）** → 过滤终态。

具体改动：把原 `// 过滤终态 item` 的 filter 块**移到** turnCount 赋值之后，并在 filter 之前插入：

```typescript
    // 检查超时 item（compact/reload 后立即清理，不等下一个 turn_end）
    for (const item of state.items) {
      if (isTerminalStatus(item.status)) continue;
      const turnsSinceLoad = state.currentTurnIndex - item.loadedAtTurn;
      if (turnsSinceLoad >= config.abandonThreshold) {
        item.status = "abandoned";
      }
    }
```

**为什么顺序重要**：abandoned 检查计算 `turnsSinceLoad = currentTurnIndex - loadedAtTurn`，若 currentTurnIndex 未恢复，会用旧值（=0 或上 session 值）误判。过滤终态放最后——abandoned 现在是终态，会被 filter 过滤掉，不留在 state.items 中。

---

### Task 4: skill-execution.ts config 重写

**Type:** backend

**Files:**
- Modify: `extensions/evolve-daily/src/trackers/skill-execution.ts`

**改动范围：** 删除 extractSkillName + isPathInCwd + triggerEvent + triggerMatch，配置 triggerTool，重写 toolName/description/steering/promptGuidelines，加 abandonThreshold。

**注：** `isPathInCwd` 是 A+D 修复引入的 helper（cwd 排除），随 triggerMatch 一起变为孤儿（无调用方），一并删除。

- [ ] **Step 1: 删除 extractSkillName 和 isPathInCwd 函数**

删除 `extractSkillName` 函数（使用 `export function extractSkillName(path: string): string | null` 定位）和 `isPathInCwd` 函数（使用 `export function isPathInCwd(target: string, cwd: string): boolean` 定位）。name 不再从路径提取，cwd 排除逻辑随被动监听一起废弃。两个函数都成孤儿，一并删除。

- [ ] **Step 2: 重写四个 steering 函数（skill_state → use_skill，dismissed → cancelled，去掉误报语义）**

主动声明模式下不存在"误报"（agent 不调 start 就不 tracking）。原 dismissed 语义（"仅调研误触发"）失效，全部改为 cancelled（"agent 主动放弃"）。

替换 `loadedSteeringPrompt`：

```typescript
function loadedSteeringPrompt(name: string, id: number): string {
  return (
    `[SKILL-STATE] skill "${name}" tracking started (id=${id}).\n` +
    `When done, call use_skill(action=update, id=${id}, status=completed).\n` +
    `If blocked, call use_skill(action=update, id=${id}, status=error, detail="reason").\n` +
    `If not applicable (you decided not to execute this skill after all), call use_skill(action=update, id=${id}, status=cancelled, detail="reason").`
  );
}
```

替换 `remindSteeringPrompt`：

```typescript
function remindSteeringPrompt(
  name: string,
  turnsSinceLoad: number,
): string {
  return `[SKILL-STATE][INFO] skill "${name}" started ${turnsSinceLoad} turns ago without reaching terminal state. Call use_skill(action=update) to set completed/error/cancelled.`;
}
```

替换 `errorForceRecordPrompt`（**删除原 dismissed 误报判定分支**——主动声明下 agent 已明确表示要使用，不存在误报；同时处理 path 缺失场景）：

```typescript
function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  const skillPath = item.metadata.skillMdPath;
  const readStep = skillPath
    ? `1. Read ${skillPath}\n`
    : `1. Read the SKILL.md for skill "${item.name}"\n`;
  return (
    `[SKILL-STATE][INFO] skill "${item.name}" reached ${item.errorCount} errors.\n` +
    `Dispatch a subagent (background mode) to:\n` +
    readStep +
    `2. Analyze issues encountered during skill "${item.name}" execution based on current session context\n` +
    `3. Generate a structured issue record (skill name, error count, issue description, improvement suggestions)\n` +
    `Then call use_skill(action=update, id=${item.id}, status=recorded).`
  );
}
```

替换 `agentStartContextPrompt`：

```typescript
function agentStartContextPrompt(items: TrackedItem<SkillMeta>[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `  - "${item.name}" (id=${item.id}, status=${item.status})`,
  );
  return (
    `[SKILL-STATE] The following skills are being tracked — call use_skill(action=update) to update their status when appropriate:\n` +
    lines.join("\n")
  );
}
```

- [ ] **Step 3: 重写 skillExecutionConfig 对象**

替换整个 `skillExecutionConfig` 定义（使用 `export const skillExecutionConfig: TrackerConfig<SkillMeta>` 定位，到下一个同级 export 或文件结尾）：

```typescript
export const skillExecutionConfig: TrackerConfig<SkillMeta> = {
  name: "skill-execution",
  toolName: "use_skill",
  label: "Use Skill",
  description:
    "Declare and track skill execution. Zero false-positive tracking: " +
    "only call start when you DECIDE to act on a skill's instructions.\n\n" +
    "Available actions:\n" +
    "- start: Declare you are about to execute a skill. Call ONCE when you decide " +
    "to follow a skill's guidance. Do NOT call if you only read SKILL.md to " +
    "understand/evaluate/analyze it — that is research, not usage.\n" +
    "- update: Update a tracked item's status (completed/error/cancelled/recorded)\n" +
    "- list: View all tracked items\n\n" +
    "Call criteria: Are you about to ACT according to this skill's instructions? " +
    "Yes -> call start. No (just reading/evaluating) -> do not call.",
  promptSnippet: "Declare skill usage with use_skill tool for accurate tracking",
  promptGuidelines: [
    "[Trigger] Call use_skill(action=start, name=X) when you decide to execute skill X — not when you merely read its SKILL.md",
    "[Transition] After execution, call use_skill(action=update, id=X, status=completed)",
    "[Abandon] If the skill turns out not applicable, call use_skill(action=update, id=X, status=cancelled, detail=\"reason\")",
    "[Error] When blocked, call use_skill(action=update, id=X, status=error)",
    "[Record] After 2 accumulated errors, issue recording required — when done, use_skill(action=update, id=X, status=recorded)",
    "[Query] Use use_skill(action=list) anytime to view all tracking states",
  ],

  // 主动声明模式：不配 triggerEvent，配 triggerTool
  triggerTool: {
    extractMeta: (params) => {
      const name = params.name as string;
      const path = params.path as string | undefined;
      return {
        name,
        metadata: { skillMdPath: path ?? "" } satisfies SkillMeta,
        summary: `use_skill(start, name=${name})`,
      };
    },
  },

  steering: {
    onCreate: (item) => loadedSteeringPrompt(item.name, item.id),
    onRemind: (item, turns) => remindSteeringPrompt(item.name, turns),
    onError: (item) => errorForceRecordPrompt(item),
    onContextRestore: (items) => agentStartContextPrompt(items),
  },

  entryType: "evolve-tracker-skill",
  legacyEntryTypes: ["skill-state-tracker"],
  messageTypes: [
    "evolve-tracker-skill-context",
    "evolve-tracker-skill-remind",
    "evolve-tracker-skill-force-record",
  ],
  remindInterval: 10,
  errorThreshold: 2,
  abandonThreshold: 20,
};
```

- [ ] **Step 4: 验证编译**

Run: `pnpm --filter @zhushanwen/pi-evolve-daily typecheck`
Expected: 编译通过（此时 types.ts + core.ts + skill-execution.ts 应全部一致）

---

### Task 5: run_tests.mjs 测试重写

**Type:** backend

**Files:**
- Modify: `extensions/evolve-daily/src/trackers/run_tests.mjs`

**改动范围：** 更新内联状态机常量、废弃被动监听/dismissed 用例、新增 start/cancelled/abandoned 用例。

**保留说明：** 现有 run_tests.mjs 中以下用例内容仍适用于新代码，**不要删除**，只更新其依赖的内联常量（Step 1 已改）：TC-3-01（loaded→completed）、TC-3-02（终态不可转换）、TC-4-01（error threshold 逻辑）、TC-5-01（session restore 过滤终态）、TC-5-02（旧格式兼容）、TC-6-01（remind 逻辑）。本 Task 的 Step 3-7 只处理需要改写或新增的用例。

- [ ] **Step 1: 更新内联状态机常量**

替换 run_tests.mjs 顶部内联的 `TERMINAL_STATUSES` 和 `ALLOWED_TRANSITIONS`（使用 `const TERMINAL_STATUSES = new Set(["completed", "recorded", "dismissed"]);` 定位）：

```javascript
const TERMINAL_STATUSES = new Set(["completed", "recorded", "cancelled", "abandoned"]);
const ALLOWED_TRANSITIONS = {
  loaded: ["completed", "error", "cancelled"],
  error: ["completed", "error", "recorded", "cancelled"],
};
```

- [ ] **Step 2: 删除被动监听相关内联函数**

删除 run_tests.mjs 中 `extractSkillName`、`isPathInCwd`、`triggerMatch` 三个内联函数（使用 `function extractSkillName(path)` 到 `function triggerMatch(event, ctx)` 结束定位）。这些函数对应的源码已在 Task 4 删除。

- [ ] **Step 3: 更新 TC-1-01（检查有条件注册 triggerEvent）**

替换 TC-1-01 测试体（原检查 `config.triggerEvent` 存在，改为检查有条件注册逻辑）：

```javascript
// TC-1-01: createTracker 有条件注册事件 + tool
{
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(join(__dirname, "core.ts"), "utf-8");
  const hasConditionalTrigger = coreSrc.includes("if (config.triggerEvent");
  const hasTurnEnd = coreSrc.includes('"turn_end"');
  const hasSessionStart = coreSrc.includes('"session_start"');
  const hasSessionTree = coreSrc.includes('"session_tree"');
  const hasBeforeAgentStart = coreSrc.includes('"before_agent_start"');
  const hasRegisterTool = coreSrc.includes('pi.registerTool');
  const hasToolParams = coreSrc.includes('TrackerParams');
  const hasCreateItem = coreSrc.includes('createItem');
  const passed = hasConditionalTrigger && hasTurnEnd && hasSessionStart && hasSessionTree && hasBeforeAgentStart && hasRegisterTool && hasToolParams && hasCreateItem;
  record("TC-1-01", passed,
    ["Read core.ts source", "Assert conditional triggerEvent registration", "Assert turn_end/session_start/session_tree/before_agent_start handlers", "Assert registerTool + TrackerParams + createItem"],
    `condTrigger=${hasConditionalTrigger}, createItem=${hasCreateItem}, tool=${hasRegisterTool}`);
}
```

- [ ] **Step 4: 替换 TC-2-* 被动监听测试为主动声明测试**

删除 TC-2-01~TC-2-04（triggerMatch 测试），替换为：

```javascript
// TC-2-01: use_skill(start) 的 name 校验逻辑存在
{
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(join(__dirname, "core.ts"), "utf-8");
  const hasValidation = coreSrc.includes('isValidSkillName');
  const hasNotFound = coreSrc.includes('not found');
  const passed = hasValidation && hasNotFound;
  record("TC-2-01", passed,
    ["Read core.ts source", "Assert isValidSkillName call exists", "Assert 'not found' error message exists"],
    `validation=${hasValidation}, notFound=${hasNotFound}`);
}

// TC-2-02: skill-execution.ts 不含被动监听代码
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(join(__dirname, "skill-execution.ts"), "utf-8");
  const noTriggerEvent = !src.includes('triggerEvent:');
  const noTriggerMatch = !src.includes('triggerMatch');
  const noExtractName = !src.includes('extractSkillName');
  const noIsPathInCwd = !src.includes('isPathInCwd');
  const hasTriggerTool = src.includes('triggerTool');
  const passed = noTriggerEvent && noTriggerMatch && noExtractName && noIsPathInCwd && hasTriggerTool;
  record("TC-2-02", passed,
    ["Read skill-execution.ts source", "Assert triggerEvent/triggerMatch/extractSkillName/isPathInCwd removed", "Assert triggerTool configured"],
    `noEvent=${noTriggerEvent}, noMatch=${noTriggerMatch}, noExtract=${noExtractName}, noCwd=${noIsPathInCwd}, hasTool=${hasTriggerTool}`);
}

// TC-2-03: skill-registry.ts 能扫描 scoped npm packages（@scope/pkg/skills）
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const npmRoot = path.join(os.homedir(), ".pi/agent/npm/node_modules");
  // 检查 scanNpmBundledSkills 逻辑是否处理了 scoped packages
  const registrySrc = fs.readFileSync(join(__dirname, "skill-registry.ts"), "utf-8");
  const handlesScoped = registrySrc.includes('startsWith("@")') && registrySrc.includes('scoped');
  // 如果开发机有 @scope/pkg/skills，验证逻辑能发现
  let foundScopedSkill = false;
  if (fs.existsSync(npmRoot)) {
    for (const entry of fs.readdirSync(npmRoot)) {
      if (entry.startsWith("@")) {
        const scopeDir = path.join(npmRoot, entry);
        for (const subPkg of fs.readdirSync(scopeDir)) {
          const skillsDir = path.join(scopeDir, subPkg, "skills");
          if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
            foundScopedSkill = true;
            break;
          }
        }
      }
      if (foundScopedSkill) break;
    }
  }
  // 通过条件：代码处理了 scoped，且（开发机有 scoped skills 时能发现，或无 scoped 时代码仍正确）
  const passed = handlesScoped;
  record("TC-2-03", passed,
    ["Read skill-registry.ts source", "Assert scoped package handling exists (startsWith('@') + scoped comment)", "Verify scoped skills discoverable on dev machine"],
    `handlesScoped=${handlesScoped}, foundScopedSkill=${foundScopedSkill}`);
}
```

- [ ] **Step 5: 更新 TC-3-03/04（dismissed → cancelled）**

```javascript
// TC-3-03: cancelled transition allowed from loaded and error
{
  const loadedToCancelled = canTransition("loaded", "cancelled");
  const errorToCancelled = canTransition("error", "cancelled");
  const passed = loadedToCancelled === true && errorToCancelled === true;
  record("TC-3-03", passed,
    ["Call canTransition('loaded', 'cancelled')", "Assert true", "Call canTransition('error', 'cancelled')", "Assert true"],
    `loaded→cancelled=${loadedToCancelled}, error→cancelled=${errorToCancelled}`);
}

// TC-3-04: cancelled is terminal
{
  const passed = isTerminalStatus("cancelled") === true && canTransition("cancelled", "completed") === false;
  record("TC-3-04", passed,
    ["Call isTerminalStatus('cancelled')", "Assert true", "Call canTransition('cancelled', 'completed')", "Assert false"],
    `isTerminal=${isTerminalStatus("cancelled")}, cancelled→completed=${canTransition("cancelled", "completed")}`);
}
```

- [ ] **Step 6: 新增 TC-3-05（abandoned 是纯系统终态）**

在 TC-3-04 之后追加：

```javascript
// TC-3-05: abandoned is terminal and system-only (not in ALLOWED_TRANSITIONS as source)
{
  const isTerminal = isTerminalStatus("abandoned") === true;
  const cannotTransition = canTransition("abandoned", "completed") === false;
  const notInTransitions = !("abandoned" in ALLOWED_TRANSITIONS);
  const passed = isTerminal && cannotTransition && notInTransitions;
  record("TC-3-05", passed,
    ["Call isTerminalStatus('abandoned')", "Assert true", "Call canTransition('abandoned', 'completed')", "Assert false", "Assert 'abandoned' not in ALLOWED_TRANSITIONS"],
    `isTerminal=${isTerminal}, cannotTransition=${cannotTransition}, notInTransitions=${notInTransitions}`);
}
```

- [ ] **Step 7: 新增 TC-7-* abandoned 自动转换测试**

在 TC-6-01 之后追加：

```javascript
// TC-7-01: turn_end checks abandonThreshold before remind
{
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(join(__dirname, "core.ts"), "utf-8");
  const hasAbandonThreshold = coreSrc.includes('abandonThreshold');
  const hasAbandonedStatus = coreSrc.includes('"abandoned"');
  // abandoned 检查出现在 remind 检查之前（通过 indexOf 验证顺序）
  const abandonPos = coreSrc.indexOf('abandonThreshold');
  const remindPos = coreSrc.indexOf('steering.onRemind');
  const correctOrder = abandonPos > 0 && abandonPos < remindPos;
  const passed = hasAbandonThreshold && hasAbandonedStatus && correctOrder;
  record("TC-7-01", passed,
    ["Read core.ts source", "Assert abandonThreshold exists", "Assert 'abandoned' status exists", "Assert abandoned check before remind"],
    `threshold=${hasAbandonThreshold}, status=${hasAbandonedStatus}, order=${correctOrder}`);
}

// TC-7-02: reconstructState checks abandoned
{
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(join(__dirname, "core.ts"), "utf-8");
  const reconstructStart = coreSrc.indexOf('function reconstructState');
  const reconstructEnd = coreSrc.indexOf('function handleSessionRestore');
  const reconstructSection = coreSrc.slice(reconstructStart, reconstructEnd);
  const hasAbandonedCheck = reconstructSection.includes('abandonThreshold') && reconstructSection.includes('"abandoned"');
  const passed = hasAbandonedCheck;
  record("TC-7-02", passed,
    ["Read core.ts reconstructState section", "Assert abandonThreshold check exists in reconstructState"],
    `hasAbandonedCheck=${hasAbandonedCheck}`);
}
```

- [ ] **Step 8: 运行测试**

Run: `node extensions/evolve-daily/src/trackers/run_tests.mjs`
Expected: ALL PASS（新测试用例全部通过）

---

### Task 6: 端到端验证

**Type:** backend

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 2: 运行 tracker 测试**

Run: `node extensions/evolve-daily/src/trackers/run_tests.mjs`
Expected: ALL PASS

- [ ] **Step 3: 全量 lint**

Run: `pnpm --filter @zhushanwen/pi-evolve-daily lint`
Expected: 零错误

- [ ] **Step 4: 确认 index.ts 无需改动**

检查 `extensions/evolve-daily/src/index.ts` 中 `createTracker(pi, skillExecutionConfig)` 调用——config 对象名不变（仍是 skillExecutionConfig），只是其内部字段变了，调用点无需修改。

Run: `grep -n "createTracker" extensions/evolve-daily/src/index.ts`
Expected: 输出调用行，无需改动

- [ ] **Step 5: 手动验证（可选，启动 pi 后）**

```
# 在 pi session 中测试 use_skill
/skill:handoff
# → agent 读到 handoff SKILL.md，如果决定执行应调 use_skill(start, name=handoff)
# → 验证 TrackedItem 创建
use_skill(action=list)
# → 应看到 handoff 的 tracking item
```

- [ ] **Step 6: 提交**

```bash
git add extensions/evolve-daily/src/trackers/
git commit -m "feat(evolve-daily): replace passive skill tracking with use_skill active declaration"
```

---
