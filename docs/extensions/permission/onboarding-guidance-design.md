# Onboarding Guidance 设计

## 背景

### 当前痛点

permission 扩展当前只有 `/permission` 一个 slash 命令作为用户入口。命令虽承载了 mode 切换、status、rule editor、model picker 四类功能，但 onboarding 路径存在明显缺口：

| 入口 | 当前行为 | 缺口 |
|------|---------|------|
| 裸跑 `/permission` | `formatStatusMessage`：当前 mode + 4 档模式列表 | 不解释 mode 含义、不告诉用户 `rule`/`model` 子命令存在 |
| `/permission status` | `formatDetailedStatus`：所有字段值 | 字段无 hint，不知道每个字段干嘛用、什么时候调 |
| 未知子命令 | 单行 `Usage: /permission [mode\|status\|rule\|model]` | 没引导到正确的下一步 |
| 首次跑扩展 | 静默创建 `~/.pi/agent/permission-config.json`，mode=yolo | 用户不知道这个文件存在，更不知道能编辑 |
| 决策被拦 | `block reason` 含 `source=rule` / `source=ai` | 用户看到 source 不知道 rule/ai 是什么、去哪改 |
| TUI 视觉锚点 | 仅 footer（mode 标签 + enabled） | permission 没有自己的常驻操作面板，widget 填补这个空白 |

**核心问题**：用户从「只知道 `/permission`」到「会用 rule editor / model picker / 配 userRules」之间，没有中间引导层。README 456 行但命令输出加起来不到 200 字符，新用户看到的和文档里描述的完全是两个东西。

### 设计目标

让用户**只通过 `/permission` 这一个入口**，在合理时间内自然发现 rule editor、model picker、status 详情、配置文件位置——不需要先去读 README。

### 非目标

- 不做侵入式向导（overlay 弹窗）—— Pi 工具/扩展的 onboarding 文化偏向「轻提示 + 用户主动探索」
- 不替换 footer——mode 标签暂由 permission 自管 footer 显示，等 statusline 跟进后单独 PR 删除
- 不修改现有 mode/rule/model 命令的核心行为——这些是老用户的肌肉记忆
- 不引入新 npm 依赖

---

## 设计原则

1. **提示要答用户当下想问的，不讲系统有什么**——避免功能广告
2. **错误路径的引导 ROI 最高**——用户主动敲错/探索时最需要引导
3. **常驻 widget 是稳定视觉锚点**——一次性 notify 一闪而过，widget 始终可见
4. **reason 文案对 LLM 友好**——reason 会回传给 agent（Reject-with-Reason 路径），描述性而非祈使
5. **配置 schema 向后兼容**——所有改动兼容旧配置文件
6. **widget 是 `/permission` 命令的发现入口**——yolo + 首次访问时 widget 末尾必须引导用户敲 `/permission`，否则 widget 与命令的入口链路断裂

### 与现有架构的对应（设计前必读）

| 设计点 | 对应现有代码 | 借鉴内容 |
|--------|-------------|----------|
| widget 纯函数渲染 | `extensions/scheduler/src/widget.ts:11-34` | string[] 重载 + 纯函数便于单测 |
| headless / mock ctx 守卫 | `extensions/permission/src/statusline.ts:201-209` | duck typing `typeof setWidget !== "function"` 跳过 |
| 配置 schema 向后兼容 | `extensions/permission/src/config.ts:91-101 normalizeConfig` | 字段缺失给默认值 + 类型错误 warn |
| 命令路径 mtime 缓存 | `extensions/permission/src/config.ts:142-153` | session_start + 每次命令前 refreshConfig 捕获手动编辑 |
| TUI/RPC/headless 三模式分发 | `extensions/permission/src/model-picker.ts pickModelViaOverlay` | 已有模式，新文案无需新建 |
| 现有 widget key 命名约定 | `"plan-mode"`（plan）/ `"scheduler"`（scheduler） | 字面量命名（monorepo 约定建议常量但现状都用字面量，统一改为常量留待后续集中重构） |

---

## 总体方案

5 个改动点，分三轮 PR 落地。**PR-1 不引入 meta 字段**——只做静态 hint bar（mode + userRuleCount + classifier model），不读 onboarded 标记。这样 PR-1 可独立发、可独立验证。PR-2 引入 meta + 首次访问判断 + 欢迎面板 + 促销 widget 文案。PR-3 是辅助收尾（reason 文案 + help）。

