/**
 * rule-editor-component.test.ts — W8 T7: RuleEditorComponent 单元测试。
 *
 * 覆盖：
 *  - 构造 + 初始 list stage
 *  - list stage 选择规则 → fill(edit)
 *  - list stage [+ Add] → add stage
 *  - add stage 选模板 → fill stage
 *  - [Done] → settle ops
 *  - _resolved 守卫
 *  - currentListRules 实时反映 ops（G2）
 *  - WR1 handleInput 锁定（Container override 委托）
 *  - Tab 焦点路由（WR8）
 */
import { describe, expect, it, vi } from "vitest";

import { RuleEditorComponent } from "../rule-editor-component.js";
import type { RuleOp } from "../rule-templates.js";
import type { Rule } from "../types.js";

// ──────────────────────── helpers ────────────────────────

function makeRule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: "user-1",
		tool: "bash",
		pattern: "npm *",
		action: "allow",
		source: "user",
		...overrides,
	};
}

/** 构造一个 RuleEditorComponent 并收集 done 结果。 */
function createComp(
	initialRules: Rule[] = [],
	doneFn?: (ops: RuleOp[]) => void,
): { comp: RuleEditorComponent; done: ReturnType<typeof vi.fn>; counter: () => string } {
	let nextId = 1;
	const counter = (): string => `user-${nextId++}`;
	const done = vi.fn(doneFn ?? (() => undefined));
	const comp = new RuleEditorComponent(initialRules, counter, done);
	return { comp, done, counter };
}

// ──────────────────────── 构造 + 初始 list stage ────────────────────────

