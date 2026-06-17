// src/__tests__/ext-selectors.test.ts
import { describe, expect, it } from "vitest";

import { filterTools } from "../resolution/tool-filter.ts";
import type { ExtSelectors } from "../types.ts";

function makeSelectors(entries: string[]): ExtSelectors {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const e of entries) {
    const spec = e.slice(4); // 去掉 "ext:"
    const idx = spec.indexOf("/");
    if (idx > 0) {
      const ext = spec.slice(0, idx).toLowerCase();
      const tool = spec.slice(idx + 1);
      extNames.add(ext);
      if (!narrowing.has(ext)) narrowing.set(ext, new Set());
      narrowing.get(ext)!.add(tool);
    } else {
      extNames.add(spec.toLowerCase());
    }
  }
  return { extNames, narrowing };
}

const allTools = [
  { name: "read" },
  { name: "bash" },
  { name: "@mcp/search" },
  { name: "@mcp/fetch" },
  { name: "@github/create_issue" },
  { name: "@github/list_prs" },
];

describe("ext: selectors in filterTools", () => {
  it("ext:foo allows all tools from that extension", () => {
    const result = filterTools({
      allTools,
      config: { extSelectors: makeSelectors(["ext:mcp"]) },
    });
    expect(result.allowedTools).toContain("@mcp/search");
    expect(result.allowedTools).toContain("@mcp/fetch");
    expect(result.allowedTools).not.toContain("@github/create_issue");
    // 非 ext 工具不受 extSelectors 影响（builtin 仍全部允许）
    expect(result.allowedTools).toContain("read");
  });

  it("ext:foo/bar narrows to specific tool", () => {
    const result = filterTools({
      allTools,
      config: { extSelectors: makeSelectors(["ext:github/create_issue"]) },
    });
    expect(result.allowedTools).toContain("@github/create_issue");
    expect(result.allowedTools).not.toContain("@github/list_prs");
  });

  it("multiple ext: selectors combine", () => {
    const result = filterTools({
      allTools,
      config: { extSelectors: makeSelectors(["ext:mcp", "ext:github/list_prs"]) },
    });
    expect(result.allowedTools).toContain("@mcp/search");
    expect(result.allowedTools).toContain("@mcp/fetch");
    expect(result.allowedTools).toContain("@github/list_prs");
    expect(result.allowedTools).not.toContain("@github/create_issue");
  });

  it("ext: with explicit builtinTools restricts builtins too", () => {
    const result = filterTools({
      allTools,
      config: {
        builtinTools: ["read"],
        extSelectors: makeSelectors(["ext:mcp/search"]),
      },
    });
    expect(result.allowedTools).toContain("read");
    expect(result.allowedTools).not.toContain("bash");
    expect(result.allowedTools).toContain("@mcp/search");
    expect(result.allowedTools).not.toContain("@mcp/fetch");
  });
});

describe("frontmatter ext: parsing", () => {
  it("parses ext: entries from tools field", async () => {
    const { parseAgentFrontmatter } = await import("../registry/frontmatter.ts");
    const md = `---
name: test
tools: read, ext:mcp/search, ext:github
---
prompt`;
    const parsed = parseAgentFrontmatter(md, "test.md");
    expect(parsed.tools).toEqual(["read"]); // ext: 条目已分离
    expect(parsed.extSelectors).toBeDefined();
    expect(parsed.extSelectors!.extNames.has("mcp")).toBe(true);
    expect(parsed.extSelectors!.extNames.has("github")).toBe(true);
    expect(parsed.extSelectors!.narrowing.get("mcp")!.has("search")).toBe(true);
    // github 无 narrowing = 全部工具
    expect(parsed.extSelectors!.narrowing.has("github")).toBe(false);
  });

  it("parses isolation: worktree", async () => {
    const { parseAgentFrontmatter } = await import("../registry/frontmatter.ts");
    const md = `---
name: test
isolation: worktree
---
prompt`;
    const parsed = parseAgentFrontmatter(md, "test.md");
    expect(parsed.isolation).toBe("worktree");
  });
});