| # | 改动点 | 路径 | 工作量 | PR |
|---|--------|------|--------|----|
| 1 | 静态 widget（mode + rule count + classifier model） | **新增** `widget.ts` + `index.ts` 注入 | 中 | PR-1 |
| 2 | 配置文件 `meta` 字段（首次访问标记） | `types.ts` + `config.ts` + `commands.ts` | 中 | PR-2 |
| 3 | 命令文案自适应（首次欢迎面板 + status hint + 未知 fallback） | `commands.ts` | 小 | PR-2 |
| 4 | widget 文案升级：yolo + 未 onboarded 时追加引导 | `widget.ts` + `commands.ts` 写入 meta 后 invalidateWidget | 小 | PR-2 |
| 5 | reason 文案加可操作下一步 | `pipeline.ts` / `approval.ts` | 中 | PR-3 |
| 6 | `/permission help` 子命令 | `commands.ts` + `index.ts` | 小 | PR-3 |

### PR-1 与 footer 的关系

**当前决策（开放问题 #4 解决方案 A）**：PR-1 **保留**自管 footer。widget 只显示 rule count + classifier model，不显示 mode 标签（避免与 footer 视觉冗余）。等 `@zhushanwen/pi-statusline` 扩展支持 mode 标签显示后，单独 PR 删除 footer（见落地计划「PR-1b」）。

**未来方案**：statusline 支持 mode 标签后，删除 `extensions/permission/src/statusline.ts`（整文件）+ 删除 `extensions/permission/src/index.ts:91-95` `registerPermissionFooter(...)` 调用 + 删除 `extensions/permission/src/__tests__/statusline.test.ts`（整文件）。当前 PR 不做。

### 用户手动编辑 `permission-config.json` 后 widget 刷新

**已知 limitation**（与现状对齐）：当前 `config.ts:142-153` mtime 缓存 + `index.ts:73-75` `refreshConfig()` 只在 `session_start` 和 `/permission` 命令执行前捕获文件变化。**session 中用户手动编辑文件不会触发 widget 刷新**——需要重启 session 或再跑一次 `/permission` 命令。

不在本次设计范围内引入 `fs.watch`——增加 complexity 且当前 onboarding 期用户编辑文件概率低。如果未来收到反馈需要实时刷新，再加 fs.watch + invalidateWidget 机制（ADR 留口）。

---

## 改动点 1：常驻 widget（onboarding hint bar）

### 设计

新增 `extensions/permission/src/widget.ts`，模仿 `extensions/scheduler/src/widget.ts:11-34` 的 string[] 重载模式——纯函数，测试时不用 Pi runtime。

**PR-1（静态版本）输出**：

```
[pi-permission] 3 user rules · classifier: auto    # auto 模式
[pi-permission] 0 user rules                        # 非 auto 模式
[pi-permission] 5 user rules                        # 非 auto 模式
```

**PR-2（升级版）增加首次访问引导**：

```
[pi-permission] no rules · /permission to explore  # yolo + 0 rules + 未 onboarded
[pi-permission] 0 user rules                        # 其他情况
```

**为什么 widget 不显示 mode 标签**：mode 标签由 `@zhushanwen/pi-statusline` 的 footer 统一显示。widget 与 footer 同时显示 mode 会视觉冗余。widget 专注于「我能用什么、我配了什么」——rule 数量 + classifier model（auto 模式才有意义）。

**为什么 auto 模式 widget 显示 `classifier: auto`**：auto 模式下 classifier model 是高频调整项（决定 AI 调用成本），常驻显示让用户随时看到当前模型，避免「我以为在用 X 模型，实际跑的是 Y」。

**为什么非 auto 模式 widget 不显示 classifier**：approve 走规则+人工，strict/yolo 不走 AI，显示 classifier 会误导。

**为什么 yolo + 未 onboarded 时显示 `/permission to explore`**：widget 是用户**首次接触扩展的唯一视觉锚点**——用户可能从没敲过 `/permission` 命令，只看到 widget。此时 widget 必须显式引导，否则 onboarding 入口断裂。`/permission to explore` 是指令性短语但描述动作（探索），不是命令（`/permission help`），保持轻提示而非向导。

### 渲染逻辑

| mode | userRuleCount | isOnboarded | 输出 |
|------|---------------|-------------|------|
| yolo | 0 | false | `no rules · /permission to explore` |
| yolo | 0 | true | `0 user rules` |
| yolo | n>0 | * | `n user rule(s)` |
| auto | * | * | `n user rule(s) · classifier: <model>` |
| approve | * | * | `n user rule(s)` |
| strict | * | * | `n user rule(s)` |

`isOnboarded` 由 helper 函数 `isOnboarded(config): boolean` 计算（`config.meta?.onboardedAt !== null`），inline 表达式容易在多处 drift，统一 helper。

### 注册与刷新

