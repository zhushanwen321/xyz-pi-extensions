---
verdict: fail
must_fix: 14
complexity: L1
---

# Plan Review v3 — Pi Plan Mode Extension

## 评审记录

- **评审时间：** 2026-06-11
- **评审类型：** Plan 评审（Mode 1: 验证 plan 可实施性）
- **评审对象：** `.xyz-harness/2026-06-11-plan-mode/plan.md` 及关联 `e2e-test-plan.md` / `test_cases_template.json` / `use-cases.md` / `non-functional-design.md`
- **前序评审：** plan_review_v1.md（10 项 MUST FIX）、plan_review_v2.md（10 项 MUST FIX，含 v1 独立验证）
- **评审模式：** 独立 v3 验证 + v2 全部 10 项 + v1 全部 10 项的回归验证
- **交叉对照：** spec.md（v2 已通过）、plan-mode-design.md、`extensions/coding-workflow/lib/tool-handlers.ts:498-590`（compact 参考实现）、`extensions/goal/src/index.ts:422`（`__goalInit` 实际签名）、`extensions/goal/package.json`（项目其他 extension 字段）、根目录 `extension-dependencies.json`（dependency 注册现状）、Pi SDK 0.73.1 事件签名

## 总体评估

**v2 评审的所有 10 项 MUST FIX 全部未修复**。当前 plan.md 与 v2 评审时内容基本一致，主要 MUST FIX 问题原封不动地保留：

- M2（`complete` 不触发 `handlePlanComplete`）— Task 6 的 `case "complete"` 块仍只设置 `phase = "complete"` 并返回
- M3（`ctx.compact()` 双重错误处理）— Task 7 `case "compact"` 仍用 `try { ... } catch { fallback }` 包裹
- M4（`/plan abort` 子命令缺失）— Task 5 `command.ts` 仍只识别 4 种情况，无 `abort` / `status` 解析
- M5（重入逻辑缺失）— Task 5 未处理 "未激活 + 已有 plan 文件" 场景
- M6（SKILL.md 缺 subagent 检测）— Task 8 SKILL.md 仍只到 Phase C/D，缺 Phase D3 Implementation Handoff
- M7（SKILL.md 缺 ask_user 工具规范）— Task 8 SKILL.md B2 章节未提 `ask_user` / `ask_user_question`
- M8（`onError` 签名错误）— Task 7 仍写 `onError: () => {...}`，与 SDK 实际 `(error: Error) => void` 不符
- M9（`extension-dependencies.json` 未更新）— plan 整个文件无 `extension-dependencies.json` 修改项；根目录文件当前 12 个 extension 中**无 `@zhushanwen/pi-plan`**
- M10（`package.json` 字段不一致）— Task 1 `main: "index.ts"`（项目其他用 `"src/index.ts"`）、`keywords` 缺 `"extension"`、无 `license`、无 `peerDependencies`
- N1（`tree` case 错误注入 steer）— Task 7 `case "tree"` 仍调用 `pi.sendUserMessage(steerMessage, ...)`

**v3 新发现 4 项 MUST FIX**（N11~N14），均经过独立证据验证：

- N11：`index.ts` 的 `const state: PlanState` 是工厂函数级闭包变量，**所有 session 共享同一个 `state` 对象**——`session_start` 的 `Object.assign(state, reconstructed)` 会用后启动 session 的状态覆盖先启动 session 的状态。这是 v2 漏掉的关键 multi-session isolation bug，直接违反 AC-11
- N12：plan 缺 Task 用于更新 `CLAUDE.md` 目录结构——CLAUDE.md `[MANDATORY]` 规定 "新增/删除/重命名 extension 后必须同步更新本文件（CLAUDE.md）的目录结构"
- N13：plan 缺 changeset 创建任务——项目 `pnpm changeset` 流程要求新包发布时必须配套 changeset
- N14：plan 内部结构矛盾——File Structure 表把 `command.ts` 标为 BG1、把 `tool.ts` 描述为 "plan tool 注册 + 5 个 action handler"（跨 Task 2 BG1 + Task 6 BG2）；Execution Groups 把 Task 5（command）放在 BG3、把 Task 6 / 7（tool action handler / compact）放在 BG2。两套任务分配自相矛盾

## v2 回归验证（10 项）

