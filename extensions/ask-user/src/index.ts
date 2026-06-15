// src/index.ts
import { Box, Text, TruncatedText } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { AskUserComponent } from "./component";
import { type Static } from "typebox";
import { InputSchema, type Question, type Result, type ThemeLike } from "./types";
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

		async execute(
			_toolCallId: string,
			params: Static<typeof InputSchema>,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: {
				hasUI: boolean;
				signal?: AbortSignal;
				ui: {
					custom<T = void>(
						factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
						options?: { overlay?: boolean },
					): Promise<T>;
				};
			},
		) {
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
					content: [{ type: "text" as const, text: "User cancelled" }],
					details: { questions, answers: {}, cancelled: true } satisfies Result,
				};
			}

			// 4. 顶层 try/catch（spec FR-13）
			let result: Result | null;
			try {
				result = await ctx.ui.custom<Result | null>(
					(tui: unknown, theme: unknown, _kb: unknown, done: (r: Result | null) => void) => {
						// signal abort 监听（spec FR-10）
						if (signal) {
							signal.addEventListener("abort", () => done(null), { once: true });
						}
						return new AskUserComponent(
							questions,
							tui as { requestRender(): void },
							theme as unknown as ThemeLike,
							done,
						);
					},
					// 不传 options → inline 渲染（spec FR-3）
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `ask_user failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}

			// 5. 取消（null / cancelled）
			if (result === null || result.cancelled) {
				return {
					content: [{ type: "text" as const, text: "User cancelled" }],
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

		renderCall(args: Record<string, unknown>, theme: ThemeLike) {
			const questions = ((args.questions as Question[] | undefined) ?? []) as Question[];
			const topics = questions.map((q) => q.header ?? q.question.slice(0, 12)).join(", ");
			return new TruncatedText(
				theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", topics),
				0,
				0,
			);
		},

		renderResult(
			result: { details: unknown },
			_options: unknown,
			theme: ThemeLike,
		) {
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
			return box;
		},
	});
}
