// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/format.test.ts
//
// S5 (round-4 review): format.ts pure-function direct unit tests.
// 16 exported pure functions in format.ts; only 2 (buildPhaseGroups, formatStatusBadge)
// had direct unit coverage in workflows-view.test.ts. The branched helpers
// (formatElapsed, formatTokenStat, formatActivityLine, visibleLen, padVisible)
// were only exercised indirectly through createWorkflowsView, so branch boundaries
// were never asserted. This file adds direct unit tests for those.

import { describe, expect, it } from "vitest";

import type { ToolCallEntry } from "../engine/models/types.js";
import {
  ELLIPSIS,
  formatActivityLine,
  formatElapsed,
  formatTokenStat,
  padVisible,
  visibleLen,
} from "../interface/views/format.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeToolCall(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return { name: "read", input: "file.ts", ...overrides };
}

// ── formatElapsed (4 branches) ──────────────────────────────
//
// Branches:
//   1. !startedAt → "-"
//   2. ms < MS_PER_SEC (1000) → "0s"
//   3. secs < SECS_PER_MIN (60) → "Ns"
//   4. else → "NmMs"

describe("formatElapsed", () => {
  it("branch 1: undefined startedAt → '-'", () => {
    expect(formatElapsed(undefined)).toBe("-");
  });

  it("branch 1: empty-string startedAt → '-'", () => {
    expect(formatElapsed("")).toBe("-");
  });

  it("branch 2: < 1s elapsed → '0s'", () => {
    const startedAt = new Date(Date.now() - 500).toISOString();
    expect(formatElapsed(startedAt)).toBe("0s");
  });

  it("branch 2: exactly at boundary (just under 1s) → '0s'", () => {
    const startedAt = new Date(Date.now() - 999).toISOString();
    expect(formatElapsed(startedAt)).toBe("0s");
  });

  it("branch 3: 1s..59s → 'Ns'", () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    expect(formatElapsed(startedAt)).toBe("30s");
  });

  it("branch 3: just under 60s → '59s'", () => {
    const startedAt = new Date(Date.now() - 59_999).toISOString();
    expect(formatElapsed(startedAt)).toBe("59s");
  });

  it("branch 4: >= 60s → 'NmMs'", () => {
    // 125s = 2m5s
    const startedAt = new Date(Date.now() - 125_000).toISOString();
    expect(formatElapsed(startedAt)).toBe("2m5s");
  });

  it("deterministic with explicit `now` param (no wall-clock flakiness)", () => {
    // Use fixed `now` to make assertions exact.
    const now = new Date("2026-06-22T10:05:00.000Z").getTime();
    const startedAt = "2026-06-22T10:00:00.000Z"; // exactly 5 minutes earlier
    expect(formatElapsed(startedAt, now)).toBe("5m0s");
  });
});

// ── formatTokenStat (2 optional branches) ───────────────────
//
// Branches:
//   - usage absent → tokens=0
//   - toolCalls absent → tools=0
//   - elapsed absent → no elapsed segment; present → appended

describe("formatTokenStat", () => {
  it("no usage, no toolCalls, no elapsed → '0 tok · 0 tool calls'", () => {
    expect(formatTokenStat()).toBe("0 tok · 0 tool calls");
  });

  it("usage present → tokens = input + output", () => {
    expect(formatTokenStat({ input: 120, output: 30 })).toBe("150 tok · 0 tool calls");
  });

  it("toolCalls present → tool count", () => {
    expect(formatTokenStat(undefined, [makeToolCall(), makeToolCall(), makeToolCall()])).toBe(
      "0 tok · 3 tool calls",
    );
  });

  it("elapsed present → appended", () => {
    expect(formatTokenStat({ input: 100, output: 50 }, [], "2m5s")).toBe(
      "150 tok · 0 tool calls · 2m5s",
    );
  });

  it("all present → full string", () => {
    expect(
      formatTokenStat({ input: 200, output: 100 }, [makeToolCall(), makeToolCall()], "30s"),
    ).toBe("300 tok · 2 tool calls · 30s");
  });
});

// ── formatActivityLine (3 width branches) ───────────────────
//
// Branches:
//   1. maxWidth < MIN_ACTIVITY_WIDTH (10) → just entry.name
//   2. argsBudget <= 0 (name fills width) → truncateToWidth(name, maxWidth)
//   3. else → `name(truncatedInput)`; input truncated with ELLIPSIS if > budget

