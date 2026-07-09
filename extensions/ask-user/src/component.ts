// src/component.ts
import { type Component, matchesKey, parseKey, truncateToWidth } from "@mariozechner/pi-tui";

import { allOptions, renderQuestionView } from "./question-view";
import { buildResult, renderSubmitView } from "./submit-view";
import {
	createQuestionState,
	HEADER_MAX_CHARS,
	type Question,
	type QuestionState,
	type Result,
	type ThemeLike,
} from "./types";

// ── 组件私有类型（不跨模块共享，无需放 types.ts） ──

/** 最小 TUI 接口（满足真实 TUI 和测试 stub） */
export interface TUILike {
	requestRender(): void;
}

/** box 边框左右各占用 1 列（`│` × 2） */
const BORDER_OVERHEAD = 2;

// ── AskUserComponent ─────────────────────────────────

export class AskUserComponent implements Component {
	private questions: Question[];
	private theme: ThemeLike;
	private tui: TUILike;
	private done: (result: Result | null) => void;

	private states: QuestionState[];
	private activeTab: number = 0;

	/** Submit tab 上的左右焦点：默认 Submit；← / → 切换；Enter 触发当前项。
	 *  问题 tab 上无意义（仅视觉占位），不参与输入路由。 */
	private submitTabFocus: "submit" | "cancel" = "submit";

	/** Esc 在首个问题时进入「确认取消」覆盖层；Esc 再次确认取消，任意键退出覆盖层。 */
	private pendingCancel: boolean = false;

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
		this.states = questions.map(() => createQuestionState());
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
		// box 边框占用左右各 1 列；子视图在 innerWidth 下渲染
		const innerWidth = Math.max(0, width - BORDER_OVERHEAD);

		const inner: string[] = [];
		const add = (s: string): void => {
			inner.push(s);
		};

		if (!this.isSingle) {
			this.renderTabBar(innerWidth, add);
			inner.push("");
		}

		if (this.pendingCancel) {
			// 确认取消覆盖层：替代当前 tab 内容
			add(t.fg("warning", t.bold(" Cancel all questions?")));
			inner.push("");
			add(t.fg("text", " Your answers will be discarded."));
			inner.push("");
			add(t.fg("dim", " Esc confirm cancel · any other key to stay"));
		} else if (this.activeTab >= this.questions.length) {
			// Submit tab
			for (const line of renderSubmitView(this.questions, this.states, t, innerWidth, this.submitTabFocus)) add(line);
		} else {
			const q = this.questions[this.activeTab]!;
			const state = this.states[this.activeTab]!;
			for (const line of renderQuestionView(q, state, t, innerWidth, this.isSingle, state.draftText)) {
				add(line);
			}
		}

		// 多问题：底部按钮栏（Submit / Cancel）。Submit tab 上不重复渲染（renderSubmitView 内嵌 focus 高亮）
		if (!this.isSingle && this.activeTab < this.questions.length) {
			inner.push("");
			this.renderButtonBar(innerWidth, add, null);
		}

