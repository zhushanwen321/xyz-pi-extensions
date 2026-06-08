/**
 * Render helpers for coding-workflow tool call/result rendering.
 * Extracted from tool-handlers.ts to keep file sizes under control.
 */

import { Text } from "@mariozechner/pi-tui";

import { type PhaseConfig,RESULT_PREVIEW_LINES } from "./helpers.js";

// ─── Types ────────────────────────────────────────────────

export interface RenderArgs {
	phase?: number;
	slug?: string;
}

export interface ThemeLike {
	fg(token: string, text: string): string;
	bold(text: string): string;
}

export interface RenderResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

// ─── Render functions ────────────────────────────────────

export function renderGateCall(args: RenderArgs, theme: ThemeLike, topicDir: string, phases: PhaseConfig[]): Text {
	const phaseConfig = phases[(args.phase ?? 0) - 1];
	return new Text(
		theme.fg("toolTitle", theme.bold("coding-workflow-gate ")) +
		theme.fg("accent", `Phase ${args.phase} (${phaseConfig?.name ?? "?"})`) +
		theme.fg("muted", ` ${topicDir || ""}`),
		0, 0,
	);
}

export function renderToolResult(result: RenderResultLike, theme: ThemeLike): Text {
	const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
	const icon = result.isError
		? theme.fg("error", "✗")
		: theme.fg("success", "✓");
	const preview = text.split("\n").slice(0, RESULT_PREVIEW_LINES).join("\n");
	return new Text(`${icon} ${preview}`, 0, 0);
}

export function renderInitCall(args: RenderArgs, theme: ThemeLike): Text {
	return new Text(
		theme.fg("toolTitle", theme.bold("coding-workflow-init ")) +
		theme.fg("accent", String(args.slug ?? "?")),
		0, 0,
	);
}

export function renderInitResult(result: RenderResultLike, theme: ThemeLike): Text {
	const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
	const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	return new Text(`${icon} ${text.split("\n")[0]}`, 0, 0);
}

export function renderPhaseStartCall(currentPhase: number, theme: ThemeLike): Text {
	return new Text(
		theme.fg("toolTitle", theme.bold("coding-workflow-phase-start ")) +
		theme.fg("accent", `Phase ${currentPhase} → ${currentPhase + 1}`),
		0, 0,
	);
}