| v2 项 | 状态 | 证据 |
|-------|------|------|
| M2 (`complete` 不触发 `handlePlanComplete`) | ❌ **未修复** | plan.md Task 6 `case "complete"` 块仍只 set phase + persist + return；grep `handlePlanComplete` 全文仍只有 Task 7 一处定义，无调用方 |
| M3 (compact 双重错误处理) | ❌ **未修复** | plan.md Task 7 `case "compact"` 仍写 `try { ctx.compact({...}) } catch { ctx.ui.notify("Compact failed, ...", "warning"); pi.sendUserMessage(steerMessage, ...); }` |
| M4 (`/plan abort` 子命令缺失) | ❌ **未修复** | Task 5 `command.ts` handler 仍只识别 active+empty / active+text / inactive+text 三种情况；无 `if (trimmed === "abort")` 分支；无 `if (trimmed === "status")` 分支 |
| M5 (重入逻辑缺失) | ❌ **未修复** | Task 5 handler 走简单的 `isActive` 判断，spec FR-1.3 要求的 4 选项对话框（继续/实现/新建/取消）无任何实现 |
| M6 (SKILL.md 缺 subagent 检测) | ❌ **未修复** | Task 8 SKILL.md 模板仍只到 Phase C (Writing) + Phase D (Completion)；FR-6.1~6.3 的 subagent 能力检测步骤完全缺失 |
| M7 (SKILL.md 缺 ask_user 工具) | ❌ **未修复** | Task 8 SKILL.md B2 章节仍只写 "Ask 2-3 questions at a time"；未提及 `ask_user` / `ask_user_question` 工具 |
| M8 (`onError` 签名错误) | ❌ **未修复** | Task 7 `onError: () => {...}`，与 SDK `CompactOptions.onError?: (error: Error) => void` 不一致 |
| M9 (`extension-dependencies.json` 未更新) | ❌ **未修复** | 根目录 `extension-dependencies.json` 当前 12 个 extension 仍无 `pi-plan` 条目；plan.md File Structure 列表无 `extension-dependencies.json` 修改项 |
| M10 (`package.json` 字段不一致) | ❌ **未修复** | Task 1 package.json：`main: "index.ts"`（项目其他用 `src/index.ts`）、`keywords: ["pi-package"]`（缺 `extension`）、无 `license: "MIT"`、无 `peerDependencies` |
| N1 (`tree` case 错误注入 steer) | ❌ **未修复** | Task 7 `case "tree"` 块仍执行 `pi.sendUserMessage(steerMessage, { deliverAs: "steer" })`；与 spec FR-5.4 / plan-mode-design.md 5.4 / D2 三处来源的 "tree 只通知不注入" 不符 |

**结论：v2 全部 10 项 MUST FIX 全部未修复。**

## v3 新发现 MUST FIX（4 项）

### N11. 工厂函数级 `const state` 闭包变量导致多 session 状态互相覆盖（AC-11 直接违反）

**位置：** plan.md Task 5 `extensions/plan/src/index.ts` 行 909-924

**严重度：** must_fix

**问题：** 当前实现把 `PlanState` 缓存在工厂函数闭包内：

```typescript
export default function planExtension(pi: ExtensionAPI) {
  const state: PlanState = { ...DEFAULT_PLAN_STATE };  // ← 所有 session 共享

  // ...
  registerPlanTool(pi, state, persistPlanState);
  registerPlanCommand(pi, state, updateWidget);

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const reconstructed = reconstructPlanState(ctx);
    Object.assign(state, reconstructed);  // ← 覆盖共享对象
  });
}
```

`pi` 进程内可能同时存在多个 session（如不同 worktree、临时 session）。Pi 的 extension 工厂函数对每个进程**只调用一次**——所有 session 共享同一个 `planExtension` 调用产生的闭包，因此共享同一个 `state` 对象引用。

**多 session 时的灾难性时序：**
1. Session A `session_start` 触发 → `Object.assign(state, A_state)` —— `state` 现在是 A 的
2. 用户在 A 中执行 `/plan 添加认证` → A 调用 command，state 更新为 A 的 brainstorming 状态，持久化到 A 的 sessionManager
3. Session B `session_start` 触发 → `Object.assign(state, B_state)` —— **`state` 现在是 B 的，A 的状态被静默丢弃**
4. A 的用户继续操作（如调用 `plan` tool (abort)）→ 操作的是 B 的 state，**导致 A 的 session 状态错乱**（可能错误地 abort B 的 plan、或在 B 的 plan 上添加 A 的 requirement）

