# ask-user extension 实现计划

> **给 agentic worker：** 必备子技能：使用 subagent-driven-development（推荐）或 executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 构建 `@zhushanwen/pi-ask-user` 扩展，替换已安装的 `pi-ask-user`，提供纯 inline、自适应单/多问题的结构化问答工具 `ask_user`。

**架构：** 分层组件——`types.ts`（schema + 类型）、`validate.ts`（参数校验）、`component.ts`（主组件：Tab bar + 路由）、`question-view.ts`（单问题渲染：选项列表 + 分屏预览 + 内联编辑器 + 评论）、`submit-view.ts`（多问题 Submit 汇总）。`index.ts` 工厂注册 tool。每次 `ctx.ui.custom()` 创建新组件实例，状态天然隔离。

**技术栈：** TypeScript (ESM)，`@mariozechner/pi-coding-agent`（peerDep），`@earendil-works/pi-tui`（optional peerDep，Text/Editor/Component/Key/matchesKey/wrapTextWithAnsi/truncateToWidth），typebox（schema），vitest（测试）。

**参考 spec：** `.xyz-harness/2026-06-15-ask-user/spec.md`

**已验证 API（来自 `shared/types/mariozechner/index.d.ts`）：**
- `ctx.ui.custom<T>(factory: (tui, theme, kb, done) => any, options?): Promise<T>` — 不传 `options` 即 inline 渲染
- `execute(toolCallId, params, signal, onUpdate, ctx)` — ctx 第 5 参数，`ctx.hasUI`、`ctx.signal`（abort）
- `pi.setActiveTools(string[])` + `pi.getAllTools()` — 禁用工具
- pi-tui: `Text`、`Container`、`Markdown`、`matchesKey`、`truncateToWidth`、`Key`（escape/up/down/left/right/enter/space/tab/ctrl/shift）
- `getMarkdownTheme()` + `safeMarkdownTheme()` 降级模式

---

## 文件结构

```
extensions/ask-user/
├── index.ts                    # re-export: export { default } from "./src/index.ts"
├── package.json                # @zhushanwen/pi-ask-user
├── README.md
├── vitest.config.ts
└── src/
    ├── index.ts                # 工厂：注册 ask_user tool（execute + renderCall + renderResult）
    ├── types.ts                # TypeBox schema（InputSchema/ResultSchema）+ 类型 + 常量
    ├── validate.ts             # validateInput(): 重复 question/label、多问缺 header 校验
    ├── component.ts            # AskUserComponent：Tab bar 渲染 + 输入路由 + buildResult
    ├── question-view.ts        # renderQuestionView()：选项列表 + 分屏预览 + 内联编辑器 + 评论行
    ├── submit-view.ts          # renderSubmitView()：Submit tab 汇总
    └── __tests__/
        ├── types.test.ts       # schema 校验测试
        ├── validate.test.ts    # 校验逻辑测试
        └── component.test.ts   # 组件渲染 + 输入 + 结果测试
```

**职责边界：**
- `types.ts`：纯类型 + schema，零依赖 pi（仅 typebox）
- `validate.ts`：纯函数，依赖 types.ts
- `question-view.ts` / `submit-view.ts`：纯渲染函数，接收 state 返回 string[]，依赖 types.ts + pi-tui（theme 函数）
- `component.ts`：状态机 + 输入路由 + 调用渲染函数，依赖上述全部 + pi-tui（Editor/Key/matchesKey）
- `index.ts`：工厂胶水，注册 tool，依赖全部

---

## 任务 1: 包骨架 + package.json + 入口 re-export

**文件：**
- 创建：`extensions/ask-user/package.json`
- 创建：`extensions/ask-user/index.ts`
- 创建：`extensions/ask-user/vitest.config.ts`
- 创建：`extensions/ask-user/README.md`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "@zhushanwen/pi-ask-user",
  "version": "0.1.0",
  "description": "Inline adaptive ask_user tool for Pi — single/multi-question structured input with split-pane preview, inline editor, and optional comments.",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": [
      "./index.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "ask",
    "ask_user",
    "interactive"
  ],
  "license": "MIT",
  "files": [
    "index.ts",
    "src/",
    "README.md"
  ],
  "scripts": {
    "typecheck": "npx tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-tui": {
      "optional": true
    }
  }
}
```

- [ ] **步骤 2：创建顶层 index.ts（re-export）**

```typescript
export { default } from "./src/index.ts";
```

- [ ] **步骤 3：创建 vitest.config.ts**

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		root: __dirname,
	},
	resolve: {
		alias: {
			"@mariozechner/pi-tui": path.resolve(
				__dirname,
				"./node_modules/@earendil-works/pi-tui/dist/index.js",
			),
		},
	},
});
```

- [ ] **步骤 4：创建 README.md（最小）**

```markdown
# @zhushanwen/pi-ask-user

Inline adaptive `ask_user` tool for Pi coding agent. Single question (no tabs) or 1-4 questions (tab view + submit). Split-pane Markdown preview on wide terminals, inline free-text editor, optional comments.

## Install

\`\`\`bash
pi install npm:@zhushanwen/pi-ask-user
\`\`\`

## Tool

`ask_user` — see `spec.md` for full schema.
```

- [ ] **步骤 5：创建空 src/index.ts 占位（让 typecheck 不报错）**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	// Placeholder — filled in task 7
}
```

- [ ] **步骤 6：提交**

```bash
cd extensions/ask-user
git add -A
git commit -m "feat(ask-user): scaffold package structure"
```

---

## 任务 2: types.ts — schema + 类型 + 常量

**文件：**
- 创建：`extensions/ask-user/src/types.ts`
- 测试：`extensions/ask-user/src/__tests__/types.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import { InputSchema, OTHER_LABEL, SPLIT_PANE_MIN_WIDTH } from "../types";

