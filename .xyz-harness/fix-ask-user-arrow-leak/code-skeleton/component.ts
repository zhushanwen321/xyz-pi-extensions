// code-skeleton/component.ts
// [SKELETON] component.ts 骨架 — 验证 parseKey 拦截（#1）+ handleInput 拆分（#3）+ draftText 迁移（#2）
// 的签名/调用链/依赖方向。方法体按 Level 1 接线规则（只接调用+透传+分支路由，不写实现细节）。
//
// [KEY DECISION D-005] parseKey 复用 SDK（@mariozechner/pi-tui），不自建 parse-key.ts。
//
// [parseKey 返回语义 — 关键修正 issues.md 方案A 描述]
// parseKey(data) 返回值三态，决定 handleEditorInput 路由：
//   1. 命中编辑器语义键："escape" / "enter" / "backspace" → 各自专门分支
//   2. 单字符 ASCII printable（code 32-126，如 "a"/"X"/"5"）→ 返回该字符本身（非 undefined）
//      → 追加该字符到 state.draftText
//   3. 其他 special key（"up"/"down"/"f1"..."alt+x"/"ctrl+shift+right" 等）→ no-op（不泄漏）
//   4. undefined（多字符粘贴 chunk / bracketed paste 序列）→ printable 提取分支
//      （剥离 bracketed paste 标记 + code point 迭代 + c >= " " 过滤，BC-1/BC-2/BC-3）
//
// 注意：issues.md #1 方案A 原文「parseKey 返回非 undefined 即 no-op」对单字符 printable 不成立
// （parseKey("a") 返回 "a"）。骨架在此修正：keyId 是单字符 printable 时追加，非 no-op。
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

	// [REMOVED #2] private editorText: string — 迁移到 QuestionState.draftText（每问题独立）
	// AC-2 反模式检查：grep "private editorText\|this\.editorText" 无输出

	/** Submit tab 上的左右焦点：默认 Submit；← / → 切换；Enter 触发当前项。 */
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
		// [接线] renderQuestionView 的 editorText 参数改为从 state.draftText 传入（#2 迁移）
		// 渲染缓存逻辑 + box 边框包裹保持不变（纯移动，非本次改动重点）。
		// 仅验证：renderQuestionView 调用签名匹配（含 state.draftText 透传）。
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}
		const t = this.theme;
		const innerWidth = Math.max(0, width - BORDER_OVERHEAD);
		const inner: string[] = [];
		const add = (s: string): void => { inner.push(s); };

		if (!this.isSingle) {
			this.renderTabBar(innerWidth, add);
			inner.push("");
		}

		if (this.pendingCancel) {
			add(t.fg("warning", t.bold(" Cancel all questions?")));
			inner.push("");
			add(t.fg("text", " Your answers will be discarded."));
			inner.push("");
			add(t.fg("dim", " Esc confirm cancel · any other key to stay"));
		} else if (this.activeTab >= this.questions.length) {
			for (const line of renderSubmitView(this.questions, this.states, t, innerWidth, this.submitTabFocus)) add(line);
		} else {
			const q = this.questions[this.activeTab]!;
			const state = this.states[this.activeTab]!;
			// [#2] editorText 参数透传 state.draftText（替代 this.editorText）
			for (const line of renderQuestionView(q, state, t, innerWidth, this.isSingle, state.draftText)) {
				add(line);
			}
		}

		if (!this.isSingle && this.activeTab < this.questions.length) {
			inner.push("");
			this.renderButtonBar(innerWidth, add, null);
		}

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
		// [接线] 保持不变 — 纯渲染，不涉及 editorText/draftText。
		throw new Error("SKELETON: renderTabBar impl not in scope");
	}

	private renderButtonBar(
		innerWidth: number,
		add: (s: string) => void,
		focus: "submit" | "cancel" | null,
	): void {
		// [接线] 保持不变 — 纯渲染，不涉及 editorText/draftText。
		throw new Error("SKELETON: renderButtonBar impl not in scope");
	}

	// ── 输入路由 ──
	// [#3 拆分] handleInput 降为纯路由（≤40 行）：_resolved 守卫 + pendingCancel + submit tab + mode 分发。
	// options 模式的输入处理抽到 handleOptionsInput（新 private 方法），三 handler 对称。
	handleInput(data: string): void {
		// BC-6: _resolved 守卫（防重入，保持不动）
		if (this._resolved) return;

		// 确认取消覆盖层：Esc 确认取消，任意其他键退出覆盖层（BC-6 保持）
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

		// freeform / comment mode → editor text input（#1 parseKey 拦截在此方法内）
		if (state.mode === "freeform" || state.mode === "comment") {
			this.handleEditorInput(data, state, q);
			return;
		}

		// options mode → [#3 拆分] 委托给 handleOptionsInput
		this.handleOptionsInput(data, state, q);
	}

	/**
	 * [#3 NEW] options 模式的输入处理（从 handleInput 抽出）。
	 * 含：Esc 回退/确认取消、←/→ 切 tab、↑/↓ 移光标、Enter 确认、Space toggle。
	 * 与 handleEditorInput/handleSubmitTabInput 对称（三 handler 对称，D-004）。
	 *
	 * 注意：此方法的 matchesKey 散调保持（不持自由文本 buffer，不泄漏）。
	 * 仅 handleEditorInput 需要 parseKey 白名单（因为它持 draftText buffer）。
	 */
	private handleOptionsInput(data: string, state: QuestionState, q: Question): void {
		// [接线] 迁移自 handleInput 的 options 分支（纯移动，无逻辑变更，AC-3.2 行为等价）。
		// 分支结构：escape → escBackOrConfirm; right/left → gotoTab; up/down → cursorIndex;
		//          onOther+enter → 进 freeform + 分流预填; multiSelect space/enter; single enter.
		throw new Error("SKELETON: handleOptionsInput impl = move from handleInput options branch");
	}

	/**
	 * Submit tab 输入路由（保持不变）。
	 * ←/→ → tab 导航；Tab → Submit↔Cancel 循环切焦点；Enter → 触发当前 focus；Esc → 回退到最后问题。
	 */
	private handleSubmitTabInput(data: string): void {
		// [接线] 保持不变 — matchesKey 散调（Submit tab 不持 buffer，不泄漏）。
		throw new Error("SKELETON: handleSubmitTabInput impl not in scope (unchanged)");
	}

	/**
	 * 编辑器输入处理（freeform/comment 模式）。[#1 parseKey 白名单拦截]
	 *
	 * [parseKey 路由逻辑 — 核心 bug 修复]
	 * 开头 const keyId = parseKey(data)，按返回值三态分发：
	 *   - escape/enter/backspace → 编辑器语义键分支（各自处理，BC-4/BC-4b/BC-4c/BC-5 保持）
	 *   - 单字符 printable（keyId.length === 1 且 code 32-126）→ 追加该字符到 state.draftText
 *     注意：空格 " " parseKey 返回 "space"（非单字符），需特判追加
	 *   - 其他 special key（up/down/f1-f12/home/end/alt+x/ctrl+shift+right 等）→ no-op（不泄漏）
	 *   - keyId === undefined（多字符粘贴 chunk）→ printable 提取分支（BC-1/BC-2/BC-3）
	 *
	 * [draftText 迁移 #2] 所有 this.editorText → state.draftText。
	 * 进入 freeform：state.draftText = state.freeTextValue ?? ""（分流预填，afterConfirm comment 同理）
	 *
	 * @param data  终端原始输入（单键序列或多字符粘贴 chunk）
	 * @param state 当前问题的交互状态（draftText 在此读写）
	 * @param q     当前问题定义
	 */
	private handleEditorInput(data: string, state: QuestionState, q: Question): void {
		// [接线 #1] parseKey 白名单拦截 — 替代旧的 matchesKey 散调 + 兜底 printable 遍历
		const keyId = parseKey(data);

		if (keyId !== undefined) {
			// parseKey 命中（special key / modifier 组合 / 单字符 printable）
			if (matchesKey(data, "escape")) {
				// [接线] escape 分支：comment→skip advance（BC-5 保留 commentValue）；freeform→discard 回 options
				// state.draftText = ""（替代 this.editorText = ""）
				// 分支：mode === comment → this.advance(); mode === freeform → this.invalidate()+requestRender()
				// 两分支前均置 state.mode = "options" + state.draftText = ""
				state.draftText = "";
				throw new Error("SKELETON: escape branch impl (BC-5 comment advance / freeform discard)");
			}
			if (matchesKey(data, "enter")) {
				// [接线] enter 分支：BC-4(freeform 空 Enter 清 freeTextValue+重置 confirmed)
				// / BC-4b(freeform 有文本 Enter 清 selectedIndex=null) / BC-4c(comment 进预填) / comment 保存
				// 全部 state.draftText 读写替代 this.editorText
				throw new Error("SKELETON: enter branch impl (BC-4/BC-4b/BC-4c/comment save)");
			}
			if (matchesKey(data, "backspace")) {
				// [接线] state.draftText = state.draftText.slice(0, -1); invalidate+render
				state.draftText = state.draftText.slice(0, -1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// [接线 #1 核心] 单字符 printable：parseKey 返回该字符本身（code 32-126）
			// 追加到 state.draftText（与多字符粘贴的 printable 提取等价，但单字符无需遍历）
			// 特判空格：parseKey(" ") 返回 "space"（非单字符），需显式追加空格
			if (matchesKey(data, "space")) {
				state.draftText += " ";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (keyId.length === 1 && keyId >= " " && keyId <= "~") {
				state.draftText += keyId;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// [接线 #1 核心 no-op] 其他 special key（方向键/功能键/modifier 组合）→ 不泄漏
			// parseKey 已识别为 special，但编辑器 append-only 不响应光标移动 → return
			return;
		}

		// [接线] keyId === undefined → 多字符粘贴 chunk → printable 提取（BC-1/BC-2/BC-3 保持）
		// BC-1: 剥离 bracketed paste 标记 \x1b[200~ / \x1b[201~
		// BC-2: for (const c of cleaned) 按 code point 迭代（emoji 代理对作为一个 c）
		// BC-3: if (c >= " ") 过滤控制字符
		// 全部 += 到 state.draftText（替代 this.editorText）
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
		}
	}

	private toggleIndex(state: QuestionState, index: number): void {
		// [接线] 保持不变 — 操作 selectedIndices，不涉及 draftText。
		throw new Error("SKELETON: toggleIndex impl not in scope");
	}

	private autoConfirmIfAnswered(): void {
		// [接线] 保持不变 — 读 selectedIndex/selectedIndices/freeTextValue 判 confirmed。
		throw new Error("SKELETON: autoConfirmIfAnswered impl not in scope");
	}

	/** 切到目标 tab：离开当前 tab 时 auto-confirm 已答问题，刷新视图。 */
	private gotoTab(target: number): void {
		// [接线] 保持不变 — autoConfirmIfAnswered + activeTab=target + invalidate+render。
		this.autoConfirmIfAnswered();
		this.activeTab = target;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Esc 语义：有上一个 tab 则回退；已在首个（或单问题）则进入确认取消覆盖层。 */
	private escBackOrConfirm(): void {
		// [接线] 保持不变。
		throw new Error("SKELETON: escBackOrConfirm impl not in scope");
	}

	/**
	 * 选中确认后的处理：若 allowComment，进入评论模式（可重入编辑/清除已有评论）；否则前进。
	 *
	 * [#2 分流预填] 进 comment 时 state.draftText = state.commentValue ?? ""（BC-4c 保持）。
	 * 禁止 fallback 公式 freeTextValue ?? commentValue ?? ""（D-2，review MF-1 证伪）。
	 */
	private afterConfirm(state: QuestionState, q: Question): void {
		state.confirmed = true;
		if (q.allowComment && state.mode !== "comment") {
			// [#2] 进 comment 编辑器：分流预填 commentValue（替代 this.editorText = state.commentValue ?? ""）
			state.mode = "comment";
			state.draftText = state.commentValue ?? "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.advance();
	}

	private advance(): void {
		// [接线] 保持不变 — 单问题 submit / 多问题 activeTab++ / 到 Submit tab。
		throw new Error("SKELETON: advance impl not in scope");
	}

	private submit(): void {
		this._resolved = true;
		this.done(buildResult(this.questions, this.states));
	}

	/** 取消。public 供 signal abort 监听器复用 _resolved 守卫（FR-12 竞态）。 */
	cancel(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done(null);
	}
}