这直接违反 **AC-11**（同一 Pi 进程多 session 时 plan 状态互不干扰）和 **spec FR-9.1**（Plan session 状态存储在 `ctx.sessionManager`，per-session 隔离，不用闭包变量）。

CLAUDE.md 已经明确警告过这种模式：
> **状态必须存储在 `session_start` 重建的闭包变量或 `ctx.sessionManager` entries 中**
> `todo` 扩展的 `let todos` 是已知的违反——当前单 session 使用不会有问题，但多 session 时需要重构为闭包内状态

注意原话是"重建的闭包变量"——意味着**每个 session 独立闭包**（用 `Map<sessionId, state>` 形式），而不是所有 session 共享一个变量。

**修复方向：** 两种等价方案，二选一：
- **方案 A（推荐）：** 在工厂内用 `Map<string, PlanState>` 缓存，`session_start` 时按 sessionId 索引；`session_end` 时清理。Tool / command 接收 `ctx` 参数时按 `ctx.sessionId` 取状态
- **方案 B：** 彻底去掉闭包缓存，所有读写都通过 `ctx.sessionManager.getEntries()` 走 `reconstructPlanState` / `persistPlanState`。代价：每次 command/tool 调用都要反序列化，性能略差但 multi-session 安全

无论哪种方案，task descriptions 都需要明确写出 session 隔离设计。

### N12. 缺更新根目录 CLAUDE.md 目录结构的任务（项目 [MANDATORY] 约定违反）

**位置：** 根目录 `/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-plan-mode/CLAUDE.md` 的 "Monorepo 架构" 段落和"当前包清单"段落

**严重度：** must_fix（违反 CLAUDE.md `[MANDATORY]` 条款）

**问题：** CLAUDE.md 强制规定：

> **新增/删除/重命名 extension 后必须同步更新本文件（CLAUDE.md）的目录结构**，防止 AI 因目录信息过时而定位失败

新 plan extension 应该在以下位置加条目：
- "Monorepo 架构" 的 extensions 列表：`extensions/plan/ → @zhushanwen/pi-plan`
- "当前包清单" 的 `extensions/` 表格：包名 `@zhushanwen/pi-plan`、npm name、说明 "Plan mode"、内嵌 Skills "plan-mode"

plan.md 完全没有对应 Task。File Structure 列表中 `shared/types/mariozechner/index.d.ts` 有 modify 项，但 `CLAUDE.md` 没有 modify 项。

**修复方向：** 在 plan.md 增加一个 Task（建议在 Task 1 之前作为 "Task 0: 项目结构同步"），内容：
- 修改 `CLAUDE.md` 添加 `@zhushanwen/pi-plan` 到 "Monorepo 架构" 目录树
- 修改 `CLAUDE.md` 添加 `@zhushanwen/pi-plan` 到 "当前包清单" 表格
- 修改 `CLAUDE.md` 顶部项目结构图，添加 `extensions/plan/` 行

### N13. 缺 changeset 创建任务（项目版本管理必需）

**位置：** 根目录 `.changeset/` 目录

**严重度：** must_fix

**问题：** CLAUDE.md 规定：
> **核心原则：各包独立版本号，通过 changeset 管理。**

新包 `@zhushanwen/pi-plan` (version 0.1.0) 需要配套 changeset 条目（`.changeset/<random-name>.md`），格式：

```markdown
---
"@zhushanwen/pi-plan": minor
---

Add new `@zhushanwen/pi-plan` extension: lightweight plan mode with brainstorming + writing-plans capabilities
```

plan.md 完全没有 changeset 任务。`.changeset/` 当前只有 `config.json`，无任何变更提案。

**修复方向：** 在 plan.md 增加 "Task 0.5: Changeset 创建" 或归入 Task 1 的 Step 0：
- 创建 `.changeset/<feature-slug>.md`，frontmatter 指定包名和 bump 类型（minor 用于新包首版本，patch 用于 bugfix，major 用于 breaking change）
- 简述功能变更

### N14. 任务分配 / 文件结构内部矛盾（Task 5 BG 归属、tool.ts 跨组）

**位置：** plan.md "File Structure" 表格 vs "Execution Groups" BG1/BG2/BG3 段落

**严重度：** must_fix（影响 subagent 派遣正确性）

