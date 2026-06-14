// src/__tests__/frontmatter.test.ts
import { describe, expect,it } from "vitest";

import { parseAgentFrontmatter } from "../registry/frontmatter.ts";

describe("parseAgentFrontmatter", () => {
  it("parses name/model/description + body as systemPrompt", () => {
    const md = `---
name: code-reviewer
model: deepseek-router/ds-pro
description: Reviews code
---
You are a code reviewer.`;
    const result = parseAgentFrontmatter(md, "reviewer.md");
    expect(result).toEqual({
      name: "code-reviewer",
      model: "deepseek-router/ds-pro",
      description: "Reviews code",
      systemPrompt: "You are a code reviewer.",
    });
  });

  it("uses filename as name when no frontmatter", () => {
    const result = parseAgentFrontmatter("Just a prompt.", "worker.md");
    expect(result.name).toBe("worker");
    expect(result.systemPrompt).toBe("Just a prompt.");
  });

  it("parses tools as comma-separated list", () => {
    const md = `---
name: scout
tools: read, bash, grep
---
Explore.`;
    const result = parseAgentFrontmatter(md, "scout.md");
    expect(result.tools).toEqual(["read", "bash", "grep"]);
  });

  it("parses extensions as boolean true", () => {
    const md = `---
name: worker
extensions: true
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").extensions).toBe(true);
  });

  it("parses extensions as comma-separated whitelist", () => {
    const md = `---
name: worker
extensions: my-tool, other-tool
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").extensions).toEqual(["my-tool", "other-tool"]);
  });

  it("parses skills as comma-separated list", () => {
    const md = `---
name: worker
skills: code-review, testing
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").skills).toEqual(["code-review", "testing"]);
  });

  it("parses category field", () => {
    const md = `---
name: worker
category: coding
---
Do work.`;
    expect(parseAgentFrontmatter(md, "worker.md").category).toBe("coding");
  });

  it("handles unclosed frontmatter gracefully", () => {
    const md = `---
name: broken
this has no closing delim`;
    const result = parseAgentFrontmatter(md, "broken.md");
    expect(result.name).toBe("broken");
  });
});