**注册位置**：`session_start` handler（`index.ts:83`）。**保留**现有 `registerPermissionFooter(...)` 调用（详见「PR-1 与 footer 的关系」——footer 暂不删除）。

```typescript
// index.ts session_start 内（伪代码）
pi.on("session_start", (_event, ctx) => {
    refreshConfig();
    refreshWidget(ctx);  // 新增
});
```

**刷新触发点**：

| 事件 | 当前是否已有 invalidator | widget 刷新方式 |
|------|--------------------------|----------------|
| `session_start` | N/A | 注册时调一次 |
| mode 切换成功 | `invalidateFooter()`（PR-1 删除） | 同时调 `refreshWidget(ctx)` |
| rule editor 保存成功 | 无 | 新增 `refreshWidget(ctx)` |
| model picker 保存成功 | 无 | 新增 `refreshWidget(ctx)` |
| 用户手动编辑 config 文件 | **不刷新**（已知 limitation，见「总体方案」末段）| 下一次 session_start / 命令 |

`refreshWidget` 实现：

```typescript
function refreshWidget(ctx: ExtensionContext): void {
    if (typeof ctx.ui.setWidget !== "function") return; // mock ctx / SDK 未声明
    ctx.ui.setWidget("permission", renderPermissionHint({
        mode: config.mode,
        userRuleCount: config.userRules.length,
        classifierModel: config.classifier.model,
        isOnboarded: isOnboarded(config),
    }));
}
```

**key 选择**：`"permission"`，不和 plan（`"plan-mode"`）、scheduler（`"scheduler"`）、statusline 冲突。

### 4 个 mode 下的行为

`setWidget` 是 SDK 标准方法（`shared/types/earendil-works/index.d.ts:44`），在所有 mode 下都可用，但渲染目标不同：

| `ctx.mode` | widget 渲染路径 |
|-----------|----------------|
| `"tui"` | TUI 顶部 status bar |
| `"rpc"` | sidecar → EventBus → GUI chatStore（与 statusline widget 同链路） |
| `"json"` / `"print"` | SDK 默认忽略（headless 模式无 UI 目标） |

文档中的 duck typing 守卫（`typeof ctx.ui.setWidget !== "function"`）针对**单元测试 mock ctx 可能不实现 setWidget**的情况（参考 `statusline.ts:201-209` 同姿态），不是针对 production 的 json/print mode——production 下 SDK 会静默忽略。

### 与 statusline 的协作

**当前状态**：permission 自管 footer（显示 mode + enabled），statusline 扩展尚未支持 permission mode 标签。

| 信息 | widget（permission 自管） | footer（permission 自管，PR-1b 改由 statusline 接管） |
|------|-------------------------|--------------------------|
| 当前 mode 标签 | ✗（避免冗余） | ✓ |
| enabled 状态 | ✗ | ✓ |
| rule 数量 | ✓ | ✗ |
| classifier model（仅 auto） | ✓ | ✗ |
| `/permission` 发现入口（yolo+未 onboarded） | ✓ | ✗ |

**分工理由**：footer 位置在底部 status bar，是「状态指示」（模式是什么、是否启用）；widget 位置在 TUI 顶部，是「操作面板」（我能用什么、我配了什么）和「发现入口」。两者的视觉锚点和心智模型不同。

**PR-1b 后续**：statusline 扩展支持 permission mode 标签后，footer 改由 statusline 接管，permission 自管 footer 删除。

### 测试覆盖

- `renderPermissionHint` 是纯函数，单测覆盖所有 (mode, userRuleCount, isOnboarded, classifierMode) 组合
- 验证输出格式：固定字符串匹配，不依赖 Pi runtime
- 覆盖边界：userRuleCount=1 vs >1（单复数 `rule` vs `rules`）

---

## 改动点 2：配置文件 meta 字段

### 设计

在 `permission-config.json` 顶层加 `meta` 字段，记录用户首次访问时间和首次做出"主动决策"（切到非 yolo）的时间。

```typescript
interface PermissionConfigMeta {
    /** 首次加载配置文件的时间（ISO 8601），用于区分新老用户 */
    firstSeenAt: string;
    /** 首次切到非 yolo 模式的时间（ISO 8601），null 表示从未切过 */
    onboardedAt: string | null;
}
```

### 完整 schema

```typescript
interface PermissionConfig {
    mode: PermissionMode;
    enabled: boolean;
    classifier: ClassifierConfig;
    userRules: Rule[];
    /** 新增：可选 meta，向后兼容（旧配置无此字段） */
    meta?: PermissionConfigMeta;
}
```

### onboarded 状态机

| 状态 | 触发条件 | 持续到 |
|------|---------|--------|
| `onboarded = false` | meta 缺失 / meta.onboardedAt === null | 用户首次切到非 yolo 模式 |
| `onboarded = true` | meta.onboardedAt !== null | **永远不回退**（用户切回 yolo 不重置） |