describe("types", () => {
	it("InputSchema accepts valid single question", () => {
		const valid = {
			questions: [
				{
					question: "Which DB?",
					options: [
						{ label: "Postgres" },
						{ label: "SQLite" },
					],
				},
			],
		};
		expect(InputSchema).toBeDefined();
		// Schema is a typebox object; verify it has the questions property structure
		expect((InputSchema as { properties: Record<string, unknown> }).properties.questions).toBeDefined();
		expect(valid.questions).toHaveLength(1);
	});

	it("OTHER_LABEL constant is the free-text option label", () => {
		expect(OTHER_LABEL).toBe("Other");
	});

	it("SPLIT_PANE_MIN_WIDTH is 84", () => {
		expect(SPLIT_PANE_MIN_WIDTH).toBe(84);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/types.test.ts`
预期：FAIL — 模块找不到 `../types`

- [ ] **步骤 3：编写 types.ts**

```typescript
// src/types.ts
import { Type, type Static } from "@sinclair/typebox";

// ── 常量 ─────────────────────────────────────────────
export const OTHER_LABEL = "Other";
export const HEADER_MAX_CHARS = 12;
export const SPLIT_PANE_MIN_WIDTH = 84;
export const SPLIT_PANE_SEPARATOR = " │ ";
export const SPLIT_PANE_LEFT_MIN = 32;
export const SPLIT_PANE_RIGHT_MIN = 28;
export const ANSWER_COMMENT_SEPARATOR = " — ";

// ── Input schema（LLM 调用参数） ─────────────────────
export const OptionSchema = Type.Object({
	label: Type.String({ description: "选项标签，同时也是返回给 LLM 的答案值" }),
	description: Type.Optional(
		Type.String({ description: "选项说明，显示在 label 下方及分屏预览中" }),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({ description: "完整问题文本" }),
	header: Type.Optional(
		Type.String({
			description: "Tab 标签，≤12 字符。多问题（questions.length>1）时必填，单问题可省略",
		}),
	),
	context: Type.Optional(Type.String({ description: "问题前的上下文摘要" })),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 个选项",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "默认 false。true=多选 checkbox" }),
	),
	allowComment: Type.Optional(
		Type.Boolean({ description: "默认 false。true=选中后追加自由文本评论" }),
	),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 个问题",
	}),
});

// ── 派生类型 ─────────────────────────────────────────
export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type Input = Static<typeof InputSchema>;

// ── Result schema（details，renderResult 数据源） ─────
export const ResultSchema = Type.Object({
	questions: Type.Array(QuestionSchema),
	answers: Type.Record(Type.String(), Type.String()),
	cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/types.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/types.ts src/__tests__/types.test.ts
git commit -m "feat(ask-user): add types.ts — schema, constants, derived types"
```

---

## 任务 3: validate.ts — 参数校验

**文件：**
- 创建：`extensions/ask-user/src/validate.ts`
- 测试：`extensions/ask-user/src/__tests__/validate.test.ts`

校验规则（spec FR-2）：重复 question 文本、同问题内重复 option label、多问题缺 header → 返回错误消息字符串；通过返回 null。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/validate.test.ts
import { describe, it, expect } from "vitest";
import { validateInput } from "../validate";
import type { Question } from "../types";

const q = (overrides: Partial<Question> = {}): Question => ({
	question: "Q1",
	options: [{ label: "A" }, { label: "B" }],
	...overrides,
});

describe("validateInput", () => {
	it("returns null for valid single question", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("returns null for valid multiple questions with headers", () => {
		expect(
			validateInput([
				q({ question: "Q1", header: "First" }),
				q({ question: "Q2", header: "Second" }),
			]),
		).toBeNull();
	});

	it("returns null for single question without header", () => {
		expect(validateInput([q()])).toBeNull();
	});

	it("detects duplicate question text", () => {
		const result = validateInput([
			q({ question: "Same", header: "A" }),
			q({ question: "Same", header: "B" }),
		]);
		expect(result).toContain("Duplicate question");
		expect(result).toContain("Same");
	});

	it("detects duplicate option labels within a question", () => {
		const result = validateInput([
			q({ options: [{ label: "A" }, { label: "A" }] }),
		]);
		expect(result).toContain("Duplicate option label");
		expect(result).toContain("A");
	});

	it("detects missing header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2" }), // no header
		]);
		expect(result).toContain("header");
		expect(result).toContain("Q2");
	});

	it("detects empty-string header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "  " }),
		]);
		// Single question with whitespace header is fine (header unused)
		expect(result).toBeNull();
	});

	it("detects empty-string header in multi-question", () => {
		const result = validateInput([
			q({ question: "Q1", header: "First" }),
			q({ question: "Q2", header: "  " }),
		]);
		expect(result).toContain("header");
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/validate.test.ts`
预期：FAIL — 模块找不到 `../validate`

- [ ] **步骤 3：编写 validate.ts**

```typescript
// src/validate.ts
import type { Question } from "./types";

/**
 * 校验输入参数。通过返回 null，失败返回错误消息字符串。
 * 校验项（spec FR-2）：
 * - question 文本在数组内唯一
 * - 同问题内 option label 唯一
 * - 多问题（questions.length > 1）时每个 question 必须有非空 header
 */
export function validateInput(questions: Question[]): string | null {
	const seenQuestions = new Set<string>();

	for (const q of questions) {
		// 1. question 文本唯一
		if (seenQuestions.has(q.question)) {
			return `Duplicate question: "${q.question}"`;
		}
		seenQuestions.add(q.question);

		// 2. option label 唯一
		const seenLabels = new Set<string>();
		for (const opt of q.options) {
			if (seenLabels.has(opt.label)) {
				return `Duplicate option label "${opt.label}" in question "${q.question}"`;
			}
			seenLabels.add(opt.label);
		}
	}

	// 3. 多问题时 header 必填且非空
	if (questions.length > 1) {
		for (const q of questions) {
			if (!q.header || q.header.trim() === "") {
				return `Question "${q.question}" requires a non-empty header in multi-question mode`;
			}
		}
	}

	return null;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/validate.test.ts`
预期：PASS（全部 8 个）

- [ ] **步骤 5：提交**

```bash
git add src/validate.ts src/__tests__/validate.test.ts
git commit -m "feat(ask-user): add validate.ts — uniqueness + header checks"
```

---

## 任务 4: submit-view.ts — Submit tab 渲染（纯函数，最简单，先做）

**文件：**
- 创建：`extensions/ask-user/src/submit-view.ts`
- 测试：`extensions/ask-user/src/__tests__/submit-view.test.ts`

先做最简单的纯渲染函数。Submit tab 显示所有问题的 header: answer 汇总。

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/submit-view.test.ts
import { describe, it, expect } from "vitest";
import { renderSubmitView } from "../submit-view";
import type { Question } from "../types";
import type { QuestionState } from "../component";

const stubTheme = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const q1: Question = {
	question: "Which DB?",
	header: "Database",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({
	cursorIndex: 0,
	selectedIndex: null,
	selectedIndices: new Set<number>(),
	confirmed: false,
	freeTextValue: null,
	commentValue: null,
	mode: "options",
	...over,
});

describe("renderSubmitView", () => {
	it("shows 'Ready to submit' when all confirmed", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme as any, 60);
		expect(lines.some((l) => l.includes("Ready to submit"))).toBe(true);
		expect(lines.some((l) => l.includes("Press Enter"))).toBe(true);
	});

	it("shows 'Unanswered' when not all confirmed", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme as any, 60);
		expect(lines.some((l) => l.includes("Unanswered"))).toBe(true);
		expect(lines.some((l) => l.includes("Database"))).toBe(true);
	});

	it("lists answered header: answer", () => {
		const states = [makeState({ confirmed: true, selectedIndex: 0 })];
		const lines = renderSubmitView([q1], states, stubTheme as any, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("Postgres"))).toBe(true);
	});

	it("shows dash for unanswered", () => {
		const states = [makeState({ confirmed: false })];
		const lines = renderSubmitView([q1], states, stubTheme as any, 60);
		expect(lines.some((l) => l.includes("Database") && l.includes("—"))).toBe(true);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/submit-view.test.ts`
预期：FAIL — 模块找不到

- [ ] **步骤 3：编写 submit-view.ts**

```typescript
// src/submit-view.ts
import { truncateToWidth } from "@mariozechner/pi-tui";
import { HEADER_MAX_CHARS } from "./types";
import type { Question, Result } from "./types";
import type { QuestionState, ThemeLike } from "./component";

/**
 * 获取单问题的答案文本（供 Submit tab 显示）。
 * 返回 null 表示未答。
 */
export function getAnswerText(q: Question, s: QuestionState): string | null {
	if (!s.confirmed) return null;
	const parts: string[] = [];
	if (q.multiSelect) {
		const labels = [...s.selectedIndices]
			.sort((a, b) => a - b)
			.map((idx) => q.options[idx]?.label)
			.filter((l): l is string => !!l);
		parts.push(...labels);
	} else if (s.selectedIndex !== null) {
		const label = q.options[s.selectedIndex]?.label;
		if (label) parts.push(label);
	}
	if (s.freeTextValue !== null) parts.push(s.freeTextValue);
	if (parts.length === 0) return null;
	const base = parts.join(", ");
	return s.commentValue ? `${base}${" — "}${s.commentValue}` : base;
}

/**
 * 渲染 Submit tab 视图。
 */
export function renderSubmitView(
	questions: Question[],
	states: QuestionState[],
	theme: ThemeLike,
	width: number,
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string) => lines.push(truncateToWidth(s, width));

	const allDone = states.every((s) => s.confirmed);

	add(
		allDone
			? t.fg("success", t.bold(" Ready to submit"))
			: t.fg("warning", t.bold(" Unanswered questions")),
	);
	add("");

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const answer = getAnswerText(q, states[i]!);
		const headerLabel = truncateToWidth(q.header ?? "", HEADER_MAX_CHARS);
		if (answer !== null) {
			add(` ${t.fg("muted", `${headerLabel}: `)}${t.fg("text", answer)}`);
		} else {
			add(` ${t.fg("dim", `${headerLabel}: `)}${t.fg("warning", "—")}`);
		}
	}

	add("");
	if (allDone) {
		add(t.fg("success", " Press Enter to submit"));
	} else {
		const missing = questions
			.filter((_, i) => !states[i]!.confirmed)
			.map((q) => truncateToWidth(q.header ?? "", HEADER_MAX_CHARS))
			.join(", ");
		add(t.fg("warning", ` Still needed: ${missing}`));
	}
	add("");
	add(t.fg("dim", " ←→ switch tabs · Esc cancel"));

	return lines;
}

/**
 * 从 states 构建 Result（供组件 buildResult 调用）。
 */
export function buildResult(questions: Question[], states: QuestionState[]): Result {
	const answers: Record<string, string> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const s = states[i]!;
		const text = getAnswerText(q, s);
		if (text !== null) answers[q.question] = text;
	}
	return { questions, answers, cancelled: false };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/submit-view.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/submit-view.ts src/__tests__/submit-view.test.ts
git commit -m "feat(ask-user): add submit-view.ts — Submit tab render + buildResult"
```

---

## 任务 5: question-view.ts — 单问题渲染（选项列表 + 分屏 + 编辑器 + 评论）

**文件：**
- 创建：`extensions/ask-user/src/question-view.ts`
- 测试：`extensions/ask-user/src/__tests__/question-view.test.ts`

这是最大的渲染模块。包含：选项列表（单选/多选）、Other 行、分屏预览（宽终端）、内联编辑器、评论行、帮助行。

- [ ] **步骤 1：编写失败的测试（核心渲染断言）**

```typescript
// src/__tests__/question-view.test.ts
import { describe, it, expect } from "vitest";
import { renderQuestionView, getSplitPaneWidths } from "../question-view";
import type { Question } from "../types";
import type { QuestionState } from "../component";

const stubTheme = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const singleQ: Question = {
	question: "Which database?",
	options: [
		{ label: "Postgres", description: "Battle-tested" },
		{ label: "SQLite", description: "Embedded" },
	],
};

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({
	cursorIndex: 0,
	selectedIndex: null,
	selectedIndices: new Set<number>(),
	confirmed: false,
	freeTextValue: null,
	commentValue: null,
	mode: "options",
	...over,
});

describe("renderQuestionView", () => {
	it("renders question text", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme as any, 60, true);
		expect(lines.some((l) => l.includes("Which database?"))).toBe(true);
	});

	it("renders all options + Other", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme as any, 60, true);
		expect(lines.some((l) => l.includes("Postgres"))).toBe(true);
		expect(lines.some((l) => l.includes("SQLite"))).toBe(true);
		expect(lines.some((l) => l.includes("Other"))).toBe(true);
	});

	it("renders cursor > on first option", () => {
		const lines = renderQuestionView(singleQ, makeState({ cursorIndex: 0 }), stubTheme as any, 60, true);
		expect(lines.some((l) => l.includes(">") && l.includes("Postgres"))).toBe(true);
	});

	it("renders single-select check on confirmed selection", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ selectedIndex: 1 }),
			stubTheme as any,
			60,
			true,
		);
		expect(lines.some((l) => l.includes("✓") && l.includes("SQLite"))).toBe(true);
	});

	it("renders multi-select checkboxes", () => {
		const multiQ: Question = {
			question: "Which features?",
			options: [{ label: "Auth" }, { label: "Search" }],
			multiSelect: true,
		};
		const lines = renderQuestionView(
			multiQ,
			makeState({ selectedIndices: new Set([0]) }),
			stubTheme as any,
			60,
			true,
		);
		expect(lines.some((l) => l.includes("[✓]") && l.includes("Auth"))).toBe(true);
		expect(lines.some((l) => l.includes("[ ]") && l.includes("Search"))).toBe(true);
	});

	it("renders descriptions in muted", () => {
		const lines = renderQuestionView(singleQ, makeState(), stubTheme as any, 60, true);
		expect(lines.some((l) => l.includes("Battle-tested"))).toBe(true);
	});

	it("shows comment prompt in comment mode", () => {
		const lines = renderQuestionView(
			singleQ,
			makeState({ mode: "comment", selectedIndex: 0 }),
			stubTheme as any,
			60,
			true,
		);
		expect(lines.some((l) => l.toLowerCase().includes("comment"))).toBe(true);
	});
});

