# Tracing Round 2（收敛复核）

> 由独立追踪 subagent（fresh context，Round 2 收敛复核）产出，主 agent 落盘。

## 收敛状态：CONVERGED（附带 4 个非阻断观察项）

**已追踪视角**：全部 5 视角完整重跑（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path），无降级。

**判定依据**：Round 1 的 18 个 gap 经 spec 修订（FR-1~FR-6 + IC-1~IC-7 + AC-1~AC-14）已全部消解，5 视角重跑未发现新的阻断性 gap。仅余 4 个非阻断观察项（O2-xxx），供 Phase 2 实现参考，不阻断 spec 收敛。

## 追踪范围
- **spec 版本**：2026-06-16-session-category-model-confirm/spec.md（修订后，已处理 Round 1 的 18 个 gap）
- **已验证源码**：
  - `extensions/subagents/src/tools/subagent-tool.ts`（execute 签名 208-225 行确为 4 参数；拦截点 285/288/303 行顺序确认）
  - `extensions/subagents/src/state/session-model-state.ts`（serializeState/restoreState/createSessionModelState 仅处理 3 字段，确认需同步改）
  - `extensions/subagents/src/types.ts:400-404`（SessionModelState 无 categoryConfirmed）
  - `extensions/subagents/src/resolution/config-merger.ts`（5 级链确认）
  - `extensions/subagents/src/resolution/model-resolver.ts`（resolveModelForAgent 签名 + agentConfig 可 undefined）
  - `extensions/subagents/src/runtime.ts`（restoreFromEntries 倒序取最新 300-309；resolveModelForScene 798-815 用 agentConfig:undefined+category:scene 模式；setSessionCategoryModel 330-333 单次 persistState）
  - `extensions/subagents/src/category.ts`（DEFAULT_CATEGORIES 6 个 + inferCategory）
  - `extensions/subagents/src/index.ts:26-43`（session_start 在 new/resume/fork 均触发 restoreFromEntries）
  - `pi-coding-agent types.d.ts`（ExtensionContext.hasUI/ui；ToolDefinition.execute 第 5 参数 ctx；ExtensionUIDialogOptions 仅 signal/timeout）
  - `pi-coding-agent interactive-mode.js:1575-1599`（showExtensionSelector：Esc=resolve(undefined)，选中=resolve(option)）
  - `pi-coding-agent session-manager.js:1013-1047`（forkFrom 复制所有非 header entries，含 custom entries）

## Round 1 的 18 个 gap 消解验证

| Round 1 Gap | 修订位置 | 消解验证 |
|----|----|----|
| G-001 (select 无预选) | FR-2.3 (current) 置顶伪预选 | ✅ 源码确认 select 光标恒在第 0 项，options[0]=(current) + 回车=保留，方案可行 |
| G-002 (editCategoryModel 不可复用) | FR-2.2 + IC-2 新写组件 | ✅ config-wizard.ts:88-134 确认无跳过/保留能力，spec 已改为新写组件 |
| G-003 (中途 Esc 语义) | FR-2.6 | ✅ 明确"仅跳过当前 category，继续下一个"；首屏 Esc/取消才取消整个 |
| G-004 (预选实现) | 并入 G-001，FR-2.3 | ✅ |
| G-005 (拦截点 vs 解析顺序) | FR-1.3 + FR-2.4 | ✅ FR-1.3 注明 resolveModelForAgent 在 effectiveWait 之后；FR-2.4 新增弹窗内批量解析 |
| G-006 (category 列表来源) | FR-2.5 | ✅ globalConfig.categories 全量；源码确认 loadGlobalConfig 含 6 默认 + 自定义 |
| G-007 (原子性) | FR-3.1 原子批量写 | ✅ 走完所有 category 后一次性写 + 同次 persistState 标记 confirmed |
| G-008 (serialize/restore 同步) | FR-3.2 + IC-3/IC-4 | ✅ 源码确认两函数仅处理 3 字段，spec 明确要求同步改 |
| G-009 (/new 重置) | FR-3.3 | ✅ /new → 空 entries → restoreFromEntries 找不到 → createSessionModelState 默认 false |
| G-010 (persistState 合并) | FR-3.1 + IC-5 | ✅ 新增 runtime 方法保证同次 persistState；源码确认 persistState 每次写完整快照、restoreFromEntries 倒序取最新 |
| G-011 (execute 缺 ctx) | IC-1 | ✅ 源码确认 execute 仅 4 参数（208-225），types.d.ts:354 确认第 5 参数 ctx |
| G-012 (indexOf 重名) | clarification G-012 决策 | ✅ 新组件用稳定标识回查 |
| G-013 (LLM 重试循环) | FR-4.2 | ✅ 错误信息含"不要重试"，不做退避 |
| G-014 (YOLO 解耦) | FR-1.2 | ✅ 源码确认 yoloMode 仅 toggle/显示，不参与执行决策 |
| G-015 (并发竞态) | — | ✅ executionMode=sequential，无竞态 |
| G-016 (批量解析缺失) | FR-2.4 + IC-7 | ✅ 新增 helper；源码确认 resolveModelForScene 已有 agentConfig:undefined+category 模式可仿照 |
| G-017 (/fork 行为) | FR-3.3 + AC-13 | ✅ 源码确认 forkFrom 复制所有 custom entries → session_start restoreFromEntries 恢复 confirmed |
| G-018 (RPC 模式) | FR-5.2 | ✅ hasUI=false 完全避免调 ctx.ui.* |

