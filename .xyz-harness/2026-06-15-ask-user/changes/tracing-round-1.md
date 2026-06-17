# Tracing Round 1

## 追踪范围
- spec 初稿版本：ask-user extension（FR-1 到 FR-10，AC-1 到 AC-12，Decisions D1-D17）
- 追踪的视角：User Journey、Data Lifecycle、API Contract、State Machine、Failure Path（全 5 视角，无降级——本需求是带交互状态机的工具扩展，5 视角均适用）

## 走查记录

### 视角: User Journey

**OP-U01: 单问题问答（LLM → 用户 → 答案返回）**
- Actor: LLM（调用方）+ 用户（答题方）
- Precondition: 有 UI 会话
- Main Path:
  1. LLM 调用 `ask_user`（questions.length===1）→ execute 运行 [VERIFIED: spec FR-8 先检查 hasUI]
  2. `ctx.ui.custom()` 渲染 inline 单问题视图 [VERIFIED: FR-3]
  3. 用户 ↑↓ 移动光标 → Enter 确认（单选）/ Space toggle（多选） [VERIFIED: FR-6]
  4. confirmAndAdvance → isSingle → submit → done(result) [VERIFIED: pi-askuserquestion/component.ts:452-464]
  5. execute 返回 content + details [VERIFIED: FR-7]

- **Gaps:**
  - [F] **G-001**：`execute` 的第 3 参数 `signal: AbortSignal | undefined` 全程未处理。Pi 规范第 4.2/14.2 条要求"异步操作必须透传 signal 参数支持取消"。pi-ask-user 在 customFactory 内注册 `signal.addEventListener("abort", () => done(null))`（index.ts:1628-1631），并在 execute 入口检查 `signal?.aborted`（index.ts:1543）。spec 全文无 signal/abort 字样——用户在问答期间 agent 被 abort（如 goal 取消、compact、session 切换）时，TUI 会挂住直到用户手动操作。
  - [D] **G-002**：`allowComment` 的触发机制未定义。spec FR-4 item 6 说"选中后追加评论输入行"，但未明确是 (a) 选中选项后评论行自动出现，还是 (b) 需要按键（如 pi-ask-user 的 ctrl+g commentToggleKey）触发。两种实现差异大——自动出现会占用屏幕空间强制用户跳过，按键触发更轻量但用户可能不知道有此功能。

**OP-U02: 多问题批量问答**
- Actor: LLM + 用户
- Main Path:
  1. LLM 调用（questions.length 2-4）→ Tab bar + Submit tab 渲染 [VERIFIED: FR-3/FR-5]
  2. 用户逐 tab 回答 ←/→ 切换，autoConfirmIfAnswered 自动确认 [VERIFIED: component.ts:431-444]
  3. Submit tab 全答完 → Enter 提交 [VERIFIED: FR-5]

- **Gaps:**
  - [D] **G-003**：多问题场景下 `timeout` 的语义未明确。timeout 是"整个问答会话的总时长"还是"每个问题的独立计时"？spec FR-9 只写 `setTimeout(() => done(null), timeout)` 单次注册——若为总时长，用户在第 3 个问题上耗尽时间会丢失前 2 个已答数据；若每问题独立，需要在 tab 切换时重置 timer。pi-ask-user 是单次总计时（index.ts:1633-1635），但 spec 未声明此选择。

**OP-U03: Other 自由输入**
- Main Path: 光标移到 Other 行 → Space/Tab 打开内联 Editor → 输入 → Enter 保存 [VERIFIED: FR-4 item 5, FR-6]

- **Gaps:**
  - [D] **G-004**：Other 输入与 multiSelect + allowComment 的三重组合未定义行为。当 multiSelect=true 且 allowComment=true 时：用户勾选选项 A/B，打开 Other 输入自由文本，再追加 comment——最终 answers 字符串的组装顺序和分隔符是什么？pi-askuserquestion 只处理 multiSelect+Other（freeText 追加末尾，component.ts:365），无 comment。spec FR-7 示例只展示了单选带评论 `"label — 评论"`，未给 multiSelect+Other+comment 的组合格式。

---

### 视角: Data Lifecycle