**问题 1：** File Structure 标 `extensions/plan/src/command.ts | create | BG1`，但 Execution Groups 列 "BG3: TUI + SKILL.md" 包含 "Task 5, Task 8"。Tasks 章节中 Task 5 是 `/plan Command 注册`——command.ts 应该在 BG1（依赖 state 类型）而不是 BG3（依赖 BG1+BG2）。同时 File Structure 中 BG3 只有 widget.ts + SKILL.md 共 2 个文件，与 BG3 "Files (预估): 2 个文件" 一致，但 Task 列表把 command (Task 5) 算入 BG3 是错的。

**问题 2：** File Structure 标 `extensions/plan/src/tool.ts | create | BG1`，描述 "plan tool 注册 + 5 个 action handler"。但 Tasks 章节把 tool 注册放 Task 2 (BG1)、把 5 个 action handler 放 Task 6 (BG2)。一个文件被分到两个 BG，subagent 派遣时会冲突（BG1 完成后文件被释放给 BG2，但 BG2 subagent 不知道需要重读）。

**修复方向：** 修正两个矛盾：
- Task 5 (Command) 应该归 BG1（依赖 state 类型，不依赖 templates/compact）
- tool.ts 应该**整体在 BG1**（Task 2 完成时实现 5 个 action handler stub），或者**整体在 BG2**（Task 2 仅在 BG1 写 schema+validateAction，BG2 加 handler）——二选一
- 同步更新 File Structure 表格的 BG 列和 Execution Groups 的 Files (预估) 数字

## v2 LOW 验证（10 项）

| v2 LOW 项 | 状态 |
|-----------|------|
| L1 (complete action 缺 cleanup state.templateName) | ❌ 未修复（Task 6 complete case 仍无 reset） |
| L2 (模板优先级测试覆盖) | ❌ 未修复（Task 4 测试仍只验证 builtin 列表） |
| L3 (no build step 声明) | ❌ 未修复（plan 顶部 Architecture 段落未声明 "无编译步骤"） |
| L4 (create-template 路径遍历防护) | ❌ 未修复（Task 6 `create-template` 仍用裸字符串拼接） |
| L5 (e2e-test-plan TS-5 与 plan 不符) | ❌ 未修复（TS-5 仍假设 compact 实际执行，但 M2 未修复时不会） |
| L6 (TC-1-02 与 spec FR-1.3 冲突) | ❌ 未修复（TC-1-02 仍描述 "无描述时直接进入 plan mode"） |
| L7 (UC-2 abort 覆盖不全) | ❌ 未修复（UC-2 main flow 9 步无 abort 触发） |
| L8 (non-functional-design 缺 Observability) | ❌ 未修复（仍无错误日志策略说明） |
| L9 (compaction 缺 firstKeptEntryId/tokensBefore) | ❌ 未修复（Task 7 handler 返回仍只含 summary） |
| L10 (GoalInitFn 类型) | ✅ 非缺陷（与 coding-workflow 一致），仍作信息记录 |

**结论：v2 全部 10 项 LOW 中 9 项未修复（L10 非缺陷除外）。**

## 跨文件一致性检查

| 检查项 | plan.md | e2e-test-plan.md | test_cases_template.json | use-cases.md | non-functional-design.md | 结论 |
|--------|---------|------------------|--------------------------|--------------|--------------------------|------|
| AC 覆盖 | 11/11 (matrix) | 9 scenarios, 11 AC | 18 cases, 11 AC | 4 UCs, 8 AC explicit | 未涉及 AC 维度 | 一致（覆盖率同 v2） |
| 模板数量 | 5 builtin | 未涉及 | 未涉及 | 4 UCs 引用 4 templates | 未涉及 | 一致 |
| 状态机 | 4 phases | 同 | 同 | 同 | 同 | 一致 |
| 隔离方式 | 3 options (compact/tree/direct) | TS-5/6 覆盖 2 (compact/direct) | TC-5/6 覆盖 2 | UC-3 提及 direct | §1 稳定性 | **不一致**——plan 提 3 options 但测试仍只覆盖 2 |
| Extension 依赖 | 未涉及 | 未涉及 | 未涉及 | UC-1 提及 goal extension | 未涉及 | **缺失** |
| Subagent 检测 | SKILL.md 缺失 | 未涉及 | 未涉及 | UC-1 提及 "wave 并行开发" | 未涉及 | **不一致**——UC 描述了 subagent 能力但 SKILL.md 无对应步骤 |
| Multi-session 隔离 | N11 缺陷 | TS-9 覆盖（仅测试层） | TC-9-01 覆盖 | 未涉及 | §2 简述 | **不一致**——TS-9 / TC-9-01 测试通过需要 N11 修复 |