**18/18 消解，无残留。**

## 5 视角独立重跑结果

### P1: User Journey — 无新 gap
- 首屏入口（FR-2.1）：三选项 + Esc=取消。✅ select 返回 undefined 的语义在首屏被解释为"取消"——一致。
- 逐 category 级联（FR-2.2/2.3/2.6）：(current) 置顶 + Esc 跳过当前。✅
- 批量跳过（FR-2.7）：见观察项 O2-004（实现细节，非 gap）。
- 强制检查项（成功下一步/中途放弃/重复/权限/超时）：均有覆盖。

### P2: Data Lifecycle — 无新 gap
- SessionModelState：Create（默认 false）/ Read（拦截点读 categoryConfirmed）/ Update（IC-5 原子写）/ 跨 session（resume/fork/new 三路径 FR-3.3 覆盖）。✅
- perCategory：仅写用户改过的 category（FR-3.1），不改全局 config。✅

### P3: API Contract — 无新 gap
- execute(toolCallId, params, signal, onUpdate, ctx)（IC-1 补第 5 参数）。✅
- 错误码：FR-4.1 取消抛错 + "不要重试"提示。✅
- 幂等：confirmed 标志保证同 session 内仅弹一次。✅
- 边界：hasUI=false（FR-5.2）、查询模式（FR-6.2）。✅

### P4: State Machine — 无新 gap
- categoryConfirmed 状态机：false →（确认完成）→ true。合法转换唯一。
- 非法转换：无（confirmed 单向；/new 经 createSessionModelState 重置为 false 是新 session 不是回退）。✅

### P5: Failure Path — 无新 gap
- F-取消：FR-4.1/4.2 覆盖。✅
- F-RPC：FR-5.2 覆盖。✅
- F-解析失败：见观察项 O2-002（非阻断）。
- F-部分写：FR-3.1 原子批量写消除。✅
- F-并发：sequential 无竞态。✅

## 非阻断观察项（供 Phase 2 实现 reference，非 gap）

| ID | 类型 | 视角 | 观察 | 建议 |
|----|------|------|------|------|
| O2-001 | F | User Journey / API Contract | FR-2.6 中途 Esc 与首屏 Esc 都使 `ctx.ui.select` 返回 `undefined`（源码 Esc=resolve(undefined)）。新组件需**根据调用位置（是否在 category 遍历循环内）区分**两种 undefined 语义（首屏=取消整个；逐 category=跳过当前）。spec FR-2.6 已正确描述行为，但未显式提醒"靠调用位置区分而非返回值区分"。 | 实现细节，spec 无需改。 |
| O2-002 | F | Failure Path / Data Lifecycle | FR-2.4 批量解析（IC-7）对每个 category 调 resolveModelForAgent。若某 category 配置链全部不可用会 **throw**（model-resolver.ts:126-129）。spec 未说明批量解析中单个 category 抛错时其它 category 如何处理。 | 建议 IC-7 helper 对单个 category try/catch 隔离，失败 category 展示"(unavailable)"或不置顶 (current)。非阻断，实现时应处理。 |
| O2-003 | F | State Machine | FR-2.4/IC-7 批量解析复用 mergeConfig，其中 perCategory（第 3 级）会被读。若本 session 已有 perCategory 覆盖，批量解析会把它作为 (current) 展示。行为正确，但 spec 未点明"(current) = mergeConfig 链最终值，非全局 config 默认"。 | 行为正确，spec 无需改。提示实现者：(current) = mergeConfig 结果。 |
| O2-004 | D | User Journey | FR-2.7「批量跳过」入口未完全钉死——"开始前/进行中提供快捷项"。若是 select 选项则插入遍历循环每步；若是首屏第 4 选项则与"全部用默认并记住"语义重叠。 | 实现决策：建议作为遍历循环内每步 select 的额外 option，与首屏"全部用默认并记住"区分。非阻断，Phase 2 定。 |

## 总结
- **新 gap 数量**：0（无 G2-xxx 阻断性 gap）。
- **非阻断观察项**：4 个（O2-001~O2-004，均为实现细节提示，不需 spec 修订即可进入 Phase 2）。
- **阻断性遗漏**：无。
- **spec 完整性评价**：修订后 spec 内部一致（FR 之间、AC 与 FR、IC 与 FR 均对应），18 个原 gap 全部消解且有源码事实支撑。IC-3↔IC-4↔IC-5 的 types/serialize/runtime 三处同步、IC-6 依赖 IC-1 的 ctx 参数、IC-7 依赖 IC-2 的展示——依赖关系清晰。
- **收敛结论**：**CONVERGED**。spec 可进入 Phase 2 实现。