**为什么切回 yolo 不重置 onboarded**：用户已经理解过 mode 含义，回退 yolo 是临时决策而非「回到 onboarding」。重置会让老用户看到欢迎面板，体验下降。

**统一判定 helper**（避免 inline 表达式 drift）：

```typescript
// types.ts 新增
export function isOnboarded(config: PermissionConfig): boolean {
    return config.meta?.onboardedAt != null;
}
```

### 加载兼容

`normalizeConfig`（`config.ts:91-101`）加 meta 归一化逻辑：

- 字段缺失 → 给默认值：`{ firstSeenAt: new Date().toISOString(), onboardedAt: null }`
- 字段类型错误 → warn + fallback 到默认值（不阻塞加载）
- `firstSeenAt` 不是字符串 → 用当前时间
- `onboardedAt` 不是 string/null → fallback 到 null

**`normalizeConfig` 当前行为说明**：现有 `normalizeConfig`（`config.ts:91-101`）只构造白名单字段（`mode`/`enabled`/`classifier`/`userRules`），未声明字段会被**丢弃**。这意味着即使旧配置文件手工包含 `meta: {...}`，加载时会被 `normalizeConfig` 丢掉，然后命令路径再重新写入正确的 meta。这是「strip unknown + 重新添加」的正常行为，无需在文档做兼容性承诺。

**为什么不在加载时强制写盘**：保持 `loadAndWatchConfig` 纯读。meta 字段的写回由命令路径（mode 切换）触发，避免「只读 config」产生副作用。

### 写入触发与责任划分

**写入责任划分**：`saveConfig`（`config.ts:178-211`）信任调用方传入的对象，**不重新 normalize**。meta 字段的写入由 `switchMode` 唯一负责，调用方必须：

1. 检查 `config.meta` 是否存在，缺失则构造默认值
2. 切到非 yolo 且 `meta.onboardedAt === null` 时写入当前时间
3. 显式传递完整 `meta` 对象给 `saveConfig`（不要 spread `{...config}` 假设 meta 存在）

**伪代码（与真实 `switchMode` 实现对齐：显式列字段）**：

```typescript
// commands.ts switchMode 真实实现（手动列字段，不 spread）
function switchMode(mode, config, onSave): string {
    if (mode === config.mode) return alreadyMessage;
    
    const now = new Date().toISOString();
    const meta: PermissionConfigMeta = config.meta ?? {
        firstSeenAt: now,
        onboardedAt: null,
    };
    const newOnboardedAt = mode !== "yolo" && meta.onboardedAt === null
        ? now
        : meta.onboardedAt;
    
    const newConfig: PermissionConfig = {
        mode,
        enabled: config.enabled,
        classifier: { ...config.classifier },
        userRules: config.userRules.map((r) => ({ ...r })),
        meta: { firstSeenAt: meta.firstSeenAt, onboardedAt: newOnboardedAt },
    };
    const result = onSave(newConfig);
    return switchMessage;
}
```

**触发点 1：mode 切换成功时**（`commands.ts:87 switchMode`）——见上。

**触发点 2：rule editor 保存**（`commands.ts:202 handlePermissionRuleCommand`）—— rule 数量变化后 widget 刷新需要 meta 已写入（这里只是写盘，**不修改 meta 本身**，只是把 meta 透传给 saveConfig）。

**触发点 3：model picker 保存**（`commands.ts:137 handlePermissionModelCommand`）—— classifier.model 变化后 widget 刷新，同样**不修改 meta 本身**。

**为什么不主动写 meta.firstSeenAt**：默认配置创建时（`config.ts:109-118 ensureConfigFile`）不写 meta。理由：默认配置创建不等于用户访问——可能是扩展自动后台触发。让首次 `/permission` 命令执行时延迟写入更准确。

**降级路径**：如果 `saveConfig` 写盘失败（`result.success === false`），meta 未持久化 → 下次启动仍 `onboardedAt === null` → 欢迎面板再次触发。这是可接受的降级——比「写盘失败阻塞 mode 切换」更好。Retry 不在本次设计范围内。

### 跨 session 行为

- **session 重启**：meta 持久化在 config 文件，跨 session 保留。`onboardedAt` 一旦写入永久生效。
- **session fork / branch**（`session_tree` / `createBranchedSession`）：meta 在 fork 时**复制到子 session**（与 mode/userRules 同步），不污染原 session。如果子 session 切到非 yolo 模式，原 session 的 `onboardedAt` 不受影响——符合 Pi session 模型预期。
- **多 Pi 实例**：meta 在配置文件级别共享（每个用户一个 Pi 实例、一个 config 文件），符合预期。