		// 用 box 边框包裹：每行 pad 到 innerWidth 后加 │ 左右边框
		const lines: string[] = [];
		lines.push(t.fg("dim", `┌${"─".repeat(innerWidth)}┐`));
		for (const line of inner) {
			const padded = truncateToWidth(line, innerWidth, "", true);
			lines.push(`${t.fg("dim", "│")}${padded}${t.fg("dim", "│")}`);
		}
		lines.push(t.fg("dim", `└${"─".repeat(innerWidth)}┘`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderTabBar(innerWidth: number, add: (s: string) => void): void {
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
				parts.push(t.fg("success", ` ✓${header} `));
			} else {
				parts.push(t.fg("muted", ` □${header} `));
			}
			// tab 之间竖线分割（最后一个 question tab 后由 Submit 分支补）
			parts.push(t.fg("dim", "│"));
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
		add(truncateToWidth(parts.join(""), innerWidth));
	}

	/**
	 * 底部按钮栏：[ Submit ]   [ Cancel ]。
	 * focus: null=纯展示（问题 tab），"submit"/"cancel"=高亮对应按钮（Submit tab）。
	 */
	private renderButtonBar(
		innerWidth: number,
		add: (s: string) => void,
		focus: "submit" | "cancel" | null,
	): void {
		const t = this.theme;
		const allDone = this.allConfirmed();
		const isSubmit = focus === "submit";
		const isCancel = focus === "cancel";
		const submit = isSubmit
			? (allDone ? t.fg("success", t.bold(" Submit ")) : t.fg("accent", t.bold(" Submit ")))
			: (allDone ? t.fg("success", " Submit ") : t.fg("dim", " Submit "));
		const cancel = isCancel
			? t.fg("accent", t.bold(" Cancel "))
			: t.fg("muted", " Cancel ");
		add(`${t.fg("dim", "[")}${submit}${t.fg("dim", "]")}   ${t.fg("dim", "[")}${cancel}${t.fg("dim", "]")}`);
	}

	// ── 输入路由 ──
	handleInput(data: string): void {
		if (this._resolved) return;

		// 确认取消覆盖层：Esc 确认取消，任意其他键退出覆盖层（留在表单）
		if (this.pendingCancel) {
			if (matchesKey(data, "escape")) {
				this.cancel();
			} else {
				this.pendingCancel = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

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

		// options mode → delegate to handleOptionsInput
		this.handleOptionsInput(data, state, q);
	}

	/**
	 * options 模式的输入处理（从 handleInput 拆出）。
	 * 含：Esc 回退/确认取消、←/→ 切 tab、↑/↓ 移光标、Enter 确认、Space toggle。
	 */
	private handleOptionsInput(data: string, state: QuestionState, q: Question): void {
		// Esc → 回退到上一个问题；在首个问题时进入确认取消覆盖层
		if (matchesKey(data, "escape")) {
			this.escBackOrConfirm();
			return;
		}

		// ← / → 切换问题 tab（多问题，options 模式）
		if (!this.isSingle && matchesKey(data, "right")) {
			this.gotoTab(Math.min(this.activeTab + 1, this.questions.length));
			return;
		}
		if (!this.isSingle && matchesKey(data, "left")) {
			this.gotoTab(Math.max(this.activeTab - 1, 0));
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

		// Other row → Enter opens freeform editor
		if (onOther && matchesKey(data, "enter")) {
			state.mode = "freeform";
			state.draftText = state.freeTextValue ?? "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (q.multiSelect && !onOther) {
			if (matchesKey(data, "space")) {
				this.toggleIndex(state, state.cursorIndex);
				return;
			}
			if (matchesKey(data, "enter")) {
				state.selectedIndices.add(state.cursorIndex);
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

	/**
	 * Submit tab 输入路由（键位语义与问题 tab 全局一致）：
	 * - ← / → → tab 导航（← 回到最后一个问题；→ 环绕到首个问题）
	 * - Tab → 在 Submit ↔ Cancel 间循环切焦点（单键双向，不依赖 shift+tab，
	 *   规避 Pi 全局 app.thinking.cycle 对 shift+tab 的拦截）
	 * - Enter → 触发当前 focus 项：Submit=allConfirmed 才提交；Cancel=直接取消
	 * - Esc → 回退到最后一个问题（与问题 tab 的 Esc-back 语义一致）
	 */
	private handleSubmitTabInput(data: string): void {
		// ← / → → tab 导航（与问题 tab 一致：方向键管 tab 间移动）
		if (matchesKey(data, "left")) {
			this.gotoTab(this.questions.length - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.gotoTab(0);
			return;
		}
		// Esc → 回退到最后一个问题
		if (matchesKey(data, "escape")) {
			this.activeTab = this.questions.length - 1;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		// Tab → Submit ↔ Cancel 循环切焦点（单键双向）
		if (matchesKey(data, "tab")) {
			this.submitTabFocus = this.submitTabFocus === "submit" ? "cancel" : "submit";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		// Enter → 触发当前 focus
		if (matchesKey(data, "enter")) {
			if (this.submitTabFocus === "submit") {
				if (this.allConfirmed()) this.submit();
			} else {
				// Cancel on Submit tab：无需二次确认（已经在最"终点"），直接 cancel()
				this.cancel();
			}
			return;
		}
	}

	private handleEditorInput(data: string, state: QuestionState, q: Question): void {
		// parseKey 白名单拦截 — 替代旧的 matchesKey 散调 + 兜底 printable 遍历
		const keyId = parseKey(data);

		if (keyId !== undefined) {
			// parseKey 命中（special key / modifier 组合 / 单字符 printable）
			if (matchesKey(data, "escape")) {
				if (state.mode === "comment") {
					// comment Esc: skip comment, advance (keep existing commentValue)
					state.mode = "options";
					state.draftText = "";
					this.advance();
					return;
				}
				// freeform Esc: save draft to freeTextValue so it persists across tab switches
				state.freeTextValue = state.draftText || null;
				state.mode = "options";
				state.draftText = "";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter")) {
				const text = state.draftText.trim();
				if (state.mode === "freeform") {
					if (text) {
						state.freeTextValue = text;
						state.selectedIndex = null;
						state.mode = "options";
						state.draftText = "";
						this.afterConfirm(state, q);
					} else {
						state.freeTextValue = null;
						state.mode = "options";
						state.draftText = "";
						if ((q.multiSelect ? state.selectedIndices.size === 0 : state.selectedIndex === null) && state.freeTextValue === null) {
							state.confirmed = false;
						}
						this.invalidate();
						this.tui.requestRender();
					}
					return;
				}
				state.commentValue = text || null;
				state.mode = "options";
				state.draftText = "";
				this.advance();
				return;
			}
			if (matchesKey(data, "backspace")) {
				state.draftText = state.draftText.slice(0, -1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// 空格特判：parseKey(" ") 返回 "space"（非单字符），需显式追加
			if (matchesKey(data, "space")) {
				state.draftText += " ";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// 单字符 printable：parseKey("a") 返回 "a"（code 32-126），追加
			if (keyId.length === 1 && keyId >= " " && keyId <= "~") {
				state.draftText += keyId;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// 其他 special key（方向键/功能键/modifier 组合）→ no-op（不泄漏）
			return;
		}

		// keyId === undefined → 多字符粘贴 chunk → printable 提取（BC-1/BC-2/BC-3 保持）
		const cleaned = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
		let changed = false;
		for (const c of cleaned) {
			if (c >= " ") {
				state.draftText += c;
				changed = true;
			}
		}
		if (changed) {
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
		const hasAnswer = q.multiSelect
			? state.selectedIndices.size > 0 || state.freeTextValue !== null
			: state.freeTextValue !== null || state.selectedIndex !== null;
		if (hasAnswer) state.confirmed = true;
	}

	/** 切到目标 tab：离开当前 tab 时 auto-confirm 已答问题，刷新视图。 */
	private gotoTab(target: number): void {
		this.autoConfirmIfAnswered();
		this.activeTab = target;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Esc 语义：有上一个 tab 则回退；已在首个（或单问题）则进入确认取消覆盖层。 */
	private escBackOrConfirm(): void {
		if (this.activeTab > 0) {
			this.activeTab--;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.pendingCancel = true;
		this.invalidate();
		this.tui.requestRender();
	}

	/** 选中确认后的处理：若 allowComment，进入评论模式（可重入编辑/清除已有评论）；否则前进。 */
	private afterConfirm(state: QuestionState, q: Question): void {
		state.confirmed = true;
		if (q.allowComment && state.mode !== "comment") {
			state.mode = "comment";
			state.draftText = state.commentValue ?? "";
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

	/** 取消。public 供 signal abort 监听器复用 _resolved 守卫（FR-12 竞态）。
	 *  守卫在方法内：signal abort 可能在用户已 submit/cancel 后才触发，
	 *  此时必须 no-op，避免二次调 done（FR-12）。 */
	cancel(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done(null);
	}
}
