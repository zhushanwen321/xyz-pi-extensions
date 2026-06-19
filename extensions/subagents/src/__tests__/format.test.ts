// src/__tests__/format.test.ts
import { describe, expect, it } from "vitest";

import {
  formatElapsedSeconds,
  formatTokens,
  padToVisible,
  sanitizeLabel,
  segFillColored,
  spinnerGlyph,
  statusGlyph,
  truncLine,
} from "../tui/format.ts";

// ============================================================
// formatTokens
// ============================================================
describe("formatTokens", () => {
  it("shows plain value below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(999)).toBe("999");
  });

  it("shows N.Nk between 1000 and 9999", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(8200)).toBe("8.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("shows rounded Nk at 10000+", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(23000)).toBe("23k");
    expect(formatTokens(99999)).toBe("100k");
  });
});

// ============================================================
// formatElapsedSeconds
// ============================================================
describe("formatElapsedSeconds", () => {
  it("shows Xs below 60", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(12)).toBe("12s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  it("shows Xm Ys between 60 and 3599", () => {
    expect(formatElapsedSeconds(60)).toBe("1m0s");
    expect(formatElapsedSeconds(72)).toBe("1m12s");
    expect(formatElapsedSeconds(3599)).toBe("59m59s");
  });

  it("shows Xh Ym at 3600+", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h0m");
    expect(formatElapsedSeconds(3661)).toBe("1h1m");
    expect(formatElapsedSeconds(7325)).toBe("2h2m");
  });
});

// ============================================================
// statusGlyph
// ============================================================
describe("statusGlyph", () => {
  it("running → no icon, accent color", () => {
    expect(statusGlyph("running")).toEqual({ icon: undefined, color: "accent" });
  });

  it("done → checkmark, success", () => {
    expect(statusGlyph("done")).toEqual({ icon: "✓", color: "success" });
  });

  it("failed → cross, error", () => {
    expect(statusGlyph("failed")).toEqual({ icon: "✗", color: "error" });
  });

  it("cancelled → square, muted", () => {
    expect(statusGlyph("cancelled")).toEqual({ icon: "■", color: "muted" });
  });
});

// ============================================================
// spinnerGlyph
// ============================================================
describe("spinnerGlyph", () => {
  it("returns a frame for valid seed", () => {
    expect(spinnerGlyph(0)).toBe("⠋");
    expect(spinnerGlyph(1)).toBe("⠙");
    expect(spinnerGlyph(9)).toBe("⠏");
  });

  it("wraps around (mod 10)", () => {
    expect(spinnerGlyph(10)).toBe("⠋");
    expect(spinnerGlyph(15)).toBe("⠴"); // index 5
  });

  it("falls back to frame 0 on NaN", () => {
    expect(spinnerGlyph(NaN)).toBe("⠋");
  });

  it("handles negative seeds via abs", () => {
    expect(spinnerGlyph(-1)).toBe("⠙"); // abs(-1) % 10 = 1 → ⠙
    expect(spinnerGlyph(-10)).toBe("⠋");
  });

  it("falls back to frame 0 on Infinity", () => {
    expect(spinnerGlyph(Infinity)).toBe("⠋");
  });
});

// ============================================================
// sanitizeLabel
// ============================================================
describe("sanitizeLabel", () => {
  it("replaces CRLF/LF with single space", () => {
    expect(sanitizeLabel("line1\r\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("replaces tabs with 2 spaces", () => {
    expect(sanitizeLabel("a\tb")).toBe("a  b");
  });

  it("collapses multiple consecutive newlines into one space", () => {
    // /[\r\n]+/g treats \r\n\r\n as one match → single space
    expect(sanitizeLabel("a\r\n\r\nb")).toBe("a b");
  });

  it("leaves clean text unchanged", () => {
    expect(sanitizeLabel("read foo.ts")).toBe("read foo.ts");
  });
});

// ============================================================
// padToVisible
// ============================================================
describe("padToVisible", () => {
  it("pads short text to width with trailing spaces", () => {
    expect(padToVisible("ab", 5)).toBe("ab   ");
  });

  it("returns unchanged when already at width", () => {
    expect(padToVisible("hello", 5)).toBe("hello");
  });

  it("returns unchanged when wider than width", () => {
    expect(padToVisible("hello world", 5)).toBe("hello world");
  });

  it("handles CJK width (2 columns per char)", () => {
    // 你好 = 4 visible columns
    expect(padToVisible("你好", 6)).toBe("你好  ");
  });
});

// ============================================================
// segFillColored
// ============================================================
describe("segFillColored", () => {
  it("returns empty string for width <= 0", () => {
    expect(segFillColored("title", "-", 0)).toBe("");
    expect(segFillColored("title", "-", -1)).toBe("");
  });

  it("pure fill when no title", () => {
    expect(segFillColored(undefined, "-", 5)).toBe("-----");
  });

  it("title + fill to width", () => {
    expect(segFillColored("Hi", "-", 5)).toBe("Hi---");
  });

  it("truncates title when wider than width", () => {
    const result = segFillColored("Hello World", "-", 5);
    // title visible width 11 > 5 → truncated to 5 (with ellipsis = 4 chars + …)
    expect(result.length).toBeLessThanOrEqual(10); // visible width 5 but may include ANSI
  });

  it("preserves ANSI in title and fill separately (no nesting color loss)", () => {
    const redTitle = "\x1b[31mHi\x1b[0m";
    const blueFill = "\x1b[34m-\x1b[0m";
    const result = segFillColored(redTitle, blueFill, 5);
    // title visible width = 2 ("Hi"), fill count = 3
    expect(result).toContain(redTitle);
    expect(result).toContain(blueFill);
    // fill repeated 3 times
    expect(result).toBe(redTitle + blueFill + blueFill + blueFill);
  });
});

// ============================================================
// truncLine
// ============================================================
describe("truncLine", () => {
  it("returns text unchanged when within width", () => {
    expect(truncLine("hello", 10)).toBe("hello");
    expect(truncLine("hello", 5)).toBe("hello");
  });

  it("returns empty string for width <= 0", () => {
    expect(truncLine("hello", 0)).toBe("");
  });

  it("truncates with ellipsis when exceeding width", () => {
    const result = truncLine("hello world", 8);
    expect(result.endsWith("…")).toBe(true);
    // visible width should be 8 (7 chars + ellipsis)
  });

  it("handles CJK characters (2 columns each)", () => {
    // 你好世界 = 8 visible columns; truncate to 5 → 2 chars (4 cols) + …
    const result = truncLine("你好世界", 5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles emoji correctly", () => {
    const result = truncLine("😀😁😂🤣😃", 3);
    expect(result.endsWith("…")).toBe(true);
  });

  it("reapplies active ANSI styles before ellipsis (no background break)", () => {
    // red text that exceeds width → ellipsis should have red re-applied
    const input = "\x1b[31mhello world this is long\x1b[0m";
    const result = truncLine(input, 10);
    expect(result.endsWith("…")).toBe(true);
    // The ellipsis should be preceded by the active red style (re-applied)
    // Check that the last grapheme sequence includes the red SGR before …
    expect(result).toMatch(/\x1b\[31m…$/);
  });

  it("clears style stack on reset code", () => {
    // text with reset in the middle → after reset, no style re-applied
    const input = "\x1b[31mab\x1b[0mcdefghijk";
    const result = truncLine(input, 6);
    expect(result.endsWith("…")).toBe(true);
  });
});