**E01: QuestionState（每问题的交互状态）**
- Create: custom factory 内 `questions.map()` 初始化 [VERIFIED: component.ts:67-74]
- 字段：cursorIndex, selectedIndex, selectedIndices(Set), confirmed, freeTextValue, inEditMode

- **Gaps:**
  - [F] **G-005**：comment 值的存储字段未定义。QuestionState（component.ts:21-34）没有 comment 字段——因为 pi-askuserquestion 无 comment 功能。spec 要新增 comment，需声明 comment 存在哪里（新增 state 字段？还是 answers 直接拼好？）、comment 是否随 confirm 持久、切 tab 再回来 comment 是否保留。
  - [F] **G-006**：`_resolved` guard 标志未在 spec 提及。component.ts:54 有 `private _resolved: boolean = false`，submit/cancel 后置 true，handleInput 入口检查 `if (this._resolved) return`（component.ts:501）。这是防止 done() 被多次调用（timeout + 用户操作竞态）的关键守卫。spec FR-9 描述 timeout 和 Esc 都调 done(null)，但没提防重入守卫——timeout 触发 done 后用户按键不会再触发，需明确。

**E02: Result（返回给 LLM 的 details）**
- Lifecycle: buildResult() 组装 → execute 包装 → renderResult 消费 [VERIFIED: FR-7, component.ts:476-495]

- **Gaps:**
  - [F] **G-007**：multiSelect 答案 join 顺序的描述不精确。spec FR-7 写"多选（按选项序 join）"，但 pi-askuserquestion 实现是：先按 selectedIndices 数字序排序常规选项，再把 freeTextValue push 到末尾（component.ts:362-366）。若用户选了 C（index 2）+ A（index 0）+ Other("自定义")，结果是 "A, C, 自定义"——Other 永远在最后，不参与"选项序"。spec 的"按选项序 join"会让实现者误解为 Other 也排序。

---

### 视角: API Contract

**OP-A01: ask_user tool execute**
- Input: FR-2 schema（questions 数组 + timeout）
- Output 200: FR-7 结构
- Errors: FR-8（hasUI false → isError）、FR-9（AC-9 重复校验 → isError）

- **Gaps:**
  - [F] **G-008**：参数校验（重复 question/label）的返回结构不完整。spec AC-9 只说"返回 isError"，但 pi-askuserquestion 的 validate 返回时 `details.cancelled: true`（index.ts:33-37）且无 `isError` 字段——它返回的是普通 result 而非 isError。spec 说"重复返回 isError"（FR-2 约束），但 FR-7 的取消结构也是 cancelled:true。校验失败到底是 isError:true（LLM 看到 error 会重试修正）还是 cancelled:true（LLM 认为用户取消）？两者对 LLM 行为影响不同，spec 未区分。
  - [F] **G-009**：`header` 字段在单问题时是可选（FR-2 `header?`），但多问题时 spec 说"必填"（FR-2 约束"多问题时必填"）。schema 如何强制条件必填？typebox `Type.Optional(Type.String())` 无法表达"当数组长度>1 时必填"。pi-askuserquestion 的 schema（schema.ts:21-24）把 header 设为必填 `Type.String()`（无 Optional）——单问题也必须传。spec 声称"单问题可省略 header"但未说明 schema 层面如何实现（运行时校验？还是 schema 放宽+运行时兜底？）。
  - [D] **G-010**：`timeout` 参数的边界值未定义。timeout=0 是"无超时"还是"立即超时"？timeout 为负数怎么办？pi-ask-user 用 `if (timeout && timeout > 0)`（index.ts:1633）——0 和负数都跳过。spec FR-9 未声明。LLM 可能传 0 表示"禁用"，需明确。

**OP-A02: renderCall / renderResult**
- **Gaps:**
  - [F] **G-011**：renderCall/renderResult 的返回组件类型未指定。pi-askuserquestion 用 `TruncatedText`/`Box`（index.ts:90,111），pi-ask-user 用 `Text`。规范第 4.1 条示例用 `new Text(...)`。spec FR-10 只描述显示内容，未说返回 `Text` 还是 `TruncatedText`（后者自动截断防溢出，对长 header 更安全）。实现者需选型。

---

### 视角: State Machine

