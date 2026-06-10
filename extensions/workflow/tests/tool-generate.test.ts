// 测试 framework: vitest（从 vitest 导入 describe/it/expect）
// 运行命令: pnpm --filter @zhushanwen/pi-workflow test tool-generate.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect,it } from "vitest";

/**
 * Read the raw source of tool-generate.ts to verify promptGuidelines content.
 * Option B — avoids adding exports to the production module.
 */
const toolGenerateSource = readFileSync(
  resolve(import.meta.dirname, "../src/interface/tool-generate.ts"),
  "utf-8",
);

/**
 * Extract the promptGuidelines array from the source as a string array.
 * Matches content between `promptGuidelines: [` and the closing `],`.
 */
function extractPromptGuidelines(src: string): string[] {
  const match = src.match(/promptGuidelines:\s*\[([\s\S]*?)\],/);
  if (!match) throw new Error("promptGuidelines array not found in source");
  const block = match[1];
  // Extract each quoted string
  const items: string[] = [];
  const strRegex = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRegex.exec(block)) !== null) {
    items.push(m[1]);
  }
  return items;
}

const guidelines = extractPromptGuidelines(toolGenerateSource);

// ── Tests ──────────────────────────────────────────────────

describe("promptGuidelines verification rule", () => {
  it("contains verification keyword", () => {
    const joined = guidelines.join(" ");
    expect(joined).toMatch(/verifiable/i);
  });

  it("mentions pattern_a (self-check) or pattern_b (follow-up)", () => {
    const joined = guidelines.join(" ");
    const hasSelfCheck = joined.includes("self-check");
    const hasFollowUp = joined.includes("follow-up");
    expect(hasSelfCheck || hasFollowUp).toBe(true);
  });

  it("existing rules preserved — array length >= previous + 1", () => {
    // Previous count was 6; after adding verification rule, should be >= 7
    expect(guidelines.length).toBeGreaterThanOrEqual(7);
  });
});