### 测试覆盖

- `normalizeConfig` 旧配置（无 meta）→ 给默认值
- `normalizeConfig` 部分 meta 字段缺失 → 给默认值
- `normalizeConfig` meta 字段类型错误 → fallback + warn
- `switchMode` 首次切到非 yolo → meta.onboardedAt 写入
- `switchMode` 切到 yolo → meta.onboardedAt 不变（保留）
- `switchMode` 已在 non-yolo → meta.onboardedAt 不变（不重复写）
- `switchMode` meta 缺失 → 自动构造默认 meta + 写入 onboardedAt
- `isOnboarded` helper 单测（null / undefined / 字符串）

---

## 改动点 3：命令文案自适应

### 3.1 裸跑 `/permission`（首次访问欢迎面板）

**触发条件**：
- args 为空
- `config.meta?.onboardedAt === null`（旧配置无 meta 视为首次）

**输出**：

```
[pi-permission] Welcome. Current mode: YOLO (all tools allowed).

Permission mode controls how each tool call gets gated:
  yolo    — no gating (current)
  auto    — safe commands pass, others go through AI classifier
  approve — safe commands pass, others wait for your approval
  strict  — every tool call waits for your approval

Recommended: /permission auto (good balance)
See also:   /permission rule (add custom rules)
             /permission model (pick the AI classifier)
             /permission status (show full config)
```

**为什么用 notify 而不是 widget 推**：
- widget 是「常驻显示」，欢迎面板是「一次性事件」，语义不同
- 欢迎面板包含的内容（4 个 mode 的对比、推荐选项）不适合塞进 widget 一行
- notify 闪烁一次能让用户明确感知「这是一个新事件」，widget 推送反而会被忽略

**为什么不用 overlay 向导**：见背景章节「非目标」——侵入式向导与 Pi 生态不符，且破坏现有 `/permission` 无参 = 文本 status 的稳定行为。

### 3.2 裸跑 `/permission`（非首次访问）

保持现有 `formatStatusMessage`（`commands.ts:58-70`）输出，零改动。

**判定**：`config.meta?.onboardedAt !== null` → 走老路径。

**边界 case**：
- 旧配置无 meta 字段 → 视为首次（meta 默认 `onboardedAt: null`）
- meta 字段解析失败 → fallback 到默认 meta → 视为首次（warn 但不阻塞）

### 3.3 `/permission status` 字段加 hint

**当前输出**（`commands.ts:72-85 formatDetailedStatus`，**label 是缩写**——`autoApproveLow` / `autoDenyHigh`，与 `types.ts:96-98` 字段名 `autoApproveLowRisk` / `autoDenyHighRisk` 区分）：

```
[pi-permission] Configuration:
  mode:       Auto (auto)
  enabled:    true
  classifier:
    enabled:           true
    model:             auto
    timeout:           90s
    autoApproveLow:    true
    autoDenyHigh:      true
  userRules:  3 rule(s)
```

**改为**（每行末尾加 dim hint）：

```
[pi-permission] Configuration:
  mode:        Auto (auto)        — AST + rules + AI classifier
  enabled:     true
  classifier:
    enabled:         true
    model:           auto         — cheapest available; /permission model to change
    timeout:         90s          — increase if AI is slow on big commands
    autoApproveLow:  true         — false = route low-risk to human
    autoDenyHigh:    true         — false = route high-risk to human
  userRules:    3 rule(s)         — /permission rule to edit
```

**实现**：hint 文案写死在 `commands.ts`，不做配置化。原因：hint 是「对每个字段含义的稳定解释」，不是用户可调参数；配置化反而增加 surface area。

**为什么 hint 不展开成段落**：保持 status 单屏可见（终端一般 24 行）。字段含义够用即可，细节指 `/permission rule` / `statusline` footer / README。

### 3.4 未知子命令 fallback

**当前输出**（`commands.ts:53`）：

```
[pi-permission] Unknown mode 'foo'. Available: yolo, auto, approve, strict. Usage: /permission [mode|status|rule|model]
```

**改为**：

```
[pi-permission] Unknown mode 'foo'.
Did you mean: yolo, auto, approve, strict?
Or: /permission rule (edit rules) · /permission model (classifier) · /permission status (config)
```

**改动理由**：
- "Did you mean" 是用户熟悉的错误提示模式（git/npm 都用）
- 把 `rule`/`model`/`status` 从「Usage 字符串」提到与 mode 平级，降低发现门槛
- 第二行可作为 widget hint 的补充（用户看到 widget 提示 `/permission rule` 后，敲错命令时再次看到 `rule` 子命令，加深印象）

