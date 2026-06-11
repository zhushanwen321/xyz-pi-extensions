import { describe, it, expect } from "vitest";
import { listTemplates, loadTemplate, getBuiltinTemplateDir } from "../templates.js";
import * as fs from "node:fs";

describe("Template system", () => {
  it("listTemplates returns builtin templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    const names = templates.map((t) => t.name);
    expect(names).toContain("feature-plan");
    expect(names).toContain("bugfix-plan");
    expect(names).toContain("refactor-plan");
    expect(names).toContain("research-plan");
    expect(names).toContain("implementation-plan");
  });

  it("loadTemplate returns content for existing builtin template", () => {
    const content = loadTemplate("feature-plan");
    expect(content).not.toBeNull();
    expect(content).toContain("## ");
  });

  it("loadTemplate returns null for non-existent template", () => {
    const content = loadTemplate("non-existent-template");
    expect(content).toBeNull();
  });

  it("getBuiltinTemplateDir returns valid path", () => {
    const dir = getBuiltinTemplateDir();
    expect(fs.existsSync(dir)).toBe(true);
  });
});
