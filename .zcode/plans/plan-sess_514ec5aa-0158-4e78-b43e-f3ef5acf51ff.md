## 目标

ask-user extension 接入 xyz-agent 的 ask-user 富交互协议。在 RPC 模式（xyz-agent GUI）下，用 `askUserInteract()` 走 select 通道 + marker 与前端 `AskUserOverlay` 交互；TUI 模式保持原有 `ctx.ui.custom(AskUserComponent)` 不变。

## 前置约束（已确认）

- **协议包未发布 npm**：用本地 stub（跟 subagent-workflow 一致），包发布后替换 import
- **SDK 的 `ExtensionContext` 无 `mode` 字段**：stub 的 `isGuiCapable(ctx)` 用 `ctx.hasUI === false` 判定（真实 SDK 注释明确 RPC 模式 hasUI=false）
- **print 模式也满足 hasUI=false**：无法区分。但 print 模式下 `ui.select` 无前端消费，靠 runtime 5min timeout 兜底（与 headless 行为差异可接受——xyz-agent 一定用 rpc，print 场景罕见）

## 改动清单（4 文件）

### 1. 新建 `extensions/ask-user/src/gui-protocol.ts`（stub，~130 行）

复刻协议包 `@xyz-agent/extension-protocol` 的 **ask-user 专用部分**（不含 core 层，ask-user 不用 `__gui__` widget 通道）。文件头注释标明「stub，包发布后替换 import」。

内容：
- `GuiContext` 接口：`{ hasUI?: boolean; ui?: { select?: ... } }`（Pi ExtensionContext 的结构化子集，对齐 subagent-workflow stub）
- `AskUserQuestion` / `AskUserOption` / `AskUserAnswers` 类型（1:1 复刻 `extensions/ask-user/types.ts`）
- `ASK_USER_MARKER = '\x00XYZ_ASK_USER'` 常量
- `isGuiCapable(ctx): boolean` → `ctx.hasUI === false`
- `askUserInteract(ctx, questions, options)` → 序列化 questions 进 `ctx.ui.select(ASK_USER_MARKER, [payload], {signal})`，返回 `AskUserAnswers | null`
- `getAskUserAnswer` / `getAskUserOther` / `getAskUserComment` 解析 helper
- `stripUndefined` 工具函数（序列化前清理 undefined）

### 2. 改 `extensions/ask-user/src/index.ts`（execute 分支 + 格式转换，+~60 行）

**改动点**：在 step 2（headless 检查）和 step 3（signal abort）之间，插入 RPC 分支。

原 step 2 逻辑（`!ctx.hasUI` 直接报错+禁用）改为：
```
if (!ctx.hasUI) {
  if (isGuiCapable(ctx)) {
    // RPC 模式：走 askUserInteract（见下方）
  } else {
    // 真 headless（print 模式等）：保持原报错+禁用逻辑
  }
}
```

实际实现：把 headless 检查拆开。新增一个 `runRpcInteraction(questions, signal, ctx)` 函数（放 index.ts 内或单独提取），负责：

1. 构造 `AskUserQuestion[]`：把 ask-user 的 `Question`（options 必填，只有 label/description）映射为协议格式（`options: [{label, value: label, description}]`，`allowOther: true`，`allowComment: q.allowComment ?? false`）
2. 调 `askUserInteract(ctx, protoQuestions, { signal, allowCancel: true })`
3. 返回 `null`（取消）→ 走原 step 5 取消分支；返回 answers → 格式转换
4. **格式转换**（协议 `AskUserAnswers` → ask-user 内部 `Result.answers`）：
   ```
   对每个 q:
     iq = 对应的 protoQuestion（header = q.header ?? q.question）
     selected = getAskUserAnswer(answers, iq)  // string | string[] | undefined
     other = getAskUserOther(answers, iq)
     comment = getAskUserComment(answers, iq)
     parts = [selected 展开] + [other].filter(Boolean)
     base = parts.join(", ")
     askUserAnswers[q.question] = comment ? `${base} — ${comment}` : base
   ```
   复用现有 `ANSWER_COMMENT_SEPARATOR`（` — `）和 `getAnswerText` 的拼装语义（保持与 TUI 版输出一致）
5. 构造 `Result { questions, answers: askUserAnswers, cancelled: false }`，走原 step 6 正常返回

**TUI 分支不变**：原 step 4 的 `ctx.ui.custom(AskUserComponent)` 完全不动。

### 3. 改 `extensions/ask-user/src/__tests__/index.test.ts`（mock ctx 扩展，+~40 行）

- mock ctx 的 `ui` 加 `select` 方法（当前只有 `custom`）
- 新增 RPC 模式测试用例（`hasUI: false` + mock `ui.select` 返回 JSON answers）：
  - RPC 正常交互：单选/多选/Other/comment 的格式转换正确性
  - RPC 用户取消：select 返回 undefined → cancelled details
  - RPC select 抛异常 → 走 catch 分支（ErrorDetails）
  - 真 headless（`hasUI: false` + 无 `ui.select` / select 不可用）：保持原报错+禁用行为

### 4. 新建 `extensions/ask-user/src/__tests__/gui-protocol.test.ts`（stub 单测，~60 行）

测试 stub 本身的正确性（与协议包单测对齐）：
- `askUserInteract` RPC 模式：mock `ctx.ui.select` 返回 JSON string → parse 出 answers
- `askUserInteract` 取消：select 返回 undefined → null
- `askUserInteract` JSON parse 失败 → null
- `ASK_USER_MARKER` 常量值正确
- `getAskUserAnswer` 单选/多选/parse 失败降级
- `getAskUserOther` / `getAskUserComment` key 拼接正确

## 不改动的部分

- `component.ts` / `question-view.ts` / `submit-view.ts` / `validate.ts` / `types.ts` —— TUI 逻辑和共享校验完全不动
- `InputSchema`（LLM 参数 schema）不变 —— RPC 分支在 validate 之后
- `renderCall` / `renderResult` 不变 —— 这俩是 TUI 渲染，RPC 模式下 Pi 不调它们（xyz-agent 走自己的前端渲染）

## 关键设计决策

1. **RPC 分支位置**：在 validate 之后、headless 检查处分流。validate 共享（无论 TUI/RPC 都先校验参数），避免重复。
2. **格式转换复用现有语义**：`ANSWER_COMMENT_SEPARATOR` 和 `getAnswerText` 的 `parts.join(", ")` 逻辑保持一致，确保 RPC 和 TUI 两种路径产出的 `Result.answers` 格式相同（`renderResult` 和 LLM 看到的 content 文本无差异）。
3. **不提取独立的 rpc-adapter.ts**：RPC 分支逻辑量小（构造 + 转换 ~40 行），直接放 index.ts 内的命名函数。如果未来复杂化再提取。
4. **stub 不含 core 层**：ask-user 不用 `__gui__` widget 通道（不是 setWidget 场景），只用交互通道。stub 只复刻 ask-user 专用部分，避免死代码。

## 验证方式

- `pnpm --filter @zhushanwen/pi-ask-user typecheck` 通过
- `pnpm --filter @zhushanwen/pi-ask-user test` 全绿（原测试 + 新增 RPC 测试）
- pre-commit hook（tsc + eslint + vitest）通过