describe("formatActivityLine", () => {
  it("branch 1: maxWidth < 10 → returns just name", () => {
    expect(formatActivityLine(makeToolCall({ name: "read" }), 5)).toBe("read");
  });

  it("branch 1: maxWidth exactly 9 (below threshold) → just name", () => {
    expect(formatActivityLine(makeToolCall({ name: "read" }), 9)).toBe("read");
  });

  it("branch 2: name too long for maxWidth → truncateToWidth(name, maxWidth)", () => {
    // maxWidth=10, name="deployment" (11 chars), argsBudget = 10 - 11 - 2 = -3 <= 0
    const result = formatActivityLine(makeToolCall({ name: "deployment", input: "x" }), 10);
    // truncateToWidth("deployment", 10) — name gets truncated to fit maxWidth
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.startsWith("deploy")).toBe(true);
  });

  it("branch 3: input fits in budget → 'name(input)'", () => {
    // maxWidth=20, name="read" (4), PARENS_OVERHEAD=2 → argsBudget = 20 - 4 - 2 = 14
    // input "file.ts" (7) fits
    expect(formatActivityLine(makeToolCall({ name: "read", input: "file.ts" }), 20)).toBe(
      "read(file.ts)",
    );
  });

  it("branch 3: input exceeds budget → truncated with ELLIPSIS", () => {
    // maxWidth=12, name="read" (4), argsBudget = 12 - 4 - 2 = 6
    // input "very-long-input" (16) > 6 → slice(0, 5) + ELLIPSIS = "very-" + …
    const result = formatActivityLine(makeToolCall({ name: "read", input: "very-long-input" }), 12);
    expect(result).toBe(`read(very-${ELLIPSIS})`);
    // visible length of args portion (inside parens) must equal argsBudget
    const insideParens = result.slice("read(".length, -1);
    expect(insideParens.length).toBe(6);
  });

  it("branch 3: input exactly at budget → no truncation", () => {
    // maxWidth=13, name="read" (4), argsBudget = 13 - 4 - 2 = 7
    // input "file.ts" (7) === budget → no truncation
    expect(formatActivityLine(makeToolCall({ name: "read", input: "file.ts" }), 13)).toBe(
      "read(file.ts)",
    );
  });
});

// ── visibleLen + padVisible (ANSI-escape aware) ──────────────

describe("visibleLen", () => {
  it("plain string → length equals string length", () => {
    expect(visibleLen("hello")).toBe(5);
  });

  it("empty string → 0", () => {
    expect(visibleLen("")).toBe(0);
  });

  it("SGR-colored string → only visible chars counted", () => {
    // \x1b[31m (red) + "hi" + \x1b[0m (reset) → visible length 2
    expect(visibleLen("\x1b[31mhi\x1b[0m")).toBe(2);
  });

  it("OSC hyperlink string → only visible chars counted", () => {
    // OSC sequence \x1b]8;;url\x07text\x1b]8;;\x07 → visible length = len("text")
    expect(visibleLen("\x1b]8;;https://example.com\x07click\x1b]8;;\x07")).toBe(5);
  });

  it("mixed escapes + plain → counts only visible", () => {
    expect(visibleLen("\x1b[1m\x1b[31mABC\x1b[0m\x1b[0m")).toBe(3);
  });
});

describe("padVisible", () => {
  it("already wider than target → unchanged", () => {
    expect(padVisible("hello", 3)).toBe("hello");
  });

  it("exactly target width → unchanged", () => {
    expect(padVisible("hi", 2)).toBe("hi");
  });

  it("shorter → padded with spaces to target visible width", () => {
    expect(padVisible("hi", 5)).toBe("hi   ");
    expect(visibleLen(padVisible("hi", 5))).toBe(5);
  });

  it("pads ANSI-colored string correctly (visible width, not raw)", () => {
    // "\x1b[31mhi\x1b[0m" has visibleLen 2; pad to 5 → 3 trailing spaces
    const padded = padVisible("\x1b[31mhi\x1b[0m", 5);
    expect(visibleLen(padded)).toBe(5);
    expect(padded.endsWith("   ")).toBe(true);
  });

  it("padding preserves the ANSI styling prefix", () => {
    const padded = padVisible("\x1b[31mhi\x1b[0m", 5);
    expect(padded.startsWith("\x1b[31mhi\x1b[0m")).toBe(true);
  });
});
