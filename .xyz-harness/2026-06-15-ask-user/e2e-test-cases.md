# ask-user E2E 测试用例

> 目标：从 `execute()` 入口驱动完整链路，验证「LLM 调一次 ask_user → 用户交互 → 拿到 answers」的端到端契约。
> 与现有单元测试的差异：单元测试 mock `ctx.ui.custom` 返回假 result；E2E 注入**真实** `AskUserComponent`、模拟用户按键、断言最终 `execute()` 的 content + details。
> 覆盖：FR-1/3/5/6/7/8/10/11/12/14 与 AC-2/3/5/6/7/12/14/16/17/18。

## 测试 harness（建议提取到 `__tests__/e2e-harness.ts`）

```typescript
import factory from "../index";
import { AskUserComponent } from "../component";
import type { AskUserDetails, Question, Result } from "../types";
import { stubTheme, mockTui } from "./fixtures";

interface E2EApi {
  result: { val: Awaited<ReturnType<ReturnType<typeof factory>["execute"]>> | null };
  keys: (seq: string[]) => void;          // 模拟按键序列
  abort: () => void;                      // 触发 signal abort
  getExecuted(): Promise<AskUserDetails>; // 等待 execute 解析
  pi: { activeTools: string[] | null };
}

function makeE2E(questions: Question[], opts: { hasUI?: boolean; preAborted?: boolean } = {}): E2EApi {
  const { hasUI = true, preAborted = false } = opts;
  const controller = new AbortController();
  if (preAborted) controller.abort();

  let compRef: AskUserComponent | null = null;
  const result: E2EApi["result"] = { val: null };
  const pi = { activeTools: null as string[] | null };

  // mock pi（注册时存 tool，setActiveTools 记到 activeTools）
  const ext = {
    registerTool(t: any) { ext.tool = t; },
    getAllTools: () => [{ name: "ask_user" }, { name: "read" }, { name: "bash" }],
    setActiveTools: (names: string[]) => { pi.activeTools = names; },
    tool: null as any,
  };
  factory(ext as never);
  const tool = ext.tool;

  // 启动 execute（不 await，让 keys 在执行中触发）
  const execPromise = tool.execute("id", { questions }, controller.signal, undefined, {
    hasUI,
    signal: controller.signal,
    ui: {
      custom: (factoryFn: any) => new Promise<Result | null>((resolve) => {
        const done = (r: Result | null) => resolve(r);
        compRef = factoryFn(mockTui, stubTheme, {}, done);
        return compRef;
      }),
    },
  });

  return {
    result,
    keys: (seq) => seq.forEach((k) => compRef?.handleInput(k)),
    abort: () => controller.abort(),
    getExecuted: () => execPromise as Promise<AskUserDetails>,
    pi,
  };
}
```

**复用键码**：`ENTER="\r"` `ESC="\x1b"` `DOWN="\x1b[B"` `UP="\x1b[A"` `RIGHT="\x1b[C"` `LEFT="\x1b[D"` `SPACE=" "` `TAB="\t"`

---

## E2E-1: 单问题无评论 — 选第二项提交

**覆盖**: FR-1/3/6/7、AC-2

**Setup**: `[{ question: "Which DB?", options: [{label:"Postgres"},{label:"SQLite"}] }]`

**Keys**: `["\x1b[B", "\r"]`（↓ + Enter 选 SQLite）

**断言**:
- `result.content[0].text` 含 `"Which DB?" = "SQLite"`
- `result.details.cancelled === false`
- `result.details.answers["Which DB?"] === "SQLite"`
- `result.details.questions.length === 1`

---

## E2E-2: 单问题 + allowComment — 选项 + 评论拼接

**覆盖**: FR-1/3/4.6/6/7/11、AC-2/6/12/17

**Setup**:
```ts
[{ question: "Which DB?", allowComment: true,
   options: [{label:"Postgres"},{label:"SQLite"}] }]
```

**Keys**: `["\r", "f", "a", "s", "t", "\r"]`（Enter 选 Postgres → 进评论模式 → 输 "fast" → Enter 保存）

**断言**:
- `result.details.answers["Which DB?"] === "Postgres — fast"`
- `result.content[0].text` 含 `"Postgres — fast"`

---

## E2E-3: 单问题 + allowComment — Enter 空评论跳过

