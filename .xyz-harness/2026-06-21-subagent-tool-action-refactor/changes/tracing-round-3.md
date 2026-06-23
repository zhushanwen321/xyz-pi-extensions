# Tracing Round 3

## 追踪范围
- spec 初稿版本：`spec.md`（verdict: pass，含 D6/D9/D11 修订）+ `clarification.md`（D1-D12）
- 追踪的视角（完整重跑，非增量——隔离上下文从零审视）：
  - P1 User Journey（适用）
  - P2 Data Lifecycle（降级：接口重构不改数据模型，但追踪 sessionFile/mode 数据流 + cancel 签名 + session 作用域的真实实现 — 发现实质 gap）
  - P3 API Contract（适用，重点）
  - P4 State Machine（降级：状态机不变，但追踪 cancel throw 化对调用方的副作用）
  - P5 Failure Path（适用）

---

## 判定：**有新 gap**（未收敛）

Round 2 的 9 个 gap（G2-001 ~ G2-009）已在 spec 中处理，**处理方向正确且基本自洽**（详见下文复核表）。但从零重跑 5 视角，聚焦验证本轮指定的 6 个修复点（FR-3/FR-5/FR-6/FR-7/FR-8/FR-9），发现 **3 个新 gap**，全部是 Round 2 修复**引入的新矛盾**或**修复声明与代码现实不符**：

1. **G3-001（D）**：FR-3 新增的「分层职责」block 内部用 `SubagentToolDetails` 同时指代**内层 project 产出**和**外层分组**两种类型，与 FR-9「SubagentToolDetails 重组为分组结构」直接冲突；FR-8 的代码片段 `this.details.mode` 又假设扁平访问——同一名称三种用法，实现者必须自行决定类型边界。
2. **G3-002（F/D）**：FR-5 step 1「调 service 暴露的只读查询」未指明方法签名，而 FR-4 已删除 `service.query(id)`——目前 service 没有任何按 id 返回单条 record 的公开只读方法。
3. **G3-003（F/K）**：FR-6 声称「AI 只看当前 session 启动的 subagent」，但 `collectRecords(limit, sessionId)` 只过滤 history 源，内存源（live/completed/bg）不过滤（`ExecutionRecord` 无 sessionId 字段）——`/new` `/resume` `/fork` 场景下跨 session record 会泄漏给 AI。

---

## 新 Gap 列表

### G3-001：SubagentToolDetails 类型名在 FR-3/FR-8/FR-9 三处用法互相矛盾

| 字段 | 值 |
|------|-----|
| Type | D（需决策类型边界与命名） |
| Perspective | P3 API Contract + P2 Data Lifecycle |
| Source | FR-3「分层职责」block + FR-8 代码片段 + FR-9 开头 |

**事实链**（代码 + spec 文本交叉验证）：

1. **FR-3 分层职责 block**（为消解 G2-002/003 新增）含两句直接冲突：
   - 「`project(record)` ... 是 `SubagentToolDetails` 的 sync 子集」→ 暗示 SubagentToolDetails 是**外层分组**类型（project 返回它的 sync 子集/syncResponse 内容）
   - 「`ExecutionHandle.details: SubagentToolDetails` 仍是 project 产出（内层形态，不带 action）」→ 这里 SubagentToolDetails 又指**内层扁平**类型（= project 产出，无 action）
   - 同一段内同一名称指两种类型，互斥。

2. **FR-9**：「`SubagentToolDetails` 重组为分组结构（FR-3 的 details 形态 + `action` 字段）」→ 明确 SubagentToolDetails = 外层分组。这与 FR-3 第二句（ExecutionHandle.details 是内层）冲突——若 SubagentToolDetails 是外层分组，service 层的 ExecutionHandle.details 就不能既是 SubagentToolDetails 又是「内层形态，不带 action」。

3. **FR-8 代码片段**：`if (this.details.status === "running" && this.details.mode === "sync")` 用**扁平访问** `this.details.status`/`this.details.mode`。但 FR-3/FR-8 prose 都说 mode 挂在内层 syncResponse/bgResponse——若组件持有外层分组 details，应写 `this.details.syncResponse?.mode`。代码片段假设组件拿内层，与 FR-9（renderResult 消费外层分组）矛盾。

**当前代码状态**（验证）：
- `types.ts:171-189` `SubagentToolDetails` 现状是扁平结构（status/agent/model/turns/.../backgroundId?/parsedOutput?），无 action/syncResponse 分组。
- `types.ts:201-203` `ExecutionHandle.details: SubagentToolDetails`（扁平）。
- `tool-render.ts:298` `SubagentResultComponent` 持有 `details: SubagentToolDetails`（扁平），`maybeToggleSpinner` 直接读 `this.details.status`/`this.details.backgroundId`。

