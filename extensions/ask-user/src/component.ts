// src/component.ts
import { type Component, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

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
	private editorText: string = "";

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
			for (const line of renderQuestionView(q, state, t, innerWidth, this.isSingle, this.editorText)) {
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

		// Esc → 回退到上一个问题；在首个问题时进入确认取消覆盖层
		if (matchesKey(data, "escape")) {
			this.escBackOrConfirm();
			return;
		}

		// ← / → 切换问题 tab（多问题，options 模式）：末尾 → 进入 Submit tab，
		// 首个 ← 停在首个问题（不环绕）。Tab/Shift+Tab 不在问题 tab 切 tab——
		// 留给 Submit tab 上的 Submit/Cancel 焦点切换。
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

		// Other row → Enter opens freeform editor（单选/多选统一入口）。
		//   单选/多选普通选项的 Enter 各自有不同语义（确认/加入选中），与 Other 互斥：
		//   onOther 时本分支先消费 Enter，下面多选/单选分支不再处理。
		if (onOther && matchesKey(data, "enter")) {
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
			if (matchesKey(data, "enter")) {
				// Enter 先把光标所在的普通选项加入选中再确认，与单选分支（Enter 时
				// selectedIndex = cursorIndex）保持一致。即使 freeTextValue 已存在
				// （Other 录入），也尊重「在此选项上按 Enter 想选中它」的意图，避免
				// 静默用旧 Other 文本确认。add 幂等，不会误取消已选项。
				state.selectedIndices.add(state.cursorIndex);
				this.afterConfirm(state, q);
				return;
			}
		} else if (!q.multiSelect && !onOther) {
			if (matchesKey(data, "enter")) {
				// FR-14（答案回改）：不检查 confirmed —— 用户回退到已答 tab 重新
				// Enter 即覆盖旧答案。freeTextValue 同步清空，防 Other 残留。
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
		if (matchesKey(data, "escape")) {
			if (state.mode === "comment") {
				// AC-17: Esc in comment = skip comment, advance (keep existing commentValue)
				state.mode = "options";
				this.editorText = "";
				this.advance();
				return;
			}
			// Esc in freeform editor = back to options (discard input)
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
					state.mode = "options";
					this.editorText = "";
					// freeform 保存后走 afterConfirm（可能进 comment 模式）
					this.afterConfirm(state, q);
				} else {
					// FR-6: 空 Enter 仅清除 freeTextValue、关闭编辑器回选项列表，不含确认语义（不置 confirmed）
					state.freeTextValue = null;
					state.mode = "options";
					this.editorText = "";
					// 对齐 toggleIndex 守卫：清空后若全无答案，重置 confirmed，维持 confirmed ⟹ 有答案 不变式
					if ((q.multiSelect ? state.selectedIndices.size === 0 : state.selectedIndex === null) && state.freeTextValue === null) {
						state.confirmed = false;
					}
					this.invalidate();
					this.tui.requestRender();
				}
				return;
			}
			// comment mode：保存评论后直接前进（不再回头进 comment）
			state.commentValue = text || null;
			state.mode = "options";
			this.editorText = "";
			this.advance();
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
			// 进入评论输入行。预填已有评论，空 Enter=清除、新文本=覆盖（FR-4 item6）。
			// 允许回改时重新编辑/清除已输入评论，避免评论被错误附着到后改的答案。
			state.mode = "comment";
			this.editorText = state.commentValue ?? "";
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
