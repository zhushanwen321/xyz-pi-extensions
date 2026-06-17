// src/index.ts
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Box, Text, TruncatedText, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static } from "@sinclair/typebox";

import { AskUserComponent } from "./component";
import {
	type AskUserDetails,
	type ErrorDetails,
	HEADER_MAX_CHARS,
	InputSchema,
	type Option,
	type Question,
	type Result,
	type ThemeLike,
} from "./types";
import { validateInput } from "./validate";

/**
 * execute 的返回形状：复用 SDK AgentToolResult<AskUserDetails>，叠加运行时使用的 isError 标记。
 * SDK 的 AgentToolResult 类型未声明 isError（运行时通过它标记错误），这里显式补齐。
 */
type ExecuteResult = AgentToolResult<AskUserDetails> & { isError?: boolean };

/**
 * expanded 渲染辅助：展开某问题的全部选项，用 ●/○ 标记是否被选中（spec FR-9）。
 * 选中判定：answer 含该 option label（answer 形如 "Postgres" / "A, B" / "X — comment"）。
 * 返回 TruncatedText 数组供 box.addChild 展开。
 */
function renderExpandedOptions(
	q: Question,
	answer: string,
	theme: ThemeLike,
): TruncatedText[] {
	const answerTokens = new Set(answer.split(/\s*[,—]\s*|\s*,\s*/).filter(Boolean));
	const mark = (opt: Option): string =>
		answerTokens.has(opt.label) || answer.includes(opt.label)
			? theme.fg("success", "●")
			: theme.fg("dim", "○");
	// 只展开真实选项（不含自动追加的 Other）；Other 文本单独显示
	const out: TruncatedText[] = q.options.map(
		(opt: Option) =>
			new TruncatedText(
				theme.fg("dim", "   ") +
					mark(opt) +
					theme.fg("text", ` ${opt.label}`),
				0,
				0,
			),
	);
	return out;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: `Ask the user to resolve ambiguity you cannot resolve yourself. Use ONLY when ALL hold: (1) the request has ≥2 reasonable approaches, (2) you have already gathered context (read/grep) and the answer is still genuinely ambiguous, and (3) picking wrong means redoing real work. One question = one decision with mutually exclusive options.

Do NOT use this tool to outsource judgment you should make — if you can form a defensible recommendation from the codebase, proceed and state your choice. Do NOT use for trivia answerable by reading code/docs, or for simple confirmations ("I'll delete X") where plain text suffices. You cannot use this tool to collect free-form requirements, long-form feedback, or multi-paragraph input — it returns short selections only.

If you recommend an option, prefix its label with "(Recommended)" and list it first. For structured multi-option decisions, prefer this tool over plain-text questions; for everything else, reply in plain text.`,
		promptSnippet:
			"Ask the user structured clarifying questions with options — only when you cannot resolve the ambiguity yourself",
		promptGuidelines: [
			"Use ask_user only when the request has ≥2 reasonable approaches you cannot resolve from context. Models over-ask because asking feels safer than deciding — resist this: if context makes the answer clear, proceed without asking.",
			"Gather context first (read/grep) and pass a short summary via the context field — don't ask blind. If the answer becomes clear after gathering context, proceed and state your choice.",
			"Ask focused questions; each question = one decision with mutually exclusive options. Batch related decisions into one call (1-4 questions).",
			"Do NOT use ask_user for trivia answerable by reading code/docs, or to confirm simple actions ('I'll delete X') — plain text suffices there.",
			"Do NOT outsource judgment you can make yourself: if you can form a defensible recommendation from the codebase, proceed and state it instead of asking.",
			"Do NOT include an 'Other' option yourself — it is always available automatically.",
		],
		parameters: InputSchema,

		async execute(
			_toolCallId: string,
			params: Static<typeof InputSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ExecuteResult> {
			const questions = params.questions;

			// 1. 参数校验（spec FR-2）→ isError
			const validationError = validateInput(questions);
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Error: ${validationError}` }],
					isError: true,
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 2. Headless 检查（spec FR-8）→ isError + 禁用工具
			if (!ctx.hasUI) {
				pi.setActiveTools(
					pi
						.getAllTools()
						.map((t: { name: string }) => t.name)
						.filter((n: string) => n !== "ask_user"),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: ask_user requires an interactive session. The tool has been disabled for this session. Do not retry — proceed without user input (make a defensible decision and state it) or wait for the user to reconnect.",
						},
					],
					isError: true,
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 3. Signal abort 入口检查（spec FR-10）
			if (signal?.aborted) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled. Do not assume an answer or continue the task — wait for new instructions or re-ask with refined options if the decision is still required.",
						},
					],
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 4. 顶层 try/catch（spec FR-13）
			let result: Result | null;
			try {
				result = await ctx.ui.custom<Result | null>(
					(tui: unknown, theme: unknown, _kb: unknown, done: (r: Result | null) => void) => {
						const comp = new AskUserComponent(
							questions,
							tui as { requestRender(): void },
							theme as ThemeLike,
							done,
						);
						// signal abort 监听（spec FR-10）：走组件 cancel() 复用 _resolved 守卫，
						// 避免用户已 submit/cancel 后 signal 才 abort 二次调 done（FR-12 竞态）
						if (signal) {
							signal.addEventListener("abort", () => comp.cancel(), { once: true });
						}
						return comp;
					},
					// 不传 options → inline 渲染（spec FR-3）
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `ask_user failed: ${message}. Treat as cancelled — do not assume an answer; retry the call with corrected parameters, or proceed with a defensible decision if the user cannot be reached.`,
						},
					],
					isError: true,
					details: { error: message } satisfies ErrorDetails,
				};
			}

			// 5. 取消（null / cancelled）
			if (result === null || result.cancelled) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled. Do not assume an answer or continue the task — wait for new instructions or re-ask with refined options if the decision is still required.",
						},
					],
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 6. 正常返回
			const summary = result.questions.map(
				(q: Question) => `"${q.question}" = "${result!.answers[q.question] ?? "(no answer)"}"`,
			);
			return {
				content: [{ type: "text" as const, text: summary.join("\n") }],
				details: result satisfies Result,
			};
		},

		renderCall(args: Static<typeof InputSchema>, theme: ThemeLike) {
			const questions: Question[] = args.questions ?? [];
			const topics = questions.map((q) => q.header ?? truncateToWidth(q.question, HEADER_MAX_CHARS)).join(", ");
			return new TruncatedText(
				theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", topics),
				0,
				0,
			);
		},

		renderResult(
			result: AgentToolResult<AskUserDetails>,
			options: ToolRenderResultOptions,
			theme: ThemeLike,
		) {
			const details = result.details;
			if (details && "error" in details && details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			// details 现已排除 ErrorDetails 分支，收窄为 Result | undefined
			const d = details as Result | undefined;
			if (!d || d.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const box = new Box(0, 0);
			for (const q of d.questions) {
				const header = q.header ?? truncateToWidth(q.question, HEADER_MAX_CHARS);
				const answer = d.answers[q.question] ?? "(no answer)";
				box.addChild(
					new TruncatedText(
						theme.fg("success", "✓ ") +
							theme.fg("accent", `${header}: `) +
							theme.fg("text", answer),
						0,
						0,
					),
				);
				// options.expanded：展开显示该问题全部选项 + ●/○ 选中标记 + 评论（spec FR-9）
				if (options?.expanded) {
					for (const child of renderExpandedOptions(q, answer, theme)) box.addChild(child);
				}
			}
			return box;
		},
	});
}