**为什么是 gap（非纯命名问题）**：矛盾影响类型层级与 layering 决策，不只是起名。实现者必须二选一：
- **(A) SubagentToolDetails 保持内层扁平**（project 产出 / ExecutionHandle.details 不变），外层分组**另起名**（如 `SubagentGroupedDetails` 或 `SubagentToolResult`）。`AgentToolResult<X>` 的 X 与 renderResult 入参改用新名。改动面：types.ts 加新类型 + tool.ts/render.ts 改泛型参数。
- **(B) SubagentToolDetails 改为外层分组**（FR-9 字面），project 产出**另起名**（如 `SyncExecutionDetails`）。`ExecutionHandle.details` 改类型。改动面：types.ts 改 SubagentToolDetails 定义 + ExecutionHandle.details 改型 + execution-record.ts project 返回类型改。

两种都可行，spec 未决策。FR-3 的「分层职责」block 意图清楚（project 内层 → adapter lift 外层），但**类型名归属**未澄清。如果不澄清，实现者按 FR-3 第二句做（ExecutionHandle.details = SubagentToolDetails 扁平），又会与 FR-9（SubagentToolDetails = 分组）冲突，tsc 会报错或被迫 `as any` 绕过。

**建议主 agent 决策**：明确采用 (A) 或 (B)，并相应修正 FR-3 第二句的「ExecutionHandle.details: SubagentToolDetails」表述（若是 A，保留；若是 B，改为新内层类型名）。同时修正 FR-8 代码片段为正确的（嵌套或扁平）访问形式。

---

### G3-002：cancelHandler step 1 的「只读查询」方法未定义，FR-4 删 query 后无可用 API

| 字段 | 值 |
|------|-----|
| Type | F（代码事实）+ D（需决策方法签名） |
| Perspective | P3 API Contract + P5 Failure Path |
| Source | FR-5 step 1 + FR-4（删 service.query） |

**事实链**：

1. FR-5 step 1 写：「id 不存在 → throw `No subagent record with id "..."`（**调 service 暴露的只读查询**）」——括号注明用 service 的某个只读查询方法。
2. FR-4 明确删除 `service.query(id)`（唯一的按 id 返回单条 record 的公开方法）。
3. **验证 service 现有公开方法**（`subagent-service.ts`）：
   - `resolveModel` / `execute` / `cancel(id): boolean` / `onChange` / `listRunning()` / `collectRecords(limit)`
   - `cancel` 返回 boolean 不是 record；`listRunning`/`collectRecords` 不接受 id 参数。
   - `store.getMutable(id)` 是 **private**（runtime 内部），不暴露给 tool 层。
4. FR-4 执行后，**service 没有任何按 id 返回单条 record 的公开只读方法**。cancelHandler step 1「调 service 暴露的只读查询」无方法可调。

**step 3 也有连带问题**：「调 service.cancel(id)，返回 false → throw `Subagent {id} already finished (status: ...)`」——错误信息含 `(status: done/failed/cancelled)`，但 boolean 返回不告诉调用方具体终态。handler 需要在 cancel 返回 false 后**再次查询** record.status 才能拼出消息。同样依赖那个未定义的只读查询方法。

**实现者可能的 workaround 与各自问题**：
- **(a) 复用 `collectRecords(limit, sessionId)` + `.find(r => r.id === id)`**：能用，但 (1) 为查 1 条拉最多 100 条，浪费；(2) collectRecords 合并 4 源含 history——history-only record（已持久化、不在内存）会被 find 到，但 `service.cancel` 内部 `store.getMutable` 找不到（返回 false），handler 会误报「already finished」而真实原因是「record 不在内存」；(3) 语义上 collectRecords 是「列表查询」不是「单点查询」，错用 API。
- **(b) 新增 `service.findRecord(id): SubagentRecord | undefined`（或 `snapshot(id): RecordSnapshot | undefined`）**：clean，但 spec 未声明该方法签名、返回类型（SubagentRecord vs RecordSnapshot）、是否只查内存源还是含 history。
- **(c) 让 cancelHandler 直接调 `service.cancel(id)`，false 时 throw 通用消息**：丢掉 step 1 的「No record」精准文案和 step 3 的 `(status: ...)` 信息——违反 AC-9 的具体文案要求。

**为什么是 gap**：FR-5 的 step 1/step 3 都依赖一个 spec 未定义的 service 方法。AC-9 要求的错误文案（含具体 status）没有可靠数据来源。实现者若选 (a) 会引入 history-only record 的误报；若选 (c) 达不到 AC-9。必须决策 (b) 的方法签名。

**建议主 agent 决策**：在 FR-5 显式声明新增 service 只读方法（推荐 `findRecord(id): SubagentRecord | undefined`，查内存三源 + 不查 history——因为 cancel 只能作用于内存 record），并据此实现 step 1（undefined → throw No record）+ step 3（cancel false → 读 findRecord 的 status 拼 throw 消息）。