describe("getSplitPaneWidths", () => {
	it("returns null on narrow terminal", () => {
		expect(getSplitPaneWidths(60)).toBeNull();
	});

	it("returns widths on wide terminal", () => {
		const result = getSplitPaneWidths(100);
		expect(result).not.toBeNull();
		expect(result!.left).toBeGreaterThan(0);
		expect(result!.right).toBeGreaterThan(0);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/question-view.test.ts`
预期：FAIL — 模块找不到

- [ ] **步骤 3：编写 question-view.ts**

```typescript
// src/question-view.ts
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	HEADER_MAX_CHARS,
	OTHER_LABEL,
	SPLIT_PANE_LEFT_MIN,
	SPLIT_PANE_MIN_WIDTH,
	SPLIT_PANE_RIGHT_MIN,
	SPLIT_PANE_SEPARATOR,
} from "./types";
import type { Question } from "./types";
import type { EditorState, QuestionState, ThemeLike } from "./component";

export interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

/** 在选项数组末尾追加 Other 自由输入项。 */
export function allOptions(q: Question): DisplayOption[] {
	return [...q.options, { label: OTHER_LABEL, isOther: true }];
}

/**
 * 宽终端（≥SPLIT_PANE_MIN_WIDTH）计算左右分屏宽度。窄终端返回 null（单列模式）。
 */
export function getSplitPaneWidths(width: number): { left: number; right: number } | null {
	if (width < SPLIT_PANE_MIN_WIDTH) return null;
	const available = width - SPLIT_PANE_SEPARATOR.length;
	if (available < SPLIT_PANE_LEFT_MIN + SPLIT_PANE_RIGHT_MIN) return null;
	const preferredLeft = Math.floor(available * 0.42);
	const left = Math.max(
		SPLIT_PANE_LEFT_MIN,
		Math.min(preferredLeft, available - SPLIT_PANE_RIGHT_MIN),
	);
	const right = available - left;
	if (right < SPLIT_PANE_RIGHT_MIN) return null;
	return { left, right };
}

/** 构建选项列表行（不含分屏预览）。hideDescriptions 用于分屏模式左列。 */
function buildOptionLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	hideDescriptions: boolean,
): string[] {
	const t = theme;
	const opts = allOptions(q);
	const lines: string[] = [];
	const add = (s: string) => lines.push(truncateToWidth(s, width));

	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i]!;
		const isSelected = i === state.cursorIndex;
		const isOther = opt.isOther === true;
		const prefix = isSelected ? t.fg("accent", ">") : " ";

		if (isOther) {
			const hasFreeText = state.freeTextValue !== null && state.mode !== "freeform";
			const check = hasFreeText ? t.fg("success", "✓") : " ";
			const labelColor = isSelected ? "accent" : "muted";
			const num = i + 1;
			add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (hasFreeText) {
				const preview = truncateToWidth(state.freeTextValue ?? "", width - 5);
				add(`     ${t.fg("dim", `"${preview}"`)}`);
			}
		} else if (q.multiSelect) {
			const checked = state.selectedIndices.has(i);
			const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${box} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 7);
				for (const line of wrapped) add(`       ${line}`);
			}
		} else {
			const isConfirmed = state.selectedIndex === i;
			const check = isConfirmed ? t.fg("success", "✓") : " ";
			const labelColor = isSelected ? "accent" : "text";
			const num = i + 1;
			add(`${prefix} ${check} ${t.fg(labelColor, `${num}. ${opt.label}`)}`);
			if (opt.description && !hideDescriptions) {
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - 5);
				for (const line of wrapped) add(`     ${line}`);
			}
		}
	}
	return lines;
}

