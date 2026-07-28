/**
 * W8: RuleEditorComponent — TUI overlay for CRUD rule editing.
 *
 * 3-stage state machine（list/add/fill），Container override handleInput 委托。
 * G1：list → add → fill（无 delete-confirm，fill edit 模式底部 [Delete this rule]）。
 * G2：currentListRules = applyOps(initialRules, ops)，实时反映 ops。
 * G4：pattern 用 wildcard（`npm *`），不用正则。
 * G8：build 不生成 id。
 * G9：tool 只列 bash。
 * G13：sessionIdCounter 立即赋值真实 id。
 * WR8：focusIndex 模 5（Custom form 5 项 Tab 循环）。
 */

import { type Component, Container, Input, type SelectItem, SelectList, type SelectListTheme, truncateToWidth } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";

import {
	ALL_TEMPLATES,
	applyOps,
	PRESET_COMMANDS,
	type RuleOp,
	type RuleTemplate,
	type TemplateSelections,
} from "./rule-templates.js";
import type { PermissionAction, Rule } from "./types.js";

// ──────────────────────── DEFAULT_SELECT_THEME ────────────────────────

const THEME: SelectListTheme = {
	selectedPrefix: (t: string): string => "\u25B6 " + t,
	selectedText: (t: string): string => t,
	description: (t: string): string => t,
	scrollInfo: (t: string): string => t,
	noMatch: (t: string): string => t,
};

const MAX_VISIBLE = 12;

// ──────────────────────── TextLines component ────────────────────────

class TextLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {
		// no-op
	}
}

// ──────────────────────── Stage types ────────────────────────

type Stage = "list" | "add" | "fill";

/** fill stage 子类型（按模板分支）。 */
type FillKind =
	| "command-select" // allow-family / ask-before：命令选择 → commitFill
	| "deny-family" // deny-family：命令 → 子命令 → commitFill
	| "allow-subcmd" // allow-subcmd：命令 → Input 子命令 → commitFill
	| "custom"; // custom：5 项 form + Tab 焦点

// ──────────────────────── RuleEditorComponent ────────────────────────

/**
 * TUI overlay 组件：规则 CRUD 编辑器。
 *
 * Container override handleInput（W7 模式）：按 stage 委托给当前子组件。
 * settle 用 _resolved 守卫防二次 done。
 */
export class RuleEditorComponent extends Container {
	private stage: Stage = "list";
	private readonly initialRules: readonly Rule[];
	private readonly sessionIdCounter: () => string;
	private readonly done: (ops: RuleOp[]) => void;
	private readonly theme: SelectListTheme;
	private _resolved = false;

	/** 累积的操作列表（add/edit/delete）。 */
	ops: RuleOp[] = [];

	/** 当前活跃子组件引用（用于 handleInput 委托）。 */
	private currentList: SelectList | null = null;
	private currentInput: Input | null = null;

	/** fill stage 状态。 */
	private fillKind: FillKind = "command-select";
	private fillTemplate: RuleTemplate | null = null;
	private fillEditMode = false;
	private fillEditRuleId: string | null = null;
	private fillSelections: TemplateSelections = {};

	/** deny-family 子阶段：'cmd' = 选命令，'subcmd' = 选子命令。 */
	private denySubStage: "cmd" | "subcmd" = "cmd";

	/** Custom form：5 项焦点索引（WR8：focusIndex 模 5）。 */
	private customFocusIndex = 0;
	private customChildren: Component[] = [];

	constructor(
		initialRules: readonly Rule[],
		sessionIdCounter: () => string,
		done: (ops: RuleOp[]) => void,
		theme: SelectListTheme = THEME,
	) {
		super();
		this.initialRules = initialRules;
		this.sessionIdCounter = sessionIdCounter;
		this.done = done;
		this.theme = theme;
		this.switchToListStage();
	}

	// ──────────────────────── 边框渲染 ────────────────────────

