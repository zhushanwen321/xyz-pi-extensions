# Tracing Round 2

## 追踪范围
- spec 初稿版本：已消化 Round 1 的 19 个 gap，含 FR-1~FR-6 + AC-1~AC-10
- 追踪的视角：User Journey / Data Lifecycle / API Contract / State Machine / Failure Path（全部 5 视角，无降级）

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-R2-001 | D | State Machine + API Contract | FR-3 + FR-4 | `recorded` 状态的自动转换机制未指定。FR-3 定义 recorded 触发条件为 `errorCount >= errorThreshold`，FR-4 将 tool status 枚举限定为 `completed/error/cancelled`（agent 不能手动设 recorded）。但 spec 未说明：(a) 自动转换发生在何处——update handler 立即触发还是 turn_end 延迟触发？(b) 当前 `errorForceRecordPrompt` steering（提示 agent 调 `status=recorded`）的去向——既然 agent 不再能手动设 recorded，该 steering 是否废弃？(c) 若在 update handler 中 agent 调 `status=error` 且 errorCount 达阈值，系统是否在同一 handler 中将 status 覆写为 `recorded` 并返回？当前代码（core.ts:492-497）在 error 阈值达到时只发 steering prompt 不做状态转换，新行为与此不同，需明确。 |

## 降级视角记录（如有）

无。全部 5 视角均适用且已追踪。

## 追踪详情

### P1: User Journey

**OP-U01: agent 调 use_skill(start)**
- 主路径：agent 调 `use_skill(start, name="X")` → name 校验 → 创建 TrackedItem → 返回 createdId + steering → agent 按 skill 执行 → 调 `use_skill(update, id=X, status=completed)`
  - [VERIFIED: FR-2, AC-1]
- 分支 B1: name 不存在 → 返回 "skill not found" [VERIFIED: AC-8]
- 分支 B2: 同名 skill 连续 start → 两个独立 item [VERIFIED: FR-2 去重策略]
- 分支 B3: 路径缺失 → metadata.skillMdPath 留空，不阻断 [VERIFIED: FR-2]
- 强制检查项：成功后下一步(update)✓、中途放弃(cancelled)✓、重复操作(no dedup)✓、权限(agent 全权)✓、超时(abandoned 20turn)✓

**OP-U02: agent 调 use_skill(update)**
- 主路径：验证 id 存在 → canTransition 校验 → 执行转换 → persist
  - [VERIFIED: core.ts execute handler]
- 分支 B1: 非法转换 → 报错 [VERIFIED: AC-2, core.ts canTransition]
- 分支 B2: id 不存在 → 报错 [VERIFIED: core.ts findIndex]
- 分支 B3: 缺参数(id/status) → 报错 [VERIFIED: core.ts param checks]

**OP-U03: agent 调 use_skill(list)**
- 主路径：返回所有 item（含终态）[VERIFIED: AC-3, core.ts]

### P2: Data Lifecycle

**Entity: TrackedItem**
- Create: 由 use_skill(start) 触发，name 必填，初始状态 loaded [VERIFIED: types.ts createInitialState]
- Read: agent(list) / 系统(turn_end/remind) [VERIFIED: core.ts]
- Update: status/detail 可变，id/name/metadata 不可变，canTransition 校验 [VERIFIED: core.ts]
- Delete: 无显式删除；终态 item 在 reconstructState 中被过滤 [VERIFIED: core.ts reconstructState]
- Lifecycle: loaded → completed/error/cancelled/abandoned → recorded(仅 error→)
- 唯一性：无约束（支持频次统计）[VERIFIED: FR-2]
- 增长：abandoned 机制兜底 + reconstructState 过滤终态 [VERIFIED: FR-4 + core.ts]

**数据迁移**：deserialize 遇到 dismissed 直接丢弃 [VERIFIED: FR-3]

### P3: API Contract

**use_skill(start)**:
- Input: `{action:"start", name:string, path?:string}`
- Output success: `{action:"start", items, createdId}` + steering [VERIFIED: FR-1]
- Output error: name 不存在 → error [VERIFIED: AC-8]
- Idempotency: 不幂等（每次 start 独立 item）[VERIFIED: FR-2 设计意图]