## 关键正面观察（与 v2 相同）

- **AC 覆盖矩阵完整**：plan.md Spec Coverage Matrix 覆盖 AC-1~AC-11
- **接口契约清晰**：state、tool、templates、compact 四个模块函数签名定义完整
- **测试驱动结构正确**（除 Task 5 缺 TDD 步骤）：每个 Task 都有 Step 1 (写失败测试) → Step 2 (验证失败) → Step 3 (实现) → Step 4 (验证通过) → Step 5 (commit) 循环
- **Vitest 配置正确**：与项目其他 extension 一致
- **依赖模板系统设计合理**：project > global > builtin 优先级明确
- **Goal API 引用正确**：`__goalInit` 实际存在于 `extensions/goal/src/index.ts:422`
- **Pi 事件名使用正确**（v2 已验证）：`session_before_compact` / `session_before_tree` 是 SDK 中用于自定义 compaction/tree summary 的正确事件

## 修复优先级建议

按修复优先级（dev 阶段阻断性）：

1. **第一批（dev 会立即阻断）：** M2 + M3 + M8 + N11（核心控制流和 API 错误）
2. **第二批（spec 行为完整性）：** M4 + M5 + M6 + M7 + N1（subcommand、重入、SKILL.md 完整性）
3. **第三批（pre-commit hook 阻断）：** M9 + M10 + N12 + N13（项目约定）
4. **第四批（结构清晰度）：** N14（任务分配内部矛盾）
5. **LOW（信息改进）：** L1~L9（不阻塞但应同步修复以保证 v4 评审无遗留）

## 结论

**Fail。** v3 评审对 v2 全部 10 项 MUST FIX 做严格回归验证——**全部未修复**。v3 独立新发现 4 项 MUST FIX（N11 multi-session isolation bug、N12 CLAUDE.md 缺失更新任务、N13 changeset 缺失、N14 任务分配内部矛盾）。综合 14 项 MUST FIX，dev 阶段会立即遇到 4 类阻断：

1. **`complete` 不触发退出流程**（M2）—— 退出 plan mode 时无 compact、无 goal init、无 steer
2. **多 session 状态互相覆盖**（N11）—— 违反 AC-11
3. **`/plan abort` 命令不工作**（M4）—— 用户无法取消 plan
4. **pre-commit hook 阻断**（M9 + M10）—— extension-dependencies.json 缺失 + package.json 字段不匹配

修复全部 14 项 MUST FIX 后，dev 阶段可正常推进。**v3 特别提示：N11 是 v2 评审漏掉的关键 bug**，v4 评审应优先验证此项已修。

## 评审元数据

```yaml
review:
  type: plan_review
  round: 3
  timestamp: "2026-06-11T14:30:00+08:00"
  target: ".xyz-harness/2026-06-11-plan-mode/plan.md"
  related:
    - e2e-test-plan.md
    - test_cases_template.json
    - use-cases.md
    - non-functional-design.md
  verdict: fail
  summary: |
    v2 全部 10 项 MUST FIX 未修复。v3 新发现 4 项 MUST FIX（其中 N11 multi-session
    isolation bug 是关键 AC-11 违反）。综合 14 项 MUST FIX，dev 阶段会立即遇到
    4 类阻断：complete 不触发退出流程、多 session 状态互相覆盖、/plan abort 不工作、
    pre-commit hook 阻断。

statistics:
  total_issues: 24
  must_fix: 14
  low: 10
  must_fix_breakdown:
    - category: "Pi runtime API 错误"
      count: 1
      items: [M8]
    - category: "核心控制流未接线"
      count: 4
      items: [M2, M4, M5, N11]
    - category: "spec 行为错误或缺失"
      count: 3
      items: [N1, M6, M7]
    - category: "项目约定违反"
      count: 4
      items: [M9, M10, N12, N13]
    - category: "Pi compact 错误处理"
      count: 1
      items: [M3]
    - category: "plan 内部结构矛盾"
      count: 1
      items: [N14]
  v2_validation:
    confirmed_unfixed: 10  # M2-M10, N1
    new_in_v3: 4  # N11, N12, N13, N14
    false_positive_in_v2: 0
  v1_validation:
    confirmed_unfixed: 9  # M2-M10 (M1 已在 v2 验证为 false positive)
```