	/** box 边框左右各占用 1 列（│ × 2） */
	private static readonly BORDER_OVERHEAD = 2;

	override render(width: number): string[] {
		const innerWidth = Math.max(0, width - RuleEditorComponent.BORDER_OVERHEAD);
		const inner = super.render(innerWidth);
		const lines: string[] = [];
		lines.push(`\u250C${"\u2500".repeat(innerWidth)}\u2510`);
		for (const line of inner) {
			const padded = truncateToWidth(line, innerWidth, "", true);
			lines.push(`\u2502${padded}\u2502`);
		}
		lines.push(`\u2514${"\u2500".repeat(innerWidth)}\u2518`);
		return lines;
	}

	// ──────────────────────── handleInput override（Container 无 handleInput，必须新增） ────────────────────────

	handleInput(data: string): void {
		// Custom form：Tab 焦点路由（WR8）
		if (this.stage === "fill" && this.fillKind === "custom") {
			if (matchesKey(data, "tab")) {
				this.customFocusIndex = (this.customFocusIndex + 1) % 5;
				this.syncCustomFocus();
				this.invalidate();
				return;
			}
			// 委托给当前 focused 子组件
			const child = this.customChildren[this.customFocusIndex];
			if (child !== undefined && child.handleInput !== undefined) {
				child.handleInput(data);
			}
			return;
		}
		// 非 custom form：委托给当前 active 组件
		this.currentList?.handleInput(data);
	}

	/** 退出（外部 abort 用）。 */
	cancel(): void {
		this.settle();
	}

	/** settle：_resolved 守卫 + done(this.ops)。 */
	private settle(): void {
		if (this._resolved) return;
		this._resolved = true;
		this.done(this.ops);
	}

	/** currentListRules = applyOps(initialRules, ops)（G2：实时反映 ops）。 */
	currentListRules(): Rule[] {
		return applyOps([...this.initialRules], this.ops);
	}

	// ──────────────────────── list stage ────────────────────────

	private switchToListStage(): void {
		this.stage = "list";
		this.clear();
		this.currentInput = null;
		this.currentList = this.buildListStage();
		this.addChild(new TextLines(["[pi-permission] Permission Rules", ""]));
		this.addChild(this.currentList);
	}