---

### G3-003：FR-6「session 作用域」声明与 collectRecords 实现不符——内存源跨 session 泄漏

| 字段 | 值 |
|------|-----|
| Type | F（代码事实）+ K（产品语义需澄清） |
| Perspective | P3 API Contract + P2 Data Lifecycle |
| Source | FR-6「session 作用域」+ `record-store.ts:collectRecords` |

**事实链**：

1. FR-6 声称：「**session 作用域**：传当前 sessionId 限定（`service.modelService.sessionId`），**AI 只看当前 session 启动的 subagent**」——这是一个**结果声明**（AI 只看当前 session）。
2. **验证 `collectRecords` 实现**（`record-store.ts:123-146`）：
   ```typescript
   collectRecords(limit, sessionId?) {
     // 1. history 基底（跨 session，按 sessionId 过滤）✓ 过滤
     for (const h of this.history.recent(limit, sessionId)) { ... }
     // 2. 内存源覆盖（bg + completed + live）✗ 不过滤
     const memorySources = [...this.bg.values(), ...this.completed.values(), ...this.live.values()];
     for (const r of memorySources) { ... byId.set(r.id, recordToSubagent(r)); }
   }
   ```
   sessionId **只过滤 history 源**，内存源（live/completed/bg）**完全不过滤**。
3. **`ExecutionRecord` 无 sessionId 字段**（`types.ts:114-149` 已验证）——即使想过滤内存源也无字段可过滤。
4. **store 是进程级单例且 session_start 不 reset**（验证）：
   - `index.ts:69-72` `getSubagentService() ?? new SubagentService(...)`——进程级复用
   - `subagent-service.ts:152-157` `initSession` 调 `store.revive()`，**不 clear/reset**
   - 所以 `/new` `/resume` `/fork`（同进程新 session）时，前一 session 的 live/completed/bg record **全部保留**。
5. 实际结果：AI 在 `/new` 后调 `action:"list"`，会看到前一 session 仍在 running 的 background record（live map）+ 前 session linger 的 completed record + 前 session 的 bg map record。与 FR-6 声称的「AI 只看当前 session 启动的 subagent」**直接矛盾**。

**为什么是 gap（不是 pre-existing 可忽略）**：
- 这是**新暴露给 AI 的路径**——TUI list view 一直有此行为（leak 对人是可接受的，人能看懂跨 session record），但 AI 会**误以为这些 record 属于当前任务上下文**（spec 明确声称 session 隔离）。
- 若主 agent 启动 background 后用户 `/new`，新 session 的 AI list 看到「陌生 running record」可能误取消或误依赖。
- spec 的「Out of Scope」写「执行引擎不动」，但没说「跨 session record 可见性不动」——这是 tool 接口语义，属于本次重构范围。

**两种可接受的方向**（需主 agent 决策）：
- **(A) 修正 spec 声明**：FR-6 改为「history 按 sessionId 过滤；内存源（live/completed/bg）跨 session 可见——AI 可能看到前 session 仍在 running 的 background 或 linger 的 completed record」。承认现状，不动数据模型。零代码改动。
- **(B) 真正实现 session 隔离**：给 `ExecutionRecord` 加 `sessionId: string` 字段（createRecord 时填），collectRecords 内存源也按 sessionId 过滤。数据模型变更——需评估是否违反「Out of Scope: 执行引擎不动 / history.jsonl 仅向后兼容加字段」。ExecutionRecord 加字段不算 history 格式变更，勉强在范围内，但要改 createRecord 签名 + record-store 过滤逻辑。

**建议主 agent 决策**：倾向 (A)（最低成本 + 跨 session bg 可见对 AI 其实有用——能 cancel 跑飞的前 session 任务）。但必须**修正 FR-6 的虚假声明**，否则实现者按声明理解会误以为已隔离。

---

## 上轮（Round 2）gap 修复复核

验证 Round 2 的 9 个 gap 是否在 spec 中正确处理、有无引入新矛盾：