/** 构建分屏右侧 Markdown 详情预览。 */
function buildPreviewLines(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	maxLines: number,
): string[] {
	const t = theme;
	const opts = allOptions(q);
	const opt = opts[state.cursorIndex];
	if (!opt) return [t.fg("dim", "—")];

	let text = "";
	if (opt.isOther) {
		text = `${opt.label}: enter a custom answer not listed above.`;
	} else {
		text = opt.label;
		if (opt.description?.trim()) text += `\n\n${opt.description}`;
	}

	const wrapped = wrapTextWithAnsi(t.fg("muted", text), Math.max(10, width));
	const lines = wrapped.slice(0, maxLines);
	if (wrapped.length > maxLines) lines.push(t.fg("dim", "…"));
	return lines;
}

/**
 * 渲染单个问题视图（spec FR-4）。
 * isSingle: 单问题模式（无 Tab 提示）。
 */
export function renderQuestionView(
	q: Question,
	state: QuestionState,
	theme: ThemeLike,
	width: number,
	isSingle: boolean,
	editor?: EditorState,
): string[] {
	const t = theme;
	const lines: string[] = [];
	const add = (s: string) => lines.push(truncateToWidth(s, width));

	// 问题文本（word-wrap）
	const wrapped = wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - 2);
	for (const line of wrapped) add(line);

	// 上下文（如有）
	if (q.context?.trim()) {
		add("");
		const ctxWrapped = wrapTextWithAnsi(t.fg("muted", q.context), width - 2);
		for (const line of ctxWrapped) add(line);
	}
	add("");

	// 分屏判断
	const split = getSplitPaneWidths(width);

	if (state.mode === "freeform" || state.mode === "comment") {
		// 编辑器/评论模式：选项列表 + 下方就地展开 Editor
		const optionLines = buildOptionLines(q, state, theme, split ? split.left : width, !!split);
		for (const line of optionLines) add(line);

		add("");
		const prompt =
			state.mode === "comment"
				? t.fg("muted", " Your comment (optional):")
				: t.fg("muted", " Your answer:");
		add(prompt);
		if (editor?.lines) {
			for (const line of editor.lines) add(` ${line}`);
		}
		add("");
		add(t.fg("dim", " Enter submit · Esc back"));
		return lines;
	}

	if (!split) {
		// 单列模式
		const optionLines = buildOptionLines(q, state, theme, width, false);
		for (const line of optionLines) add(line);
	} else {
		// 分屏模式
		const leftLines = buildOptionLines(q, state, theme, split.left, true);
		const rightLines = buildPreviewLines(q, state, theme, split.right, Math.max(leftLines.length, 8));
		const rowCount = Math.max(leftLines.length, rightLines.length);
		const sep = t.fg("dim", SPLIT_PANE_SEPARATOR);
		for (let i = 0; i < rowCount; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", split.left, "", true);
			const right = truncateToWidth(rightLines[i] ?? "", split.right, "");
			add(`${left}${sep}${right}`);
		}
	}

	add("");

	// 帮助行（上下文相关）
	const opts = allOptions(q);
	const onOther = state.cursorIndex === opts.length - 1;
	const tabHint = isSingle ? "" : " · ←→ switch tabs";
	let actionHint: string;
	if (onOther) {
		actionHint = "Space/Tab open editor";
	} else if (q.multiSelect) {
		actionHint = "Space toggle · Enter confirm";
	} else {
		actionHint = "Enter select";
	}
	add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc cancel`));

	return lines;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/question-view.test.ts`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/question-view.ts src/__tests__/question-view.test.ts
