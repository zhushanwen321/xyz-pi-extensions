# ADR-033：subagent UI 透传通用化架构（method 交互模型 + channel 注册表两维度正交）

- Status: accepted
- Date: 2026-07-17
- Topic: cw-2026-07-17-fix-subagent-ask-user
- Supersedes: 无（修正 cw-2026-07-17-subagent-ask-user topic 的隐含设计）

## Context

原 topic `cw-2026-07-17-subagent-ask-user` 试图让 subagent 子进程的 `ask_user` tool 通过 `extension_ui_request` 透传到主 agent。closeout 后审查发现端到端完全不可用（AS2 defect=blocker，见 `.fix-plans/00-master-summary.md` §一）。根因之一是 **method 分发缺失**——所有 UI 请求合并到单一 handler，没有区分 dialog 类（等响应）和 fire-and-forget 类（不等响应）。

修复设计阶段，进一步发现更深层的设计缺陷：只盯着 `ASK_USER_MARKER` 一个 case，把 `isAskUser: boolean` 硬编码进类型，无法支撑「subagent 通过主 agent 透传」这个更通用的场景。实测确认：

- `@xyz-agent/extension-protocol` 已有 **2 个 marker** 复用 ctx.ui 通道：
  - `ASK_USER_MARKER = "\0XYZ_ASK_USER"` → 走 `select` method（title 字段）
  - `GUI_WIDGET_MARKER = "\0XYZ_GUI_WIDGET:"` → 走 `setWidget` method（widgetLines[0] 字段）
- marker **不在同一字段**——提取位置依赖 method
- 排队需求（多个 dialog 并发时争输入焦点）本质是 **method 交互模型**的属性，不是 channel 的属性

## Decision

采用**两维度正交**的通用化 UI 透传架构：

### 维度 1：透传 + 排队策略 — 由 method 交互模型决定（Pi 协议固定，自动判定）

Pi rpc-mode.ts:135-303 把 ctx.ui 方法分两类：

| 交互模型 | method | 行为 |
|---|---|---|
| **dialog（占输入焦点，等响应）** | `select` `confirm` `input` `editor` | 子进程注册 pending Promise，父进程必须回 extension_ui_response，否则 Promise 永挂 + 内存泄漏 |
| **fire-and-forget（纯展示/写入）** | `notify` `setStatus` `setWidget` `setTitle` `set_editor_text` | output() 完即返回，不注册 pending |

透传 + 排队矩阵（按主进程 mode）：

| 主进程 mode | dialog 类 | fire-and-forget 类 |
|---|---|---|
| TUI | 透传 + L2 排队 | **不透传**（不影响输入交互） |
| GUI（rpc） | 透传 + L2 排队 | 透传（前端能呈现所有 UI） |
| headless | 不透传 | 不透传 |

语义依据（用户原话）：「当前在输入框位置有交互的功能要排队，纯展示的功能不用排队；不影响 TUI 交互就无所谓，就不用透传」。

排队规则固化在 `isDialogMethod(method)` 工具函数，**dialog 类自动入 L2 全局队列**，不靠 channel 注册时声明。未来新 channel 走 select 通道自动获得排队，零配置。

### 维度 2：业务路由 — 由 channel 注册表决定（扩展协议自定义）

channel 从 method 对应字段的 NUL 前缀解析（提取位置依赖 method）：

```ts
function parseChannel(req: ExtensionUiRequest): { channel?: string; payload?: unknown } {
  switch (req.method) {
    case "select":    return parseFromMarkerString(req.title);       // ASK_USER_MARKER
    case "setWidget": return parseFromMarkerArray(req.widgetLines);  // GUI_WIDGET_MARKER
    default:          return {};
  }
}
```

`UiChannelRegistry` 让主 agent 各扩展按 channel 名注册 handler：

```
ask-user 扩展 → registry.register("ask_user", handleAskUser)
[未来] gui-widget 扩展 → registry.register("gui_widget", handleGuiWidget)
```

新增 channel 时：(a) 扩展协议加 marker；(b) 主 agent 侧扩展注册 channel handler。**不改 adapter / session-runner / SubagentService**。

## Alternatives

### Alt 1：`isAskUser: boolean` 硬编码（原 subagent 方案）

只识别 `ASK_USER_MARKER`，`UiRequest.isAskUser` 字段把 ask_user 硬编码进类型。