| Round 2 Gap | spec 修复 | 复核结论 |
|-------------|----------|---------|
| G2-001（cancel 签名变更连带 list-view） | FR-5/D6 改为「service.cancel 保持 boolean + tool 层 cancelHandler 翻译 throw」，list-view 零改动 | ✅ 自洽。service.cancel 签名不变，list-view 的 `handleCancel`（`list-view.ts:873`）继续按 boolean 消费，**无连带改动**。但衍生 **G3-002**（cancelHandler 的只读查询方法未定义）。 |
| G2-002（project() 职责未定义） | FR-3 新增「分层职责」block：project 返回内层，adapter lift 外层 | ✅ 方向正确，消解了原 G2-002。但该 block 引入 **G3-001**（SubagentToolDetails 名归属矛盾）。 |
| G2-003（mode 字段归属） | FR-3/FR-8 明确「mode 挂在内层 syncResponse/bgResponse」 | ✅ 自洽。内层挂载决策清晰。但 FR-8 代码片段 `this.details.mode` 用扁平访问，与「内层」声明冲突——并入 **G3-001**。 |
| G2-004（snapshot() 遗漏） | FR-7「投影生产者更新清单」改为四处：project/snapshot/recordToSubagent/toPersisted | ✅ 自洽。验证四处（`execution-record.ts:390/413` + `record-store.ts:228` + `execution-record.ts:435`）全列出。RecordSnapshot 类型也需加 sessionFile（types.ts），FR-7 已声明。 |
| G2-005（list session 作用域决策） | FR-6 决策「传当前 sessionId 限定」 | ✅ 决策做出。但声明与实现不符——衍生 **G3-003**。 |
| G2-006（running 计数语义） | FR-6 明确「items 中 status==="running" 的子集计数，受 limit 截断如实反映」 | ✅ 自洽。语义清晰，无歧义。 |
| G2-007（renderResult 防御 guard） | FR-9 明确「入口 guard 改为按 action 判断」 | ✅ 自洽。当前 `tool-render.ts:144` 的 `typeof details.status !== "string"` guard 对 list/cancel 会误判，FR-9 正确要求改。 |
| G2-008（cancelParam.subagentId trim） | 未在 spec 显式声明 | ⚠ Round 2 低优先级，spec 未显式处理。可接受（空串自然进 getMutable 返回 undefined → throw No record）。非新矛盾。 |
| G2-009（renderCall 标题行） | FR-9 明确「start 显示 agent+model；list 显示 list；cancel 显示 cancel {subagentId}」 | ✅ 自洽。 |

**上轮修复整体质量高**，9 个 gap 中 7 个完全自洽，2 个（G2-001、G2-002/003、G2-005）的修复引入了 3 个新 gap（G3-001/002/003）。这是收敛过程中的典型现象——修复一轮发现下一层的边界问题。

---

## 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| Data Lifecycle（完全降级） | 本需求是 tool 接口重构，不改数据模型语义（ExecutionRecord/PersistedAgentRecord/SubagentRecord 字段语义不变，仅加 optional sessionFile + 可选 sessionId） | spec Out of Scope：「执行引擎不动」「history.jsonl 仅向后兼容加字段」 |
| Data Lifecycle（部分追踪：sessionFile/mode 数据流 + cancel 签名 + session 作用域） | FR-7/FR-8/FR-5/FR-6 虽不改数据模型但改数据流/投影/契约/可见性声明——发现 G3-001（mode 类型归属）/G3-002（cancel 查询 API）/G3-003（session 作用域虚假声明），故部分追踪 | FR-5/FR-6/FR-7/FR-8 明确要求 |
| State Machine（完全降级） | 本需求不变更执行状态机（running→done/failed/cancelled，tryTransition CAS 不动） | spec 未引入状态转换变更 |
| State Machine（部分追踪：cancel throw 化对调用方副作用） | FR-5 把 cancel 失败从 boolean false 改为 tool 层 throw——虽不改状态机，但改变 cancel 操作的对外契约。复核结论：service.cancel 签名不变（boolean），list-view 零改动，state machine 侧无新 gap | FR-5/D6 + list-view.ts:873 验证 |

---

## 追踪小结

**3 个新 gap 的共性**：全部是 Round 2 修复**声明层**与**代码现实层**之间的缝隙——

1. **G3-001（类型名归属）**：FR-3「分层职责」block 的文字描述把两个不同类型都叫 SubagentToolDetails。意图清楚（project 内层 / adapter lift 外层），但**类型边界**未澄清。中等阻塞——实现者能推断意图，但 tsc 会逼其做命名决策，不澄清则可能 `as` 绕过。
2. **G3-002（只读查询 API 缺失）**：FR-5 step 1 引用一个不存在的方法。中等阻塞——实现者必须新增 service 方法或误用 collectRecords。
3. **G3-003（session 作用域虚假声明）**：FR-6 声称的结果与代码实际行为不符。低-中阻塞——可修 spec声明（零代码改动）或加 sessionId 字段（数据模型微调）。

**建议主 agent 优先级**：G3-002 > G3-001 > G3-003。G3-002 直接影响 AC-9 的错误文案能否实现；G3-001 影响类型层级决策（早决定早避免 rework）；G3-003 可用最低成本（改 spec 声明）收敛。

**未覆盖的 Round 1/2 gap 均已自洽处理**（G-001~G-021 + G2-001~G2-009 中除衍生 G3 的外全部自洽）。

Round 3 完成，**未收敛**（3 个新 gap）。