### 测试覆盖

- 首次访问（onboardedAt=null）→ 输出欢迎面板
- 非首次访问（onboardedAt 非 null）→ 输出 status message
- 旧配置（无 meta）→ 输出欢迎面板
- `/permission status` 各 mode 输出正确 hint
- 未知子命令输出含 "Did you mean" + 子命令引导

---

## 改动点 4：reason 文案加可操作下一步

### 设计

当前 `PermissionDecision.reason`（`pipeline.ts` / `approval.ts`）含决策来源，但用户看到 `(source=rule)` / `(source=ai)` 不知道具体去哪改。在 reason 文案末尾追加 dim 描述性短语。

### 文案规范（按 source × mode 限定）

`source=ai` **仅 auto 模式出现**（pipeline.ts:432-434 决定）：strict 不跑 AI、approve 不跑 AI、yolo 走 mode source。如果在非 auto 模式给 `source=ai` 追加 hint 会误导用户（用户以为 AI 参与了决策）。

| mode | source | 命中类型 | reason 末尾追加 |
|------|--------|---------|----------------|
| * | `rule` | builtin-danger | `· See /permission status for rule overview` |
| * | `rule` | user rule | `· Edit via /permission rule` |
| **auto** | `ai` | * | `· Adjust classifier via /permission model` |
| 非 auto | `ai` | * | （**不追加**——该 source 不会出现，此处防御）|
| * | `ast` | * | （无追加——AST 是结构性检测，没有可调参数）|
| * | `user` | * | （无追加——用户已经做了决策）|
| * | `mode` | * | （无追加——mode 行为由用户当前选择决定）|

**实现方式**：在 `pipeline.ts` / `approval.ts` 构造 reason 字符串时，按 (mode, source) 二维查表追加。reason 工厂函数 `appendReasonHint(reason, mode, source, matchedRule)` 在 `commands.ts` 或新 helper 文件定义，便于单测。

### 示例对比

```
# auto + builtin-danger 命中
[pi-permission] deny: rm -rf /tmp matched builtin-danger rule bd-001 (source=rule) · See /permission status for rule overview

# auto + user rule 命中
[pi-permission] deny: docker run --rm ... matched user rule user-3 (source=rule) · Edit via /permission rule

# auto + AI 分类
[pi-permission] ask: ... AI classified as high risk (source=ai) · Adjust classifier via /permission model

# strict + 用户拒绝（source=user）—— 无追加
[pi-permission] denied by user (source=user)
```

### LLM 友好性

reason 末尾追加用描述性短语（`See ...` / `Edit via ...`），不用祈使语气（不用 `Run /permission ...`）。理由：

- LLM 可能把 reason 当指令解析
- 祈使语气会让 LLM 主动去跑命令，浪费 turn
- 描述性短语让 LLM 把 reason 当上下文，下一次 user message 自然引导用户操作

**正向断言**（不是简单的正则 negative match）：

- reason 必须以**陈述性谓语**开头（`matched` / `denied` / `classified` / `rejected`），不是祈使动词（`Run` / `Execute` / `Use`）
- reason 末尾的 hint 必须是描述性短语（`See ...` / `Edit ...` / `Adjust ...`），不是祈使命令（`Run /permission ...`）
- 自动化测试：reason 文案匹配正则 `/^(matched|denied|classified|rejected|approved)/`，且末尾 hint 不匹配 `/^(Run|Execute|Use|Type|Enter)\s+\/permission/`

### 测试覆盖

- builtin-danger 命中 → reason 末尾追加正确 hint
- user rule 命中 → reason 末尾追加正确 hint
- auto + AI 分类 → reason 末尾追加正确 hint
- 非 auto + source=ai（防御性测试，构造 mock） → reason 末尾无追加
- AST 拦截 → reason 无追加
- mode source / user source → reason 无追加
- reason 文案 LLM 友好性测试（正向断言：陈述性谓语开头 + 描述性 hint）
- `approval.ts` reason 工厂函数（拼接 hint 前的 base reason）单测覆盖：
  - TUI 路径（`"denied via tui"` / `"approved via tui"`）
  - RPC 路径（`"denied via rpc"` / `"approved via rpc"`）
  - headless 路径（`"denied (headless mode: no interactive UI)"`）
- pipeline.test.ts + approval.test.ts 各加新 test suite，不合并到一个文件

---

## 改动点 5：`/permission help` 子命令

### 设计

新增 help 子命令，输出完整功能地图。**不作为主要 onboarding 入口**（主要入口是改动点 3.1 的欢迎面板），而是给通过 tab 补全发现 help 的高级用户的兜底。

### 输出