**覆盖**: AC-12/17

**Setup**: 同 E2E-2

**Keys**: `["\r", "\r"]`（Enter 选 Postgres → 直接 Enter 评论模式跳过）

**断言**:
- `result.details.answers["Which DB?"] === "Postgres"`（**不含** " — "）
- `cancelled === false`

---

## E2E-4: 多问题 4 项全答 + Submit 提交

**覆盖**: FR-1/3/5/6/7、AC-3（上限 4 问题）

**Setup**: 4 个问题（验证 schema maxItems 边界）
```ts
[
  { question:"Q1", header:"DB",   options:[{label:"Pg"},{label:"SQLite"}] },
  { question:"Q2", header:"Lang", options:[{label:"TS"},{label:"Py"}] },
  { question:"Q3", header:"Test", options:[{label:"Vitest"},{label:"Jest"}] },
  { question:"Q4", header:"Lint", options:[{label:"ESLint"},{label:"Biome"}] },
]
```

**Keys**:
```
["\r",                                // Q1: 选 Pg
 "\x1b[C", "\r",                      // → Q2, 选 TS
 "\x1b[C", "\r",                      // → Q3, 选 Vitest
 "\x1b[C", "\r",                      // → Q4, 选 ESLint
 "\x1b[C", "\r"]                      // → Submit, Enter 提交
```

**断言**:
- `result.details.answers` 含 4 项（Q1..Q4 各自答案）
- `cancelled === false`
- 验证 schema 接受 4 个问题（maxItems）

---

## E2E-5: 多问题回改已答答案（AC-16 / FR-14）

**覆盖**: AC-16、FR-14

**Setup**: `multiQ`（Q1/Q2/Q3 三个问题）

**Keys**:
```
["\r",                                // Q1: 选 A
 "\x1b[C", "\r",                      // → Q2, 选 X
 "\x1b[C", "\r",                      // → Q3, 选 M
 "\x1b[C",                            // → Submit tab（不提交，回改）
 "\x1b[D", "\x1b[D", "\x1b[D",        // ← Q3 ← Q2 ← Q1
 "\x1b[B", "\r",                      // Q1 移到 B, Enter 选 B
 "\x1b[C", "\x1b[C", "\x1b[C", "\r"]  // → Q2 → Q3 → Submit, Enter
```

**断言**:
- `result.details.answers["Q1"] === "B"`（不是初始的 "A"）
- Q2/Q3 答案保持原值

---

## E2E-6: 多选 + allowComment — toggle + Enter + 评论

**覆盖**: FR-1/3/4.6/6/7/11、AC-12/17/18

**Setup**:
```ts
[{ question: "Features?", multiSelect: true, allowComment: true,
   options: [{label:"Auth"},{label:"Search"},{label:"Cache"}] }]
```

**Keys**:
```
[" ",                                // toggle Auth
 " ",                                // toggle Search
 "\r",                               // Enter 确认
 "m", "i", "x", "\r"]                // 评论 "mix" + Enter
```

**断言**:
- `result.details.answers["Features?"] === "Auth, Search — mix"`
- 顺序按 index（Auth=0, Search=1）

**反向断言（AC-18）**: 若把 `[" "]` 替换为多次 toggle 不 Enter（仅 `[" ", " "]`），**不应**进入评论模式、**不应**解析 result——可作为 E2E-6b 子用例。

---

## E2E-7: Other 自由文本 — 输入 + 回编辑器续编

**覆盖**: FR-4.5/6/7、AC-5

**Setup**:
```ts
[{ question: "Explain:", options: [{label:"Standard"},{label:"Custom"}] }]
// 单选无 allowComment；Other 在末项（index 2）
```

**Keys**:
```
["\x1b[B", "\x1b[B",                 // ↓↓ 到 Other
 " ",                                 // 打开编辑器
 "h", "e", "l", "l", "o", "\r",      // 输 "hello" + Enter 保存
 "\x1b[B", "\x1b[B", " ",            // 再到 Other
 "w", "o", "r", "l", "d", "\r"]      // 编辑器预填 "hello" → 追加 "world" → Enter
```

**断言**:
- 第一次保存后 `answers["Explain:"] === "hello"`
- 第二次续编保存后 `answers["Explain:"] === "helloworld"`（验证 FR-4.5 编辑器预填 freeTextValue）

