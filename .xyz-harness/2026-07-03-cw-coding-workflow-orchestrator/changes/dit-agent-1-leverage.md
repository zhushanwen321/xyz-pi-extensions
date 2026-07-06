# DESIGN-IT-TWICE Agent 1 — 最小化 interface / 最大化 leverage

**约束**：CwStore 和 guard 的公开 API 表面最小（理想 1-2 函数），调用方一行搞定。宁可内部复杂。

**核心思路**：把 issues.md 方案 A 的「read/write 分离 + 独立 guard()」推翻——熔合成**单一 `transact` 入口**，guard/gate/atomic-write 全部内化、不可绕过。调用方只剩「一段纯 mutation」。

---

## slot 1: interface sketch

```typescript
// src/cw/store.ts — 整个状态层只 export 1 个函数 + 1 个 factory
export interface Cw {
  transact<A extends Action>(
    action: A,
    topicId: string,
    body: (ctx: TransitionCtx<A>) => void | Promise<void>,
  ): Promise<TransitionResult>;
}
export function createCw(workspacePath: string): Cw;

interface TransitionCtx<A extends Action> {
  topic: CwTopic;          // 已 load、已过 guard 的可变快照
  gateResult: GateResult;  // gate 已执行（perItem 逐条结果）
  input: ActionInput[A];   // 类型化入参
}
interface TransitionResult {
  nextAction: NextAction; status: CwStatus; gateResult: GateResult;
}

// 以下全部 NOT exported（模块内部细节，外部无法绕过）:
//   state-machine.ts 的 TRANSITIONS 表 + guard(action, topic)
//   store 内部 atomicWrite(topic) = tmp + fsync + rename
//   gates.ts 的 runGate(action, topic)
```

**公开 API = `transact` 一个函数**（`createCw` 只是绑 workspacePath 的 factory）。guard / gate / atomic-write 是私有函数，无逃逸口。issues.md 方案 A 的「约定耦合」弱点（handler 必须记得调 guard）被根除——因为根本不存在 `write()` 这个绕过 guard 的口子。

---

## slot 2: 使用示例（dev handler 全文）

```typescript
// src/cw/actions/dev.ts — 整个 handler 就这些
export const devHandler =
  (cw: Cw, p: DevInput): Promise<TransitionResult> =>
    cw.transact("dev", p.topicId, (ctx) => {
      // guard 已过（线性 + 跨阶段级联）；gate 已跑（GitValidator），结果在 ctx.gateResult
      for (const w of p.waves) {
        const wave = ctx.topic.waves.find(x => x.id === w.id)!;
        if (ctx.gateResult.perItem[w.id] === "pass") wave.committed = w.commitHash;
      }
      // 不操心:状态推进 / gateHistory 追加 / atomic write / nextAction 组装
    });

// src/index.ts 分派
switch (params.action) {
  case "dev": return devHandler(cw, params as DevInput);
  // ...其他 7 个同构
}
```

调用方视角：**一次 `transact` 调用 + 一段纯 mutation**。无 read、无 write、无 guard 调用、无 gate 调用、无 nextAction 组装。read-modify-write、原子 rename、状态机校验、跨阶段级联、gateHistory 追加——全在视线之外。

---

## slot 3: trade-off（3 条）

1. **CwStore 原子写策略（transact 闭包 vs read/write 分离）**：得——原子性 by construction，调用方无法忘记 `rename`、无法忘记 `write`、无法半写；付——mutator 是闭包，无法单独单测「write 这一步」（要测得构造整个 transact 上下文），debugger 单步进闭包稍绕，store 的可测性下降一档。

2. **guard 组织模式（嵌入 transact vs 独立 guard()）**：得——guard **不可绕过**，彻底消除 issues.md 方案 A 自陈的「约定耦合」弱点，编译期+运行时双强制（无 `write()` 逃逸口即无绕过路径）；付——handler 业务逻辑被框死在回调内，guard 前的预检（如 plan-parser 的 JSON 解析）做不了，必须把 JSON 解析挪进 `body` 内或作为 action 的 pre-hook 注入表，破坏了「JSON 解析归 plan-parser 模块」的纯净边界。

3. **整体耦合（store+guard+gate 三合一 vs §3 三模块分离）**：得——全状态层 1 个公开函数，新增 action 只改内部转换表 + 注册一个 body，调用方记忆负担最小；付——store/guard/gate 熔为单个 orchestrator，内部文件可能膨胀（威胁 §3「模块单一变化轴」），需内部仍分 `internal-store.ts` / `internal-guard.ts` 但对外统一 `transact` 出口——内部多层、外部一面。

---

## slot 4: hidden-cost

mutator 闭包捕获 `ctx.topic` 的可变引用——若 handler 在 `body` 内发起异步 IO（调 Pi SDK 副作用、再读 _cw.json、spawn 子进程），事务的「读-改-写原子」假设破裂，可能基于过期 snapshot 写回覆盖他写。**隐含硬约束：`body` 必须是同步纯 mutation，禁止任何 IO**——这条不变式没有编译器强制，只能靠 lint 规则 + 代码评审守。gate 已在 `body` 之前跑完（结果经 `ctx.gateResult` 传入），是这条约束能成立的前提；若未来某 action 需要「mutation 中途再跑 gate」，事务模型崩盘。

---

## slot 5: 其他权衡（约束推到的更激进方向）

既然只有 `transact` 一个入口，**index.ts 的 8-handler 分派也可内化**：registerTool 只注册一个 tool，`params.action` 在 `transact` 内查转换表分派到注册的 body。这样：

- index.ts 缩到 ~10 行；
- `actions/` 目录从 8 个 handler 文件退化成一张 `bodies: Record<Action, Body>` 注册表（一个文件）；
- leverage 极致：**1 个 tool、1 个入口、1 张表**。

代价：8 个 action 的 typebox 入参 schema 必须做成一个 **discriminated union**（一个 schema 覆盖 8 套入参，按 `action` 字段判别），失去了「每 action 一个 schema 文件」的隔离，schema 复杂度全部集中。可接受性取决于 typebox 对 discriminated union 的运行时校验支持度（呼应 #5 的 typebox Value 校验决策）——若 typebox 处理大 union 吃力，这个极致方向要回退到「内部 transact + 外部仍 8 handler 文件」的折中。