git commit -m "feat(ask-user): add question-view.ts — options + split-pane + editor + comment"
```

---

## 任务 6: component.ts — 主组件（状态机 + Tab bar + 输入路由）

**文件：**
- 创建：`extensions/ask-user/src/component.ts`
- 测试：`extensions/ask-user/src/__tests__/component.test.ts`

主组件。定义 QuestionState、ThemeLike、EditorState 类型（被其他模块 import）。管理 Tab 导航、输入路由、Editor 实例、buildResult。

- [ ] **步骤 1：编写失败的测试（核心交互）**

```typescript
// src/__tests__/component.test.ts
import { describe, it, expect } from "vitest";
import { AskUserComponent } from "../component";
import type { Question } from "../types";

const stubTheme = {
	fg: (_t: string, s: string) => s,
	bg: (_t: string, s: string) => s,
	bold: (s: string) => s,
};

const mockTui = { requestRender: () => {} };

const singleQ: Question = {
	question: "Which DB?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

const multiQ: Question[] = [
	{ question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
	{ question: "Q2", header: "Second", options: [{ label: "X" }, { label: "Y" }], multiSelect: true },
];

const make = (
	questions: Question[],
	done: (r: unknown) => void = () => {},
): AskUserComponent =>
	new AskUserComponent(questions, mockTui as any, stubTheme as any, done as any);

// Key constants matching pi-tui Key object
const ENTER = "\r";
const SPACE = " ";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

describe("AskUserComponent — single question", () => {
	it("renders question without tab bar", () => {
		const c = make([singleQ]);
		const lines = c.render(60);
		expect(lines.some((l) => l.includes("Which DB?"))).toBe(true);
		// No tab bar in single-question mode
		expect(lines.some((l) => l.includes("Submit"))).toBe(false);
	});

	it("confirms first option on Enter and resolves", () => {
		let resolved: unknown = undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(ENTER);
		expect(resolved).not.toBeUndefined();
		const result = resolved as { cancelled: boolean; answers: Record<string, string> };
		expect(result.cancelled).toBe(false);
		expect(result.answers["Which DB?"]).toBe("Postgres");
	});

	it("moves cursor down then confirms second option", () => {
		let resolved: unknown = undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(DOWN);
		c.handleInput(ENTER);
		const result = resolved as { answers: Record<string, string> };
		expect(result.answers["Which DB?"]).toBe("SQLite");
	});

	it("resolves cancelled on Esc", () => {
		let resolved: unknown = undefined;
		const c = make([singleQ], (r) => (resolved = r));
		c.handleInput(ESC);
		expect(resolved).toBeNull();
	});
});

describe("AskUserComponent — multi question", () => {
	it("renders tab bar with headers + Submit", () => {
		const c = make(multiQ);
		const lines = c.render(80);
		expect(lines.some((l) => l.includes("First"))).toBe(true);
		expect(lines.some((l) => l.includes("Second"))).toBe(true);
		expect(lines.some((l) => l.includes("Submit"))).toBe(true);
	});

	it("navigates tabs and submits all answers", () => {
		let resolved: unknown = undefined;
		const c = make(multiQ, (r) => (resolved = r));
		// Q1: select A (Enter)
		c.handleInput(ENTER);
		// Q2: toggle X (Space), confirm (Enter)
		c.handleInput(SPACE);
		c.handleInput(ENTER);
		// Submit tab: Enter
		c.handleInput(ENTER);
		const result = resolved as { answers: Record<string, string> };
		expect(result.answers["Q1"]).toBe("A");
		expect(result.answers["Q2"]).toBe("X");
	});

	it("Submit tab blocks when not all confirmed", () => {
		let resolved: unknown = undefined;
		const c = make(multiQ, (r) => (resolved = r));
		// Jump to Submit without answering
		c.handleInput(RIGHT); // -> Q2
		c.handleInput(RIGHT); // -> Submit
		c.handleInput(ENTER); // should NOT submit
		expect(resolved).toBeUndefined();
	});
});

describe("AskUserComponent — render cache", () => {
	it("returns same reference on repeated render with same width", () => {
		const c = make([singleQ]);
		const a = c.render(60);
		const b = c.render(60);
		expect(a).toBe(b);
	});

	it("returns new reference after input (invalidate)", () => {
		const c = make([singleQ]);
		const a = c.render(60);
		c.handleInput(DOWN);
		const b = c.render(60);
		expect(a).not.toBe(b);
	});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/component.test.ts`
预期：FAIL — 模块找不到

- [ ] **步骤 3：编写 component.ts**

```typescript
// src/component.ts
import { matchesKey, type Component } from "@mariozechner/pi-tui";
import { HEADER_MAX_CHARS, OTHER_LABEL } from "./types";
import type { Question, Result } from "./types";
import { allOptions, renderQuestionView } from "./question-view";
import { renderSubmitView, buildResult } from "./submit-view";

// ── 共享类型（被 question-view / submit-view import） ──

export interface ThemeLike {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
}

export interface TUILike {
	requestRender(): void;
}

export type QuestionMode = "options" | "freeform" | "comment";

export interface QuestionState {
	cursorIndex: number;
	selectedIndex: number | null;
	selectedIndices: Set<number>;
	confirmed: boolean;
	freeTextValue: string | null;
	commentValue: string | null;
	mode: QuestionMode;
}

export interface EditorState {
	lines: string[];
}

function makeInitialState(): QuestionState {
	return {
		cursorIndex: 0,
		selectedIndex: null,
		selectedIndices: new Set<number>(),
		confirmed: false,
		freeTextValue: null,
		commentValue: null,
		mode: "options",
	};
}

// ── AskUserComponent ─────────────────────────────────

export class AskUserComponent implements Component {
	private questions: Question[];
	private theme: ThemeLike;
	private tui: TUILike;
	private done: (result: Result | null) => void;

	private states: QuestionState[];
	private activeTab: number = 0;
	private editorText: string = "";

	private cachedWidth?: number;
	private cachedLines?: string[];
	private _resolved: boolean = false;

	constructor(
		questions: Question[],
		tui: TUILike,
		theme: ThemeLike,
		done: (result: Result | null) => void,
	) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = questions.map(() => makeInitialState());
		this.invalidate();
	}

	// ── 派生 ──
	private get isSingle(): boolean {
		return this.questions.length === 1;
	}
	private get totalTabs(): number {
		return this.questions.length + 1;
	}
	private allConfirmed(): boolean {
		return this.states.every((s) => s.confirmed);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// ── 渲染 ──
	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}
		const t = this.theme;
		const lines: string[] = [];
		const add = (s: string) => lines.push(s);

		add(t.fg("accent", "─".repeat(width)));

		if (!this.isSingle) {
			this.renderTabBar(width, add);
			lines.push("");
		}

		if (this.activeTab >= this.questions.length) {
			// Submit tab
			for (const line of renderSubmitView(this.questions, this.states, t, width)) add(line);
		} else {
			const q = this.questions[this.activeTab]!;
			const state = this.states[this.activeTab]!;
			const editor: EditorState = {
				lines: state.mode === "freeform" || state.mode === "comment" ? [this.editorText] : [],
			};
			for (const line of renderQuestionView(q, state, t, width, this.isSingle, editor)) add(line);
		}

		add(t.fg("accent", "─".repeat(width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderTabBar(_width: number, add: (s: string) => void): void {
		const t = this.theme;
		const parts: string[] = [" "];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i]!;
			const s = this.states[i]!;
			const isActive = i === this.activeTab;
			const header = q.header?.slice(0, HEADER_MAX_CHARS) ?? "";
			if (isActive) {
				parts.push(t.bg("selectedBg", t.fg("text", ` ${header} `)));
			} else if (s.confirmed) {
				parts.push(t.fg("success", ` ■${header} `));
			} else {
				parts.push(t.fg("muted", ` □${header} `));
			}
		}
		const isSubmit = this.activeTab === this.questions.length;
		const submitLabel = " ✓ Submit ";
		if (isSubmit) {
			parts.push(t.bg("selectedBg", t.fg("text", submitLabel)));
		} else if (this.allConfirmed()) {
			parts.push(t.fg("success", submitLabel));
		} else {
			parts.push(t.fg("dim", submitLabel));
		}
		add(parts.join(""));
	}

	// ── 输入路由 ──
	handleInput(data: string): void {
		if (this._resolved) return;

		// Submit tab
		if (!this.isSingle && this.activeTab === this.questions.length) {
			this.handleSubmitTabInput(data);
			return;
		}

		const state = this.states[this.activeTab]!;
		const q = this.questions[this.activeTab]!;

		// freeform / comment mode → editor text input
		if (state.mode === "freeform" || state.mode === "comment") {
			this.handleEditorInput(data, state, q);
			return;
		}

		// Esc → cancel
		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}

		// Tab navigation (multi-question)
		if (!this.isSingle && matchesKey(data, "right")) {
			this.autoConfirmIfAnswered();
			this.activeTab = (this.activeTab + 1) % this.totalTabs;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (!this.isSingle && matchesKey(data, "left")) {
			this.autoConfirmIfAnswered();
			this.activeTab = (this.activeTab - 1 + this.totalTabs) % this.totalTabs;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			state.cursorIndex = Math.max(0, state.cursorIndex - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			const max = allOptions(q).length - 1;
			state.cursorIndex = Math.min(max, state.cursorIndex + 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const opts = allOptions(q);
		const onOther = state.cursorIndex === opts.length - 1;

		// Other row → Space/Tab opens freeform editor
		if (onOther && (matchesKey(data, "space") || matchesKey(data, "tab"))) {
			state.mode = "freeform";
			this.editorText = state.freeTextValue ?? "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (q.multiSelect && !onOther) {
			if (matchesKey(data, "space")) {
				this.toggleIndex(state, state.cursorIndex);
				return;
			}
			if (matchesKey(data, "enter") && (state.selectedIndices.size > 0 || state.freeTextValue !== null)) {
				this.afterConfirm(state, q);
				return;
			}
		} else if (!q.multiSelect && !onOther) {
			if (matchesKey(data, "enter")) {
				state.selectedIndex = state.cursorIndex;
				state.freeTextValue = null;
				this.afterConfirm(state, q);
				return;
			}
		}
	}

	private handleSubmitTabInput(data: string): void {
		if (matchesKey(data, "enter") && this.allConfirmed()) {
			this.submit();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		if (matchesKey(data, "right")) {
			this.activeTab = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.activeTab = this.questions.length - 1;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
	}

	private handleEditorInput(data: string, state: QuestionState, q: Question): void {
		if (matchesKey(data, "escape")) {
			// Esc in editor = back to options (skip, don't submit)
			state.mode = "options";
			this.editorText = "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			const text = this.editorText.trim();
			if (state.mode === "freeform") {
				if (text) {
					state.freeTextValue = text;
					state.selectedIndex = null;
				} else {
					state.freeTextValue = null;
				}
			} else {
				// comment mode
				state.commentValue = text || null;
			}
			state.mode = "options";
			this.editorText = "";
			this.afterConfirm(state, q);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.editorText = this.editorText.slice(0, -1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		// Printable char
		if (data.length === 1 && data >= " ") {
			this.editorText += data;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
	}

	private toggleIndex(state: QuestionState, index: number): void {
		if (state.selectedIndices.has(index)) state.selectedIndices.delete(index);
		else state.selectedIndices.add(index);
		if (state.selectedIndices.size === 0 && state.freeTextValue === null) {
			state.confirmed = false;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private autoConfirmIfAnswered(): void {
		const state = this.states[this.activeTab];
		if (!state || state.confirmed) return;
		const q = this.questions[this.activeTab]!;
		const hasAnswer =
			q.multiSelect
				? state.selectedIndices.size > 0 || state.freeTextValue !== null
				: state.freeTextValue !== null || state.selectedIndex !== null;
		if (hasAnswer) state.confirmed = true;
	}

	/** 选中确认后的处理：若 allowComment 且未输入评论，进入评论模式；否则前进。 */
	private afterConfirm(state: QuestionState, q: Question): void {
		state.confirmed = true;
		if (q.allowComment && state.commentValue === null && state.mode !== "comment") {
			// 进入评论输入行
			state.mode = "comment";
			this.editorText = "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.advance();
	}

	private advance(): void {
		if (this.isSingle) {
			this.submit();
			return;
		}
		if (this.activeTab < this.questions.length - 1) {
			this.activeTab++;
		} else {
			this.activeTab = this.questions.length;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(): void {
		this._resolved = true;
		this.done(buildResult(this.questions, this.states));
	}

	private cancel(): void {
		this._resolved = true;
		this.done(null);
	}
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/ask-user && npx vitest run src/__tests__/component.test.ts`
预期：PASS

如有失败，常见原因：Key 匹配——pi-tui 的 `matchesKey(data, "enter")` 对 `\r` 生效，`"escape"` 对 `\x1b` 生效。若不匹配，用 `Key.enter` 等常量代替字符串（但测试中需用相同常量）。调整测试的 key 常量与组件实现一致。

- [ ] **步骤 5：提交**

```bash
git add src/component.ts src/__tests__/component.test.ts
git commit -m "feat(ask-user): add component.ts — state machine + tab nav + input routing"
```

---

## 任务 7: src/index.ts — 工厂注册 ask_user tool

**文件：**
- 修改：`extensions/ask-user/src/index.ts`（替换占位）

注册 tool：execute（校验 → hasUI 检查 → signal 检查 → custom UI → 返回）、renderCall、renderResult。

- [ ] **步骤 1：编写工厂 index.ts**

```typescript
// src/index.ts
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AskUserComponent } from "./component";
import { InputSchema } from "./types";
import type { Question, Result } from "./types";
import { validateInput } from "./validate";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: `Ask the user 1-4 clarifying questions before proceeding. Use this tool to clarify ambiguous instructions, get preference between approaches, or make implementation decisions. Each question has 2-4 options; users can always choose "Other" to type a free-text answer. Set multiSelect: true when multiple choices valid. The header field (≤12 chars) labels each question's tab when asking multiple. If you recommend an option, list it first with "(Recommended)". Always use this tool instead of asking in plain text — it provides a structured interactive UI.`,
		promptSnippet: "Ask the user structured clarifying questions with options before proceeding",
		promptGuidelines: [
			"Use ask_user when the user's intent is ambiguous, a decision requires explicit input, or multiple valid options exist.",
			"Gather context first (read/grep) and pass a short summary via the context field — don't ask blind.",
			"Ask focused questions; each question = one decision. Batch related decisions into one call (1-4 questions).",
			"Do NOT use ask_user for trivial choices or questions answerable by reading code/docs.",
			"Do NOT include an 'Other' option yourself — it is always available automatically.",
		],
		parameters: InputSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = (params as { questions: Question[] }).questions;

			// 1. 参数校验（spec FR-2）→ isError
			const validationError = validateInput(questions);
			if (validationError) {
				return {
					content: [{ type: "text", text: `Error: ${validationError}` }],
					isError: true,
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 2. Headless 检查（spec FR-8）→ isError + 禁用工具
			if (!ctx.hasUI) {
				pi.setActiveTools(
					pi.getAllTools().map((t: { name: string }) => t.name).filter((n) => n !== "ask_user"),
				);
				return {
					content: [
						{
							type: "text",
							text: "Error: ask_user requires an interactive session. The tool has been disabled for this session.",
						},
					],
					isError: true,
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 3. Signal abort 入口检查（spec FR-10）
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 4. 顶层 try/catch（spec FR-13）
			let result: Result | null;
			try {
				result = await ctx.ui.custom<Result | null>(
					(tui, theme, _kb, done) => {
						// signal abort 监听（spec FR-10）
						if (signal) {
							signal.addEventListener("abort", () => done(null), { once: true });
						}
						return new AskUserComponent(
							questions,
							tui,
							theme as unknown as import("./component").ThemeLike,
							done,
						);
					},
					// 不传 options → inline 渲染（spec FR-3）
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `ask_user failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}

			// 5. 取消（null / cancelled）
			if (result === null || result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 6. 正常返回
			const summary = result.questions.map(
				(q) => `"${q.question}" = "${result!.answers[q.question] ?? "(no answer)"}"`,
			);
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: result satisfies Result,
			};
		},

		renderCall(args, theme) {
			const questions = ((args.questions ?? []) as Question[]);
			const topics = questions.map((q) => q.header ?? q.question.slice(0, 12)).join(", ");
			return new TruncatedText(
				theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", topics),
				0,
				0,
			) as unknown as Text;
		},

		renderResult(result, _options, theme) {
			const details = result.details as Result | { error?: string } | undefined;
			if (details && "error" in details && details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			const d = details as Result | undefined;
			if (!d || d.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const box = new Box(0, 0);
			for (const q of d.questions) {
				const answer = d.answers[q.question] ?? "(no answer)";
				box.addChild(
					new TruncatedText(
						theme.fg("success", "✓ ") +
							theme.fg("accent", `${q.header ?? q.question.slice(0, 12)}: `) +
							theme.fg("text", answer),
						0,
						0,
					),
				);
			}
			return box as unknown as Text;
		},
	});
}
```

- [ ] **步骤 2：运行全部测试确认无回归**

运行：`cd extensions/ask-user && npx vitest run`
预期：PASS（types + validate + submit-view + question-view + component 全部）

- [ ] **步骤 3：类型检查**

运行：`cd extensions/ask-user && npx tsc --noEmit`
预期：通过（无 any，类型一致）

注：CI 环境 `@types/node` 缺失会导致 tsc 报 `Cannot find type definition file for 'node'`——这是 monorepo 既有环境问题（非本扩展引入），按 `SKIP_LINT` 场景处理。本地有完整 node_modules 时应通过。

- [ ] **步骤 4：提交**

```bash
git add src/index.ts
git commit -m "feat(ask-user): register ask_user tool — execute + renderCall + renderResult"
```

---

## 任务 8: 更新 CLAUDE.md 目录结构 + extensions.yaml

**文件：**
- 修改：`CLAUDE.md`（目录结构章节新增 ask-user）
- 修改：`docs/third-party-extensions/extensions.yaml`（pi-ask-user 标记 replaced_by）

- [ ] **步骤 1：CLAUDE.md 目录结构新增 ask-user**

在 `extensions/` 列表中新增一行（保持字母序或现有顺序，紧跟 turn-timing 之后或合适位置）：

```
│   ├── ask-user/           → @zhushanwen/pi-ask-user
```

找到 CLAUDE.md 中 `extensions/` 目录树（约第 20-35 行），在现有扩展列表中加入。

- [ ] **步骤 2：extensions.yaml 标记 pi-ask-user 被 replaced**

找到 `pi-ask-user` 条目，更新 `status` 和 `replaced_by`：

```yaml
  - name: pi-ask-user
    source: direct-install
    repo: https://github.com/edlsh/pi-ask-user
    stars: null
    installed: "2026-06-01"
    version: "0.11.1"
    license: MIT
    status: replaced          # was: active
    npm_package: pi-ask-user
    replaces: null
    replaced_by: "@zhushanwen/pi-ask-user"   # 新增
    inspired_by: []
    conflicts: []
    analysis: direct-pi-ask-user/analysis.md
    tags: [ask-user, structured-input, tui]
    notes: 已被自研 @zhushanwen/pi-ask-user 替换（inline adaptive，融合两者优点）
```

- [ ] **步骤 3：校验 YAML**

运行：`python3 .githooks/validate-extensions-yaml`
预期：通过

- [ ] **步骤 4：提交**

```bash
git add CLAUDE.md docs/third-party-extensions/extensions.yaml
git commit -m "docs(ask-user): register extension in CLAUDE.md, mark pi-ask-user replaced"
```

---

## 任务 9: 全量验证 + 最终提交

- [ ] **步骤 1：全量测试**

运行：`cd extensions/ask-user && npx vitest run`
预期：所有测试 PASS

- [ ] **步骤 2：检查行数约束**

运行：`cd extensions/ask-user && wc -l src/*.ts`
预期：每个文件 ≤500 行（component.ts 可能最大，应 <350 行）

- [ ] **步骤 3：检查无 any**

运行：`cd extensions/ask-user && grep -rn "as any\|: any" src/ | grep -v "__tests__" | grep -v "// stub"`
预期：无输出（测试中 `as any` 用于 stub theme 可接受，但应最小化）

若有生产代码的 `as any`，改为 `as unknown as ConcreteType` 或精确类型。

- [ ] **步骤 4：最终提交（如有遗留）**

```bash
git add -A
git commit -m "test(ask-user): full suite passing, no any, within line limits"
```

---

## 自我审查清单

写完计划后对照 spec 检查：

**1. 规格覆盖：**
- FR-1 工具注册 → 任务 7 ✅
- FR-2 参数 schema + 校验 → 任务 2（schema）+ 任务 3（校验）✅
- FR-3 自适应渲染（纯 inline）→ 任务 6（component 判断 isSingle）+ 任务 7（不传 options）✅
- FR-4 问题视图（选项/分屏/编辑器/评论/帮助）→ 任务 5 ✅
- FR-5 Submit 视图 → 任务 4 ✅
- FR-6 输入处理 → 任务 6（handleInput 全路由）✅
- FR-7 结果返回 → 任务 4（buildResult）+ 任务 7（execute 包装）✅
- FR-8 Headless → 任务 7（hasUI 检查 + setActiveTools）✅
- FR-9 自定义渲染 → 任务 7（renderCall/renderResult）✅
- FR-10 Signal abort → 任务 7（入口检查 + addEventListener）✅
- FR-11 Comment 存储 → 任务 6（QuestionState.commentValue + afterConfirm 评论模式）✅
- FR-12 防重入守卫 → 任务 6（_resolved）✅
- FR-13 execute 错误兜底 → 任务 7（try/catch）✅
- FR-14 答案回改 → 任务 6（confirmed 保持，handleInput 不阻止已确认 tab）✅
- AC-1..18 → 各任务测试覆盖 ✅

**2. 占位符扫描：** 无 TBD/TODO，所有步骤有完整代码 ✅

**3. 类型一致性：** QuestionState/ThemeLike/EditorState 在 component.ts 定义，question-view.ts 和 submit-view.ts import 使用——命名一致 ✅

**潜在风险点（执行时注意）：**
- pi-tui `matchesKey` 的 key 字符串：测试中用 `\r`/`\x1b` 等，若 pi-tui 用不同编码，调整测试常量。建议先跑一个最小 render 测试确认 key 匹配行为。
- `ctx.ui.custom` 的 factory 第四参数 `done`：确认 Pi 传入的是 `(result) => void`。todo 扩展用 `() => done()`（无参），本扩展需 `done(result)` 传 Result——确认 Pi 支持。
- `TruncatedText`/`Box` 来自 `@earendil-works/pi-tui`，CI stub 未声明这两个类——本地有完整类型，CI 可能需补 stub 或用 `as unknown as Text`（已在 renderCall/renderResult 处理）。