> 注：此用例需要验证 `editorText` 在 `mode === "options"` 退出时是否清空、再打开时是否从 `freeTextValue` 预填——若实现细节有偏差，断言可改为 `=== "world"`（仅追加）或拆为两个独立用例。

---

## E2E-8: Esc 取消 + 防重入（FR-12）

**覆盖**: FR-12、AC-14

**Setup**: `singleQ`

**Keys**: `["\x1b", "\r"]`（Esc 取消 → 再次 Enter）

**断言**:
- `result.content[0].text === "User cancelled"`
- `result.details.cancelled === true`
- `result.details.answers === {}`
- **二次按键不报错**（FR-12 `_resolved` 守卫）：`compRef?.handleInput("\r")` 不抛

---

## E2E-9: Signal abort 在组件运行中触发（AC-14 / FR-10）

**覆盖**: FR-10/12、AC-14

**Setup**: `singleQ`，进入 custom 渲染后立刻 abort

**Keys**: 不按键（验证仅靠 abort 也能 resolve）

**执行**:
```ts
const e = makeE2E(singleQ);
e.abort();  // signal 触发组件 cancel() → done(null) → cancelled
const result = await e.getExecuted();
```

**断言**:
- `result.content[0].text === "User cancelled"`
- `result.details.cancelled === true`
- `result.details.answers === {}`

**反向用例 E2E-9b**: `preAborted: true`（E2E harness 参数）—— 验证 execute 入口短路：
- 不进入 custom
- 同样返回 cancelled
- `pi.activeTools === null`（setActiveTools 未被调用，区别于 E2E-10）

---

## E2E-10: Headless — setActiveTools 副作用 + isError

**覆盖**: FR-8、AC-7

**Setup**: `hasUI: false`，单问题

**执行**:
```ts
const e = makeE2E(singleQ, { hasUI: false });
const result = await e.getExecuted();
```

**断言**:
- `result.isError === true`
- `result.content[0].text` 含 `"interactive"`
- `result.details.cancelled === true`
- `e.pi.activeTools` 不含 `"ask_user"`，含 `"read"` 和 `"bash"`

---

## 覆盖矩阵（AC × E2E）

| AC | E2E |
|----|-----|
| AC-1 安装加载 | —（手动） |
| AC-2 单问题无 Tab | E2E-1, E2E-2, E2E-3 |
| AC-3 多问题 Tab+Submit | E2E-4 |
| AC-5 Other 编辑器 | E2E-7 |
| AC-6 评论出现在结果 | E2E-2, E2E-6 |
| AC-7 Headless 禁用工具 | E2E-10 |
| AC-12 评论 Enter 跳过 | E2E-3 |
| AC-14 abort 不挂死 | E2E-8, E2E-9, E2E-9b |
| AC-16 回改 | E2E-5 |
| AC-17 评论 Enter/Esc 跳过 | E2E-2, E2E-3 |
| AC-18 多选+评论 Enter 时机 | E2E-6（含 6b 反向） |

---

## 不在 E2E 范围（单元测试已覆盖）

- Schema 形状、minItems/maxItems 边界（V-* T-1~T-7）
- 渲染字符串细节（Q-* S-*）—— E2E 不重复断言视觉
- 组件内部状态转换（C-* 大部分）—— E2E 只测最终 result 契约
- renderCall/renderResult（I-16~I-19）—— 纯函数，独立覆盖

## 与单元测试的协作

| 维度 | 单元测试（C-/S-/Q-/V-/I-12..15） | E2E（本文档） |
|------|--------------------------------|---------------|
| 驱动 | 直接 `new AskUserComponent` 或 mock custom | 走 `tool.execute()` 完整路径 |
| 按键 | 直接调 `handleInput` | 同左，但通过 harness 间接 |
| 断言 | 内部 state + 渲染字符串 | 最终 `execute()` 返回的 content + details |
| 副作用 | 不验 | 验 setActiveTools / signal abort |
| 数量 | 50+ 用例 | 10 用例（覆盖关键 user journey） |

E2E 失败时定位：先看 `content[0].text`（用户视角输出）→ 再看 `details.answers`（数据契约）→ 最后回退到对应的单元测试定位内部状态。