describe("REC1: 构造 + 初始 list stage", () => {
	it("构造不抛错，render 非空", () => {
		const { comp } = createComp();
		const lines = comp.render(80);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("初始 render 含 'Permission Rules'", () => {
		const { comp } = createComp([makeRule()]);
		expect(comp.render(80).join("\n")).toContain("Permission Rules");
	});

	it("list stage 含已有规则 + [+ Add rule] + [Done]", () => {
		const { comp } = createComp([makeRule({ id: "user-1", pattern: "npm *" })]);
		const text = comp.render(80).join("\n");
		expect(text).toContain("npm *");
		expect(text).toContain("[+ Add rule]");
		expect(text).toContain("[Done]");
	});
});

// ──────────────────────── list stage Enter 行为 ────────────────────────

describe("REC2: list stage Enter 行为", () => {
	it("Enter 选 [+ Add rule] → add stage（render 含 'Select Template'）", () => {
		const { comp } = createComp();
		// 预选在第一条（[+ Add rule]），因为无规则时它是第一项
		// 但有 [Done] 在最后，所以 [+ Add rule] 是 index 0（无规则时）
		comp.handleInput("\r"); // Enter
		const text = comp.render(80).join("\n");
		expect(text).toContain("Select Template");
	});

	it("Enter 选 [Done] → settle 空 ops（无规则时 [Done] 是第二项）", () => {
		const { comp, done } = createComp();
		comp.handleInput("\x1b[B"); // Down → [Done]
		comp.handleInput("\r"); // Enter
		expect(done).toHaveBeenCalledOnce();
		const ops = done.mock.calls[0]![0] as RuleOp[];
		expect(ops).toEqual([]);
	});
});

// ──────────────────────── add stage 选模板 ────────────────────────

describe("REC3: add stage 选模板", () => {
	it("选 allow-family 模板 → fill stage（render 含 'Select command'）", () => {
		const { comp } = createComp();
		// 进 add stage
		comp.handleInput("\r"); // Enter → add stage（[+ Add rule] 预选）
		// add stage 第一条是 allow-family，Enter 选中
		comp.handleInput("\r");
		const text = comp.render(80).join("\n");
		expect(text).toContain("Select command");
	});

	it("add stage Esc → 回 list stage", () => {
		const { comp } = createComp();
		comp.handleInput("\r"); // → add stage
		comp.handleInput("\x1b"); // Esc
		const text = comp.render(80).join("\n");
		expect(text).toContain("Permission Rules");
		expect(text).not.toContain("Select Template");
	});
});

// ──────────────────────── fill stage：命令选择 + commitFill ────────────────────────

describe("REC4: fill stage 命令选择 + commitFill", () => {
	it("选 npm → commitFill → 回 list stage，新规则出现", () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { comp, done } = createComp();
		// → add stage → 选 allow-family → fill stage（command-select 带搜索）
		comp.handleInput("\r"); // [+ Add rule]
		comp.handleInput("\r"); // allow-family
		// fill stage：搜索框默认获焦，Enter（空 query）→ 选中第一个匹配 npm → 进入 scope 列表
		comp.handleInput("\r");
		// scope 列表：第一条是 `${cmd} * (all subcommands)`（__all__），Enter → commitFill
		comp.handleInput("\r");
		// commitFill → switchToListStage，list 现在应有新规则
		const text = comp.render(80).join("\n");
		expect(text).toContain("npm *");
		expect(comp.ops).toHaveLength(1);
		expect(comp.ops[0]!.kind).toBe("add");
		expect(comp.ops[0]!.rule.pattern).toBe("npm *");
		expect(comp.ops[0]!.rule.action).toBe("allow");
	});
});

// ──────────────────────── _resolved 守卫 ────────────────────────

describe("REC5: _resolved 守卫", () => {
	it("settle 后再 handleInput no-op（done 只调一次）", () => {
		const { comp, done } = createComp();
		// 选 [Done]
		comp.handleInput("\r"); // [+ Add rule]（但无规则时第一条是 [+ Add rule]）
		// 实际无规则时 items = ["[+ Add rule]", "[Done]"]
		// Enter 选了 [+ Add rule]，进 add stage
		// 回到 list 用 cancel
		comp.handleInput("\x1b"); // Esc → back to list
		// 现在 list 有 [+ Add rule] 和 [Done]
		comp.handleInput("\x1b[B"); // Down → [Done]
		comp.handleInput("\r"); // Enter → settle
		expect(done).toHaveBeenCalledOnce();
		// 再次输入 no-op
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── currentListRules（G2） ────────────────────────

describe("REC6: currentListRules 实时反映 ops（G2）", () => {
	it("初始 currentListRules 等于 initialRules", () => {
		const rules = [makeRule({ id: "user-1" })];
		const { comp } = createComp(rules);
		expect(comp.currentListRules()).toEqual(rules);
	});

	it("ops.push add 后 currentListRules 包含新规则", () => {
		const { comp } = createComp([makeRule({ id: "user-1" })]);
		comp.ops.push({ kind: "add", rule: makeRule({ id: "user-2", pattern: "git *" }) });
		const rules = comp.currentListRules();
		expect(rules).toHaveLength(2);
		expect(rules[1]!.pattern).toBe("git *");
	});
});

// ──────────────────────── WR1 handleInput 锁定 ────────────────────────

describe("REC7: WR1 handleInput 委托锁定（critical）", () => {
	it("handleInput('\\r') 直接触发 SelectList.onSelect（list stage [Done]）", () => {
		const { comp, done } = createComp();
		// list stage：无规则 → items = [[+ Add rule], [Done]]
		// Down → [Done]
		comp.handleInput("\x1b[B");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});

	it("handleInput(down + enter) 链式触发导航 + onSelect", () => {
		const { comp, done } = createComp([makeRule({ id: "user-1", pattern: "npm *" })]);
		// list items: [npm * (rule), [+ Add rule], [Done]]
		// 预选 index 0（npm *），Enter → fill(edit)
		comp.handleInput("\r");
		// fill(edit) 模式，render 应含 Edit Rule
		const text = comp.render(80).join("\n");
		expect(text).toContain("Edit Rule");
		// done 不应被调（还在 fill stage）
		expect(done).not.toHaveBeenCalled();
	});
});

// ──────────────────────── WR8 Tab 焦点路由 ────────────────────────

describe("REC8: WR8 Tab 焦点路由（Custom form）", () => {
	it("custom form Tab 循环焦点（5 项）", () => {
		const { comp } = createComp();
		// → add stage
		comp.handleInput("\r"); // [+ Add rule]
		// 选 custom（最后一条模板，index 4）
		for (let i = 0; i < 4; i++) comp.handleInput("\x1b[B"); // Down x4
		comp.handleInput("\r"); // Enter → custom fill
		const text = comp.render(80).join("\n");
		expect(text).toContain("Custom Rule");
		// Tab 5 次应回到原焦点（模 5）
		for (let i = 0; i < 5; i++) comp.handleInput("\t");
		// 不应抛错
		expect(comp.render(80).length).toBeGreaterThan(0);
	});
});

// ──────────────────────── cancel ────────────────────────

describe("REC9: cancel", () => {
	it("cancel() 调 done(ops)（可能为空）", () => {
		const { comp, done } = createComp();
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
	});

	it("cancel 后 _resolved 守卫生效", () => {
		const { comp, done } = createComp();
		comp.cancel();
		comp.cancel();
		expect(done).toHaveBeenCalledOnce();
	});
});