**E01 States（Question 级）**: unanswered → answering → confirmed

**合法转换：**

| From | To | Trigger | Guard | If Guard Fails |
|------|----|---------|-------|----------------|
| unanswered | answering | ↑↓ 移动光标 | — | — |
| answering | confirmed | Enter(单选)/Space(多选) | 有选择 | [GAP: 无选择时 Enter 无反应，用户无反馈] |
| confirmed | answering | ←/→ 离开 tab（autoConfirm）或重新进入修改 | — | — |
| confirmed | submitted | Submit tab Enter | allConfirmed | Submit 阻塞 |

- **Gaps:**
  - [D] **G-012**：confirmed 后用户能否修改答案（回退到 answering）？spec FR-6 写"←/→ 切 tab（离开多选 tab 自动确认已有选择）"，但没说"回到已确认 tab 能否改答案"。pi-askuserquestion 允许回到已确认 tab 继续操作（confirmed 标志不阻止 handleInput，只是 Submit 门的条件）——但重新选了新选项后 confirmed 是否更新？renderTabBar 的 `■` 标记会变回 `□` 吗？状态回退的视觉反馈未定义。
  - [F] **G-013**：单问题场景没有 Submit tab，那"confirmed"和"submitted"是否合并？pi-askuserquestion 在 isSingle 时 confirmAndAdvance 直接调 submit()（component.ts:453-455）——单问题无 confirmed 中间态，选了就提交。spec FR-3 说"答完即提交（无 Submit tab）"符合，但 FR-4 的"可选评论（已选中选项时）"在单问题下何时输入？选中即提交，没机会输 comment——除非 comment 在选中前/同步输入。单问题 + allowComment 的交互路径断裂。

---

### 视角: Failure Path

**F-execute: signal abort（agent 取消）**
- Source: execute 运行中
- Failure Type: 依赖不可用（agent 被外部 abort）
- Condition: goal 取消 / compact / session 切换触发 signal.abort
- **GAP G-001（同上）**：未处理，TUI 挂住。

**F-timeout: timer 泄漏**
- Source: FR-9 setTimeout
- **Gaps:**
  - [F] **G-014**：setTimeout 未 clearTimeout 清理。spec FR-9 写 `setTimeout(() => done(null), timeout)`，用户提前提交后 timer 仍在 event loop 中。pi-ask-user 同样未清理（index.ts:1634）。虽然 `_resolved` guard（G-006）让回调无害，但 timer handle 持有闭包引用直到到期，长 timeout（如 300000ms）期间组件实例无法 GC。spec 未要求清理，但规范第 14.2 条"定时器在 session_shutdown 中清除"暗示应清理。

**F-custom: ctx.ui.custom 异常**
- Source: custom factory 抛错
- **Gaps:**
  - [F] **G-015**：custom factory 内异常的捕获策略未定义。pi-ask-user 在 execute 外层 try/catch 包裹 custom 调用，返回 isError（index.ts:1688-1695）。spec 未提 execute 的顶层错误兜底。规范第 4.2 条"错误必须返回 { isError: true }，禁止抛异常"——但 spec 的 FR 全文未声明 execute 的顶层错误兜底。若 Editor 构造、theme 读取抛错，会带崩 Pi。

**F-concurrent: 并发调用 ask_user**
- Source: LLM 在一次 turn 内两次调用 ask_user
- **Gaps:**
  - [K] **G-016**：两个 ask_user 同时 pending 时行为未知。Pi 的 custom UI 是否排队（第二个等第一个 done）还是覆盖？spec 未提。goal 自动循环可能连续调用。这取决于 Pi 运行时行为，spec 无法自行回答——需确认 Pi 是否串行化 tool execute。

---

## 收敛判定
- 总 gap 数: 16
- F: 10（G-001, G-005, G-006, G-007, G-008, G-009, G-011, G-013, G-014, G-015）
- K: 1（G-016）
- D: 5（G-002, G-003, G-004, G-010, G-012）

**最高优先级 gap（阻塞实现）**：G-001（signal 处理，规范合规+防挂死）、G-002（comment 触发机制）、G-013（单问题+comment 路径断裂）、G-008（校验失败的 isError vs cancelled 语义）。