- **拒绝理由**：无法支撑 gui_widget 及未来其他透传场景。每加一个 marker 要改类型 + 改 handler 分发逻辑，违反开闭原则。

### Alt 2：channel 注册表 + channel 声明 `{serialize: true}` 排队（第一轮重设计）

channel 提取绑死 select.title，排队由 channel 注册时声明。

- **拒绝理由 1**：marker 不在同一字段。`GUI_WIDGET_MARKER` 在 setWidget.widgetLines[0]，绑死 select.title 会漏掉它。
- **拒绝理由 2**：排队是 method 交互模型的固有属性（dialog 占输入焦点），不是 channel 的属性。让 channel 声明 serialize 是把协议层属性泄漏到业务层。

### Alt 3：单一总 handler 做 method+channel 全分发

把所有 method 的处理压进一个 switch 函数。

- **拒绝理由**：违反「函数 ≤80 行」+ 职责单一。dialog handler（重逻辑，含 L2 队列）与 fire-and-forget handler（轻转发）耦合在同一闭包。当前采用分层：method 分类在 session-runner，channel 路由在 registry，业务在各自 channel handler。

## Consequences

### 正面

- **通用化**：任何子进程 UI 请求都能透传（dialog 类自动透传+排队，GUI 下 fire-and-forget 自动透传），不只 ask_user 特例
- **扩展性**：新增 channel 零改 adapter/session-runner/SubagentService
- **分层清晰**：adapter 做协议解析，session-runner 做 method 分类 + 队列，registry 做 channel 路由，channel handler 做业务
- **L2 队列天然解决 R1（ctx.ui.custom 槽位冲突）**：全局串行意味着同一时刻只有一个 dialog 在用主 agent UI
- **AGENTS.md 知识固化**：ctx.mode 语义从文档注释变成 `host-mode.ts` 可执行代码

### 负面

- **新增 4 个模块**（`host-mode.ts` / `ui-interaction-model.ts` / `ui-channels.ts` / `dialog-queue.ts`），增加表面积
- **channel 名规范化规则**（`\0XYZ_ASK_USER` → `ask_user`）是隐式约定，依赖 `@xyz-agent/extension-protocol` 的 marker 命名稳定。升级 extension-protocol 时需回归测试
- **TUI 下 fire-and-forget 不透传**意味着 TUI 用户看不到子进程的 setWidget/notify 输出。这是有意取舍（避免干扰输入交互），但 TUI 下子进程的 widget 信息会丢失
- **Stage 1-3 的 `defaultDialogForward` 是 stub**：TUI 下子进程发的**非 channel dialog**（普通 select/confirm/input/editor，无 NUL marker）当前返回 `{cancelled:true}`。实际影响面≈0——内置 8 个 agent 的 `--tools` 白名单（read/bash/grep 等）不含会调 ctx.ui dialog 的工具，唯一经过透传链路的子进程 dialog 是 ask_user（带 marker 走 channel 路由，不进 defaultDialogForward）。仅当用户自定义 agent 把会调 ctx.ui.select 的 tool（如 plan）放进子 agent 时才触发，且行为是安全降级（子进程收到 undefined 按用户取消处理，不崩溃）。Stage 4a 补齐真实 ctx.ui.* 转发后此限制消除

### 风险（实施时验证）

- `ctx.ui.custom` 在主 agent 正在渲染其他组件时能否被 dialog 抢占——Pi 平台能力问题，L2 队列只保证 dialog 之间不冲突。需 Stage 4a 验证

## 实施分阶

见 `.fix-plans/00-master-summary.md` §三。Stage 1（协议+工具模块）→ Stage 2（session-runner 改造 + 队列）→ Stage 3（测试）→ Stage 4（handler 业务实现）。Stage 1-3 不依赖外部决策，Stage 4a（TUI handler）风险最高。

## 参考

- 根因诊断：`.fix-plans/00-master-summary.md` §一
- Pi 协议源码：`pi-mono/main/packages/coding-agent/src/modes/rpc/rpc-types.ts:230-275`
- ctx.ui 实现：`pi-mono/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts:135-303`
- marker 契约：`@xyz-agent/extension-protocol/dist/index.mjs:5,55-80`
- 原缺陷登记：topic `cw-2026-07-17-subagent-ask-user` AS2（severity=blocker）
