# DESIGN-IT-TWICE Agent 3 — 可靠性优先（fail-closed + 多重冗余）

> 约束：最大化防跳过可靠性。CwStore 多层防护，guard 三重校验。宁冗余不漏。

## slot 1: interface sketch

```typescript
// === CwStore：唯一写入入口是 withTransaction，文件操作私有化 ===
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type FrozenTopic = Readonly<CwTopic>;  // 对外只读，防误改

interface CwStore {
  // 读：完整性自检（schemaVersion + 字段非空 + 数组 id 唯一）+ schema assert；
  // 任一不过 → throw `cw file corrupted`（fail-closed，绝不返回半坏数据）
  load(topicDir: string): FrozenTopic;
  // 唯一可变写入口：L1 备份 → L2 schema assert(in-memory) → L3 tmp 写 + fsync →
  // L4 atomic rename → L5 回读重 assert → L6 journal append。任一失败回滚 + throw
  withTransaction<R>(topicDir: string, fn: (t: Mutable<CwTopic>) => R): R;
}
// handler 拿不到 _cw.json 路径，只有 withTransaction 回调里的 Mutable<CwTopic> 可改

// === guard：三重 pre + 一重 post，全 fail-closed ===
type GuardRejection =
  | { kind: "illegal_transition"; from: CwStatus; action: CwAction }
  | { kind: "phase_incomplete"; missing: string[] }
  | { kind: "cache_tamper"; field: string; cached: unknown; recomputed: unknown }
  | { kind: "post_invariant"; reason: string };

interface GuardEngine {
  // pre 三重：① 线性 expectedStatus ② 跨阶段 gatePassed 级联 ③ 缓存自洽
  assertCanTransition(action: CwAction, topic: FrozenTopic): void;
  // post：写完 _cw.json 后，断言 status==nextStatus(action) 且 gateHistory 末条自洽
  assertPostTransition(action: CwAction, before: CwStatus, after: FrozenTopic): void;
}
// 第三重「缓存自洽」：从 gateHistory 重算 gatePassed，与 topic 缓存字段比对，不一致 throw
// 防 agent 篡改 _cw.json 的 gatePassed 字段绕过级联校验
```

## slot 2: 使用示例（dev handler 视角）

```typescript
async function devHandler(params: DevParams, ctx: Ctx): Promise<CwResult> {
  return ctx.store.withTransaction(ctx.topicDir, (topic) => {
    ctx.guard.assertCanTransition("dev", topic);   // 三重 pre
    const before = topic.status;
    const results = ctx.gitValidator.checkCommits(params.commits, topic.workspacePath);
    applyDevResults(topic, results);               // 更新 waves.committed（逐条容错）
    if (topic.status !== "developed" && hasAnyCommitted(topic)) {
      topic.status = TRANSITIONS.dev.nextStatus;   // 唯一来源
    }
    appendGateHistory(topic, { action: "dev", result: aggregate(results), progressive: true });
    ctx.guard.assertPostTransition("dev", before, topic);  // post invariant
    return { status: topic.status, gatePassed: allWavesCommitted(topic), nextAction };
  });  // store 在事务出口做 L1-L6，post-check 在回滚前跑
}
```

## slot 3: trade-off

- **CwStore 原子写**：得 "半写/崩溃/篡改三类故障全覆盖（备份可回滚 + journal 可审计 + 回读兜底）" / 付 "每次写多 2 次 IO（备份 + 回读）+ journal 膨胀需 GC（按 topicId 滚动保留 N 条）"。
- **guard 组织**：得 "三重 pre + post invariant，防『agent 篡改缓存字段』+『执行 bug 错误推进』两类隐蔽漏洞" / 付 "转换表必须严格是 status 流转唯一来源，gate 不得隐式改 status，否则 post-check 必然 throw"。
- **整体耦合**：得 "CwStore 与 guard 通过 CwTopic 不变式契约强绑定，任一方松动立刻 fail-closed" / 付 "测试矩阵爆炸（每条校验都要独立测 fail 路径，6×3+ 用例）"。

## slot 4: hidden-cost

post-check 强制 state-machine.ts 成为 status 流转唯一真相源——gates.ts 的 gate 执行结果只能写 gateHistory，不能直接 mutate topic.status，否则 post invariant 永远 throw；这等于把状态推进权从 handler 收紧到 nextStatus(action) 单点。

## slot 5: 其他 radically different 权衡

- **CwTopic 不透明类型封装**：handler 只能通过 `withTransaction` 回调拿到 `Mutable<CwTopic>`，模块外暴露的是 `FrozenTopic`（Readonly）。编译期阻止 handler 绕过 store 直接 fs.writeFile 或在事务外持引用改字段。比"靠约定调 guard"（方案 A 已知缺点）更硬：类型系统强制唯一写入路径。
- **journal 作为崩溃恢复 + 审计双重**：append-only `_cw.journal`（每条 `{ts, action, before, after, gateResult, schemaHash}`），不只是日志——load() 检测到 _cw.json 与 journal 末条不一致时，可从 journal 重建（fail-safe 而非 fail-closed 的降级路径），同时给 D-009 对账兜底提供机器可读证据。
- **第三重校验是核心发散点**：原方案两重校验都信 _cw.json 缓存（status / gatePassed 都是字段）。我加的「从 gateHistory 重算 gatePassed 与缓存比对」打破了"信自己写的字段"假设——这是 fail-closed 哲学的彻底贯彻：CW 不信自己写的数据，每次都重算验证。代价是 gateHistory 必须能无歧义重算 gatePassed（schema 设计约束）。