```
[pi-permission] Available subcommands:
  /permission                Show current mode (first run: welcome panel)
  /permission <mode>          Switch mode (yolo|auto|approve|strict)
  /permission status          Show detailed configuration
  /permission rule            Edit user-defined rules (interactive)
  /permission model           Pick AI classifier model
  /permission help            This help

Tip: the status bar widget shows current mode, rule count, and classifier model.
Tip: /permission status lists every config field with hints.
```

**实现位置**：`commands.ts` 加 `handlePermissionHelpCommand` 函数 + `commands.ts:30 handlePermissionCommand` 入口加 `if (trimmed === "help") return ...` 分支。

**description 更新**：`index.ts:100` 当前 description 是 `Usage: /permission [mode|status|rule|model]`，改为 `Usage: /permission [mode|status|rule|model|help]`。

### 测试覆盖

- `/permission help` → 输出包含 6 个子命令列表
- 输出包含 widget tip 和 status tip

---

## 配置兼容性矩阵

| 旧配置文件版本 | 加载行为 | 写入行为 |
|---------------|---------|---------|
| 无 meta 字段 | meta 默认 `{firstSeenAt: now, onboardedAt: null}` | 首次切 mode 时写入完整 meta |
| 有 meta 但 firstSeenAt 缺失 | fallback 到当前时间 | 切 mode 时写入 |
| 有 meta 但 onboardedAt 缺失 | fallback 到 null | 切 mode 时写入 |
| meta 字段类型错误 | warn + fallback 到默认 | 切 mode 时写入正确格式 |

所有 fallback 路径都通过 `normalizeConfig` 统一处理，调用方零感知。

---

## 风险与回滚

| 风险 | 缓解 | 回滚成本 |
|------|------|---------|
| meta 字段写盘失败 → 用户 meta 永远为 null | `saveConfig` 已有 fail-soft 返回；降级为欢迎面板再次触发，可接受 | 删 `meta?` 字段即可 |
| widget 在 RPC 模式下走 sidecar 失败 | duck typing 守卫 `typeof setWidget === "function"`（mock ctx 防御） | 删 `setWidget` 调用即可 |
| widget 与 statusline widget 在 GUI 侧冲突 | 双方用不同 widget key（`"permission"` vs statusline 自有 key）；命名空间隔离 | 改 widget key 字符串 |
| reason 文案追加让 LLM 误触发命令 | 描述性而非祈使；正向断言测试（陈述性谓语开头 + 描述性 hint） | 删追加逻辑即可 |
| `source=ai` hint 在非 auto 模式误追加 | 工厂函数按 (mode, source) 二维查表；非 auto 模式 source=ai 防御性测试覆盖 | 查表加 mode 守卫 |
| 欢迎面板太长（新用户嫌啰嗦） | 输出格式精简到 ~15 行；可读 README.md 评估 | 把首次判断改成 `meta?.onboardedAt === null && mode === 'yolo'` 缩窄场景 |
| `/permission help` 与 README 重复 | help 是用户已经探索后的兜底；README 是完整文档 | 删 `help` 分支即可 |
| 跨 session fork 时 meta 行为异常 | meta 与 mode/userRules 同步复制；不污染原 session（符合 Pi session 模型） | 文档约定，不需改代码 |
| PR-1b 删除 footer 时 statusline 未跟进 mode 标签 | PR-1b 落地前先 grep `@zhushanwen/pi-statusline` 确认已支持 permission mode；不支持则推迟 PR-1b | 恢复 `registerPermissionFooter` 调用 |

---

## 落地计划

### PR-1：静态 widget（保留 footer）

**目标**：常驻 hint bar 上线（仅显示 rule count + classifier model，**不显示 mode 标签**）。**保留**自管 footer（mode 标签显示），等 statusline 扩展跟进 mode 标签支持后单独 PR 删除。

**与开放问题 #4 的关系**：解决方案 A（落地前需与用户确认——见开放问题 #4）。

**改动文件**：
- `extensions/permission/src/widget.ts`（**新增**，约 60 行，纯函数 `renderPermissionHint`）
- `extensions/permission/src/index.ts`（注册 widget，与 footer 并存，~10 行）
- `extensions/permission/src/__tests__/widget.test.ts`（**新增**，覆盖所有 mode × userRuleCount 组合）
- `extensions/permission/README.md`（新增「Status Widget」章节，与 statusline 章节并列）
- `.changeset/permission-add-widget.md`（**新增**，minor bump）

**review 重点**：
- widget key 选择（不冲突 plan/scheduler/statusline）
- widget 与 footer 的视觉共存是否会引起用户混淆（footer 显示 mode，widget 不显示）
- refresh 触发点覆盖完整性

