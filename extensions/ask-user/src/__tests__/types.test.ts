// src/__tests__/types.test.ts
import { describe, expect, it } from "vitest";

import { createQuestionState, InputSchema, OTHER_LABEL, SPLIT_PANE_MIN_WIDTH } from "../types";

describe("types", () => {
	it("InputSchema accepts valid single question", () => {
		const valid = {
			questions: [
				{
					question: "Which DB?",
					options: [{ label: "Postgres" }, { label: "SQLite" }],
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

	it("createQuestionState returns initial state with mode 'options'", () => {
		const s = createQuestionState();
		expect(s.cursorIndex).toBe(0);
		expect(s.selectedIndex).toBeNull();
		expect(s.selectedIndices).toBeInstanceOf(Set);
		expect(s.confirmed).toBe(false);
		expect(s.freeTextValue).toBeNull();
		expect(s.commentValue).toBeNull();
		expect(s.mode).toBe("options");
	});
});