	private buildListStage(): SelectList {
		const rules = this.currentListRules();
		const items: SelectItem[] = [];

		for (const rule of rules) {
			const desc = rule.description ?? rule.pattern;
			items.push({
				value: `rule:${rule.id}`,
				label: `[${rule.action}] ${rule.pattern}`,
				description: desc,
			});
		}

		items.push({ value: "__add__", label: "[+ Add rule]", description: "Add a new permission rule" });
		items.push({ value: "__done__", label: "[Done]", description: "Save and exit" });

		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__add__") {
				this.switchToAddStage();
				return;
			}
			if (item.value === "__done__") {
				this.settle();
				return;
			}
			// 进入 edit 模式
			const ruleId = item.value.replace(/^rule:/, "");
			this.enterFillEditMode(ruleId);
		};
		list.onCancel = (): void => {
			this.settle();
		};
		return list;
	}

	// ──────────────────────── add stage ────────────────────────

	private switchToAddStage(): void {
		this.stage = "add";
		this.clear();
		this.currentInput = null;
		const items: SelectItem[] = ALL_TEMPLATES.map((t) => ({
			value: t.id,
			label: t.label,
			description: t.description,
		}));
		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			const template = ALL_TEMPLATES.find((t) => t.id === item.value);
			if (template !== undefined) {
				this.enterFillNewMode(template);
			}
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};
		this.currentList = list;
		this.addChild(new TextLines(["[pi-permission] Add Rule — Select Template", ""]));
		this.addChild(list);
	}

	// ──────────────────────── fill stage ────────────────────────

	private enterFillNewMode(template: RuleTemplate): void {
		this.fillTemplate = template;
		this.fillEditMode = false;
		this.fillEditRuleId = null;
		this.fillSelections = {};
		this.startFillForTemplate(template);
	}

	private enterFillEditMode(ruleId: string): void {
		const rules = this.currentListRules();
		const rule = rules.find((r) => r.id === ruleId);
		if (rule === undefined) {
			this.switchToListStage();
			return;
		}
		this.fillEditMode = true;
		this.fillEditRuleId = ruleId;
		this.fillSelections = {
			cmd: extractCmd(rule.pattern),
			subcmd: extractSubcmd(rule.pattern),
			pattern: rule.pattern,
			action: rule.action,
			tool: rule.tool,
			description: rule.description,
		};
		// edit 模式走 custom form（用户可编辑所有字段）
		this.startFillCustom();
	}

	private startFillForTemplate(template: RuleTemplate): void {
		switch (template.id) {
			case "allow-family":
			case "ask-before":
				this.startFillCommandSelect("command-select");
				break;
			case "deny-family":
				this.denySubStage = "cmd";
				this.startFillDenyFamily();
				break;
			case "allow-subcmd":
				this.startFillAllowSubcmd();
				break;
			case "custom":
				this.startFillCustom();
				break;
			default:
				this.switchToListStage();
		}
	}

	// ── command-select（allow-family / ask-before）──

	private startFillCommandSelect(kind: FillKind): void {
		this.stage = "fill";
		this.fillKind = kind;
		this.clear();
		this.currentInput = null;

		const items = this.buildPresetCommandItems();
		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__other__") {
				this.startCommandInput();
				return;
			}
			this.fillSelections.cmd = item.value;
			this.commitFill();
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};
		this.currentList = list;
		this.addChild(new TextLines(["[pi-permission] Select command (or Other for custom)", ""]));
		this.addChild(list);
	}

	// ── deny-family（命令 → 子命令）──

	private startFillDenyFamily(): void {
		this.stage = "fill";
		this.fillKind = "deny-family";
		this.clear();
		this.currentInput = null;

		if (this.denySubStage === "cmd") {
			const items = this.buildPresetCommandItems();
			const list = new SelectList(items, MAX_VISIBLE, this.theme);
			list.onSelect = (item: SelectItem): void => {
				if (item.value === "__other__") {
					this.startCommandInput("deny-cmd");
					return;
				}
				this.fillSelections.cmd = item.value;
				this.denySubStage = "subcmd";
				this.startFillDenyFamily();
			};
			list.onCancel = (): void => {
				this.switchToListStage();
			};
			this.currentList = list;
			this.addChild(new TextLines(["[pi-permission] Deny — Select command", ""]));
			this.addChild(list);
		} else {
			// subcmd 阶段
			const items: SelectItem[] = [
				{ value: "__any__", label: "[Any subcommand]", description: "Deny all subcommands of this command" },
				{ value: "__specific__", label: "[Specific subcommand]", description: "Deny a specific subcommand" },
			];
			const list = new SelectList(items, MAX_VISIBLE, this.theme);
			list.onSelect = (item: SelectItem): void => {
				if (item.value === "__any__") {
					this.fillSelections.subcmd = "__any__";
					this.commitFill();
					return;
				}
				// specific → Input
				this.startSubcmdInput();
			};
			list.onCancel = (): void => {
				// 回到 cmd 选择
				this.denySubStage = "cmd";
				this.startFillDenyFamily();
			};
			this.currentList = list;
			this.addChild(new TextLines([`[pi-permission] Deny ${this.fillSelections.cmd ?? "?"} — Select scope`, ""]));
			this.addChild(list);
		}
	}

	// ── allow-subcmd（命令 → Input 子命令）──

	private startFillAllowSubcmd(): void {
		this.stage = "fill";
		this.fillKind = "allow-subcmd";
		this.clear();
		this.currentInput = null;

		const items = this.buildPresetCommandItems();
		const list = new SelectList(items, MAX_VISIBLE, this.theme);
		list.onSelect = (item: SelectItem): void => {
			if (item.value === "__other__") {
				this.startCommandInput("allow-subcmd-cmd");
				return;
			}
			this.fillSelections.cmd = item.value;
			this.startSubcmdInput();
		};
		list.onCancel = (): void => {
			this.switchToListStage();
		};
		this.currentList = list;
		this.addChild(new TextLines(["[pi-permission] Allow subcommand — Select command", ""]));
		this.addChild(list);
	}

	// ── custom form（5 项 Tab 焦点，WR8）──

	private startFillCustom(): void {
		this.stage = "fill";
		this.fillKind = "custom";
		this.clear();
		this.currentList = null;
		this.customFocusIndex = 0;
		this.customChildren = [];

		// 1. pattern Input
		const patternInput = new Input();
		patternInput.setValue(this.fillSelections.pattern ?? "");
		patternInput.onSubmit = (val: string): void => {
			this.fillSelections.pattern = val;
		};
		patternInput.onEscape = (): void => {
			this.switchToListStage();
		};

		// 2. action SelectList
		const actionItems: SelectItem[] = [
			{ value: "allow", label: "allow" },
			{ value: "deny", label: "deny" },
			{ value: "ask", label: "ask" },
		];
		const actionList = new SelectList(actionItems, 3, this.theme);
		actionList.onSelect = (item: SelectItem): void => {
			this.fillSelections.action = item.value as PermissionAction;
		};
		actionList.onCancel = (): void => {
			this.switchToListStage();
		};
		// 预选当前 action
		if (this.fillSelections.action !== undefined) {
			const idx = actionItems.findIndex((a) => a.value === this.fillSelections.action);
			if (idx >= 0) actionList.setSelectedIndex(idx);
		}

		// 3. tool SelectList（G9：只列 bash）
		const toolItems: SelectItem[] = [{ value: "bash", label: "bash" }];
		const toolList = new SelectList(toolItems, 1, this.theme);
		toolList.onSelect = (item: SelectItem): void => {
			this.fillSelections.tool = item.value;
		};

		// 4. description Input
		const descInput = new Input();
		descInput.setValue(this.fillSelections.description ?? "");
		descInput.onSubmit = (val: string): void => {
			this.fillSelections.description = val || undefined;
		};

		// 5. Submit SelectList
		const submitItems: SelectItem[] = [
			{ value: "__submit__", label: "[Submit]" },
			{ value: "__cancel__", label: "[Cancel]" },
		];
		const submitList = new SelectList(submitItems, 2, this.theme);
		submitList.onSelect = (item: SelectItem): void => {
			if (item.value === "__submit__") {
				this.commitFill();
			} else {
				this.switchToListStage();
			}
		};

		this.customChildren = [patternInput, actionList, toolList, descInput, submitList];

		// 组装 UI
		const title = this.fillEditMode ? "Edit Rule (Tab to switch fields)" : "Custom Rule (Tab to switch fields)";
		this.addChild(new TextLines([`[pi-permission] ${title}`, ""]));
		this.addChild(new TextLines(["Pattern (wildcard, e.g. 'npm *')"]));
		this.addChild(patternInput);
		this.addChild(new TextLines(["Action"]));
		this.addChild(actionList);
		this.addChild(new TextLines(["Tool"]));
		this.addChild(toolList);
		this.addChild(new TextLines(["Description (optional)"]));
		this.addChild(descInput);
		this.addChild(new TextLines([""]));
		this.addChild(submitList);

		// edit 模式：底部加 [Delete this rule]
		if (this.fillEditMode && this.fillEditRuleId !== null) {
			const deleteItems: SelectItem[] = [{ value: "__delete__", label: "[Delete this rule]" }];
			const deleteList = new SelectList(deleteItems, 1, this.theme);
			deleteList.onSelect = (): void => {
				this.ops.push({ kind: "delete", id: this.fillEditRuleId! });
				this.switchToListStage();
			};
			this.addChild(new TextLines([""]));
			this.addChild(deleteList);
		}

		this.syncCustomFocus();
	}

	// ── command Input（Other → 手动输入命令名）──

	private startCommandInput(returnTo?: string): void {
		this.clear();
		this.currentList = null;
		const input = new Input();
		if ("focused" in input) (input as unknown as { focused: boolean }).focused = true;
		input.onSubmit = (val: string): void => {
			const cmd = val.trim();
			if (cmd.length > 0) {
				this.fillSelections.cmd = cmd;
				if (returnTo === "deny-cmd") {
					this.denySubStage = "subcmd";
					this.startFillDenyFamily();
				} else if (returnTo === "allow-subcmd-cmd") {
					this.startSubcmdInput();
				} else {
					this.commitFill();
				}
			}
		};
		input.onEscape = (): void => {
			this.switchToListStage();
		};
		this.currentInput = input;
		this.addChild(new TextLines(["[pi-permission] Enter command name", ""]));
		this.addChild(input);
	}

	// ── subcmd Input ──

	private startSubcmdInput(): void {
		this.clear();
		this.currentList = null;
		const input = new Input();
		if ("focused" in input) (input as unknown as { focused: boolean }).focused = true;
		input.onSubmit = (val: string): void => {
			const subcmd = val.trim();
			if (subcmd.length > 0) {
				this.fillSelections.subcmd = subcmd;
				this.commitFill();
			}
		};
		input.onEscape = (): void => {
			this.switchToListStage();
		};
		this.currentInput = input;
		this.addChild(new TextLines(["[pi-permission] Enter subcommand name", ""]));
		this.addChild(input);
	}

	// ──────────────────────── commitFill ────────────────────────

	/** 提交当前 fill 结果：build rule + 赋 id + push op。 */
	private commitFill(): void {
		if (this.fillTemplate === null) {
			this.switchToListStage();
			return;
		}

		const built = this.fillTemplate.build(this.fillSelections);
		const ruleId = this.sessionIdCounter(); // G13：立即赋值
		const rule: Rule = {
			id: ruleId,
			...built,
		};

		if (this.fillEditMode && this.fillEditRuleId !== null) {
			// edit 模式：用原 id
			rule.id = this.fillEditRuleId;
			this.ops.push({ kind: "edit", id: this.fillEditRuleId, rule });
		} else {
			this.ops.push({ kind: "add", rule });
		}

		this.switchToListStage();
	}

	// ──────────────────────── 辅助 ────────────────────────

	/** 构建 PRESET_COMMANDS + Other 的 SelectItem[]。 */
	private buildPresetCommandItems(): SelectItem[] {
		const items: SelectItem[] = PRESET_COMMANDS.map((cmd) => ({
			value: cmd.cmd,
			label: cmd.label,
			description: cmd.category,
		}));
		items.push({ value: "__other__", label: "[Other]", description: "Enter a custom command name" });
		return items;
	}

	/** 同步 Custom form 焦点标志（Input.focused + rerender）。 */
	private syncCustomFocus(): void {
		for (let i = 0; i < this.customChildren.length; i++) {
			const child = this.customChildren[i];
			if (child !== undefined && "focused" in child) {
				(child as unknown as { focused: boolean }).focused = i === this.customFocusIndex;
			}
		}
	}
}

// ──────────────────────── pattern 解析辅助 ────────────────────────

/** 从 wildcard pattern 提取 cmd（第一个 token）。 */
function extractCmd(pattern: string): string | undefined {
	const match = /^([^ *?]+)(?:\s|$)/.exec(pattern);
	return match !== null ? match[1] : undefined;
}

/** 从 wildcard pattern 提取 subcmd（第二个 token，如有）。 */
function extractSubcmd(pattern: string): string | undefined {
	const match = /^[^ *?]+ ([^ *?]+)(?:\s|$)/.exec(pattern);
	return match !== null ? match[1] : undefined;
}