**PR-1b（后续，等 statusline 支持 mode 标签后）**：删除 `statusline.ts` + `__tests__/statusline.test.ts` + 移除 `index.ts` footer 注册。

### PR-2：meta 字段 + 命令文案自适应 + widget 升级

**目标**：自适应引导（首次欢迎面板 + status hint + 未知 fallback + widget 促销文案）。

**改动文件**：
- `extensions/permission/src/types.ts`（加 `PermissionConfigMeta` + `isOnboarded` helper，~25 行）
- `extensions/permission/src/config.ts`（`normalizeConfig` 加 meta 归一化，~15 行）
- `extensions/permission/src/commands.ts`（首次欢迎面板 + status hint + 未知 fallback，~100 行）
- `extensions/permission/src/widget.ts`（升级：yolo+未 onboarded 时追加 `/permission to explore` 引导，~15 行）
- `extensions/permission/src/index.ts`（refreshWidget 触发点 + help 子命令路由，~10 行）
- `extensions/permission/src/__tests__/commands.test.ts`（扩展覆盖）
- `extensions/permission/src/__tests__/config.test.ts`（meta 归一化测试）
- `extensions/permission/src/__tests__/widget.test.ts`（扩展：isOnboarded 矩阵）
- `extensions/permission/README.md`（更新命令章节 + 新增「Onboarding」章节）
- `.changeset/permission-onboarding-meta.md`（**新增**，minor bump）

**review 重点**：
- meta 向后兼容性（旧配置文件加载行为）
- 欢迎面板文案的可读性（15 行内）
- widget 升级后 yolo+0 rules 用户的引导是否清晰
- 测试覆盖率

### PR-3：reason 文案追加 + help 子命令

**目标**：reason 引导 + 兜底 help 命令。

**改动文件**：
- `extensions/permission/src/reason-hints.ts`（**新增**，`appendReasonHint(reason, mode, source, matchedRule)` 工厂函数，~40 行）
- `extensions/permission/src/pipeline.ts`（reason 末尾追加 hint，~10 行）
- `extensions/permission/src/approval.ts`（reason 末尾追加 hint，~10 行）
- `extensions/permission/src/commands.ts`（help 子命令实现，~25 行）
- `extensions/permission/src/index.ts`（description 更新，~2 行）
- `extensions/permission/src/__tests__/reason-hints.test.ts`（**新增**，所有 (mode, source, matchedRule) 组合）
- `extensions/permission/src/__tests__/pipeline.test.ts`（reason 文案集成测试）
- `extensions/permission/src/__tests__/approval.test.ts`（TUI/RPC/headless 三路径 base reason 测试）
- `extensions/permission/src/__tests__/commands.test.ts`（help 输出测试）
- `extensions/permission/README.md`（更新命令章节，help 列出）
- `.changeset/permission-reason-hints.md`（**新增**，minor bump）

**review 重点**：
- reason 文案 LLM 友好性（正向断言测试）
- `(mode, source)` 二维查表覆盖完整性
- help 输出与 README 的一致性

---

## 开放问题

1. **首次访问判断用 meta 还是用 sessionStorage**：meta 文件持久化是当前选择。如果未来加 Pi 的 session 概念（多 session 共享一个 Pi 进程），meta 仍是合理选择（每个用户一个 Pi 实例，一个 config 文件）。
2. **widget 是否需要提供快捷键**：plan/scheduler 的 widget 都是纯展示，没快捷键。permission widget 也不加——避免 widget 抢走命令路径的心智。如未来需要，按 `setWidget` 第二重载（factory）扩展。
3. **`/permission help` 是否与其他扩展的 help 命名对齐**：grep 全仓库确认 `help` 是公认命名后保留；如果其他扩展用 `?` / `--help`，后续可统一。
4. **statusline 接管 footer 的进度同步**（**已确认**：statusline 扩展当前**未支持** permission mode 标签，line 220/346-358 仅显示 provider/model/thinking level/speed/cache）。这意味着 PR-1 删除 permission 自管 footer 后，用户暂时看不到 mode 标签。
   - **解决方案 A**（推荐）：PR-1 不删 footer，**临时保留 mode 标签**——widget 显示 rule count + classifier model，footer 显示 mode + enabled。视觉冗余可接受，等 statusline 支持 mode 后再删。
   - **解决方案 B**：PR-1 同时给 statusline 扩展加 mode 标签支持（独立 worktree，分两个 PR）。
   - **解决方案 C**：PR-1 推迟到 statusline 支持 mode 标签后。
   - **本文档暂选 A**：保留 permission 自管 footer（PR-1 范围缩小），等 statusline 跟进后单独 PR 删除。**需要落地前与用户确认方案选择**。