**use_skill(update)**:
- Input: `{action:"update", id:number, status:completed|error|cancelled, detail?:string}`
- Output success: `{action:"update", items, trackerName, updatedId}` [VERIFIED: core.ts]
- Errors: id 不存在 / 非法转换 / 缺参数 [VERIFIED: core.ts]
- Side effects: status=error 时 errorCount++，达阈值发 steering [VERIFIED: core.ts:492-497]

**use_skill(list)**:
- Input: `{action:"list"}`
- Output: `{action:"list", items, trackerName}` [VERIFIED: core.ts]

**G-R2-001 关联**：tool status 枚举仅 `completed/error/cancelled`（FR-4），但 transition matrix 包含 error→recorded。recorded 不在枚举中意味着 agent 无法通过 tool 触发此转换。转换由系统触发，但触发位置和时机未指定。

### P4: State Machine

**6 状态**：loaded, completed, error, cancelled, abandoned, recorded [VERIFIED: FR-3]

**合法转换矩阵**：
| From | To | 触发方 | 验证 |
|------|----|--------|------|
| loaded | completed/error/cancelled | agent update | ✓ FR-3 |
| loaded | abandoned | 系统 turn_end | ✓ FR-4 |
| error | completed/error/cancelled | agent update | ✓ FR-3 |
| error | recorded | 系统(errorCount>=threshold) | ⚠️ 机制未指定(G-R2-001) |
| error | abandoned | 系统 turn_end | ✓ FR-4 |

**终态不可变更**：completed/recorded/cancelled/abandoned [VERIFIED: FR-3, types.ts isTerminalStatus]

**非法转换处理**：报错返回当前状态 [VERIFIED: AC-2, core.ts canTransition]

**僵尸状态检查**：所有状态可达（loaded=start, completed/error/cancelled=agent, abandoned=turn_end, recorded=errorCount 阈值），所有非终态可退出。无僵尸状态。✓

**abandoned 检查顺序**：先于 remind [VERIFIED: FR-4 "turn_end 中 abandoned 检查先于 remind"]

### P5: Failure Path

**F-start: skill name 不存在**
- 类型：输入无效 | 检测：name 校验 | 恢复：报错，agent 可重试 | 数据一致：无影响 ✓

**F-update: id 不存在**
- 类型：输入无效 | 检测：findIndex=-1 | 恢复：报错 | 数据一致：无影响 ✓

**F-update: 非法状态转换**
- 类型：状态冲突 | 检测：canTransition=false | 恢复：报错含当前状态 | 数据一致：无影响 ✓

**F-turn_end: abandoned 自动终结**
- 正常路径，非故障。loaded/error 超 20 turn → abandoned。先于 remind。✓

**F-session restore: stale context**
- 类型：资源不可用 | 检测：isStaleContextError | 恢复：state 重置为初始，warn 日志 | 数据一致：tracking 丢失（可接受）✓

**F-persist: stale context during persist**
- 类型：资源不可用 | 检测：isStaleContextError | 恢复：skip persist，下次重试 | 数据一致：暂态丢失 ✓

**F-compact 后 reconstructState turnCount 降低**
- compact 删除旧 message 后 turnCount 降低，loadedAtTurn 不变，turnsSinceLoad 可能低于阈值。但 turn_end 持续触发，下一个 turn_end 会重新计算。仅影响 compact 后立即 abandon 判断的精确性。非关键问题，turn_end 兜底。✓

**F-G-R2-001 关联：error 达阈值后 recorded 转换时序**
- 若 auto-record 在 update handler：agent 调 status=error 但返回 status=recorded（行为 surprise）
- 若 auto-record 在 turn_end：error 状态持续到下个 turn_end 才转 recorded（延迟）
- 两种选择行为差异大，需明确指定

## Round 1 Gap 覆盖确认

Round 1 的 19 个 gap 均已在 spec 中处理（丢弃/消化/问用户后决策）。本轮未发现 Round 1 gap 的遗漏。唯一新发现为 G-R2-001（recorded 自动转换机制），属于 FR-3/FR-4 交叉区域的设计空白。
