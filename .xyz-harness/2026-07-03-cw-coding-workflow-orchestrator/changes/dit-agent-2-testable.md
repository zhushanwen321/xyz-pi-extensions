# DESIGN-IT-TWICE Agent 2 — 纯函数优先 / 状态外置

约束：最大化可测试性。CwStore 与 guard 拆成纯函数 + 独立 IO shell；guard 不 throw，返回 verdict 对象；副作用（fs）推到唯一一个边缘函数。

---

## slot 1: interface sketch

```typescript
// ===== store.ts：纯数据层（无 IO、无 throw）=====
// 变更表达为数据（reducer 模式），topic 不可变
type CwChange =
  | { kind: "set-status"; status: CwStatus }
  | { kind: "mark-wave-committed"; waveId: string; commitHash: string }
  | { kind: "mark-case-result"; caseId: string; result: Omit<TestCase, "id"> }
  | { kind: "append-gate-history"; entry: GateHistoryEntry }
  | { kind: "init-waves"; waves: Wave[] }
  | { kind: "init-test-cases"; cases: TestCase[] };

export function applyChange(topic: CwTopic, change: CwChange): CwTopic;   // 纯 reducer
export function applyChanges(topic: CwTopic, changes: CwChange[]): CwTopic;
export function serializeCwTopic(topic: CwTopic): string;                 // 纯
export function deserializeCwTopic(json: string): CwTopic;                // 纯，缺字段补默认

// ===== store-io.ts：唯一副作用点（fs 注入便于测）=====
export interface FsShell { readFile(p: string): Promise<string>; writeFile(p: string, s: string): Promise<void>; rename(a: string, b: string): Promise<void>; }
export async function loadTopic(path: string, fs: FsShell): Promise<CwTopic>;
// read → deserialize → applyChanges → serialize → tmp → rename（POSIX 原子）
export async function commitChange(path: string, topic: CwTopic, changes: CwChange[], fs: FsShell): Promise<CwTopic>;

// ===== state-machine.ts：guard 纯函数（无 IO、无 throw）=====
export type Verdict =
  | { ok: true }
  | { ok: false; code: "ILLEGAL_TRANSITION" | "PHASE_INCOMPLETE"; reason: string };

export const TRANSITIONS: Record<Action, { expected: CwStatus[]; next: CwStatus }>;
export function checkLinear(action: Action, current: CwStatus): Verdict;          // 第一道
export function checkPhaseCascade(action: Action, topic: CwTopic): Verdict;        // 第二道
export function guard(action: Action, topic: CwTopic): Verdict;                    // 组合，仍纯
```

---

## slot 2: 使用示例（dev handler 调用方视角）

```typescript
async function handleDev(params: DevParams, fs: FsShell): Promise<Result> {
  const path = topicPath(params.topicId);
  const topic = await loadTopic(path, fs);              // 唯一读

  const v = guard("dev", topic);                        // 纯，不 throw
  if (!v.ok) throw new Error(v.reason);                 // throw 推到边缘

  const gateResult = await runGate(topic, "dev");        // 副作用（subprocess）

  const changes: CwChange[] = [];                        // 收集变更意图，不碰 topic
  for (const w of params.waves)
    if (gateResult.passed(w.id))
      changes.push({ kind: "mark-wave-committed", waveId: w.id, commitHash: w.commitHash });
  changes.push({ kind: "append-gate-history", entry: gateResult.toEntry() });
  if (allWavesCommitted(applyChanges(topic, changes)))   // 纯预演判定
    changes.push({ kind: "set-status", status: "developed" });

  const next = await commitChange(path, topic, changes, fs);  // 唯一原子写
  return makeResult(next);
}
```

---

## slot 3: trade-off（3 条）

1. **CwStore 原子写（reducer + 独立 IO shell vs 对象封装 update(fn)）**
   得：`applyChange`/`serialize`/`deserialize` 全纯函数，vitest 单测零 mock；变更意图是数据可序列化、未来 event log/审计近乎免费；topic 不可变让竞态推理简单 /
   付：handler 要「load → 算 changes → commit」三段，比 `store.update(topic => {...})` 回调式多一次显式 read，调用更啰嗦。

2. **guard（verdict 对象 vs 直接 throw）**
   得：guard 不 throw = 可组合（两道校验可 reduce 成聚合 verdict，附 code 让 agent 拿到结构化错误码）；单测断言 `{ok:false, code:"PHASE_INCOMPLETE"}` 比 `toThrow(regex)` 精确且不依赖错误文案 /
   付：每个 handler 边界写 `if (!v.ok) throw new Error(v.reason)` 样板，8 个 handler 各重复 1 行（可用 helper 收敛但仍非零）。

3. **整体耦合（变更经 Change 数据通道 vs 直接 mutate topic）**
   得：`applyChange` 是唯一变更入口，所有写盘前必经纯函数，推理「topic 怎么变成这样的」可回放 changes /
   付：`CwChange` union 随 schema 演进膨胀，每加一个可变字段要新增一个 kind + reducer 分支，比 `topic.x = y` 类型面更宽。

---

## slot 4: hidden-cost

Change union 的「封闭性」靠开发者自觉——`applyChange` 的 exhaustive check 若漏写一个 kind 分支 TS 默认不报错（需显式 `assertNever`），而 reducer 模式的全部价值就押在「applyChange 是唯一变更入口」这个 invariant 上：一旦某个 handler 绕过它直接构造 topic 调 `commitChange(rawTopic, [], fs)`，纯函数不变量被破坏且**无编译期保护**，只能靠 review + 测试守。

---

## slot 5: 其他权衡（radically different）

- **fs 依赖注入优于 vi.mock**：`FsShell` 参数让单测传内存 mock 完全脱离磁盘，比 vitest 的 `vi.mock("fs")` 干净（后者污染模块级、有 hoist 陷阱）。代价是每个 IO 函数签名多一个 `fs` 参数——但 handler 层可用默认值 `fs = realFs` 收敛，仅 store 单测显式传 mock。
- **verdict 可叠加成「诊断快照」**：既然 guard 不 throw，可让它返回多道校验的**全部**结果（而非 fail-fast 第一道），agent 一次看到「illegal transition + phase incomplete + 哪个 wave 缺 commit」全貌，重试更有方向。这是 throw 模式拿不到的——throw 只给第一个错误。代价是 guard 要跑完全部校验（轻微浪费，但都是纯内存计算可忽略）。
