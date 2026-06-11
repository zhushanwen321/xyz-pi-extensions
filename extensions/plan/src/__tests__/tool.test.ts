import { beforeEach,describe, expect, it, vi } from "vitest";

// Mock typebox before importing tool
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: Record<string, unknown>) => ({ type: "string", ...opts }),
    Optional: (schema: unknown) => schema,
  },
  Static: class {},
}));

vi.mock("@mariozechner/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));

// Mock compact.js (dynamically imported by complete action)
vi.mock("../compact.js", () => ({
  handlePlanComplete: vi.fn(),
}));

// Mock widget (imported by abort)
vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

// Mock node:fs — ESM namespace isn't configurable, so we use vi.mock
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

import * as fs from "node:fs";

import { handlePlanComplete } from "../compact.js";
import { PLAN_ACTIONS, registerPlanTool, validateAction } from "../tool.js";
import { updatePlanWidget } from "../widget.js";

/** Build a fake pi + ctx and capture the execute callback from registerTool. */
function setup() {
  const sessions = new Map();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, sessions);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };

  const exec = (params: Record<string, unknown>) => executeFn!("tc0", params, undefined, undefined, ctx);
  return { pi, sessions, ctx, exec };
}

describe("registerPlanTool", () => {
  it("registers a tool named 'plan'", () => {
    const { pi } = setup();
    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe("plan");
  });

  // --- list-template ---
  describe("list-template", () => {
    it("returns template list", async () => {
      const { exec } = setup();
      const res = await exec({ action: "list-template" });
      expect(res.content[0].type).toBe("text");
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.length).toBeGreaterThanOrEqual(0);
      expect(res.details.action).toBe("list-template");
    });
  });

  // --- select-template ---
  describe("select-template", () => {
    it("throws when templateName is missing", async () => {
      const { exec } = setup();
      await expect(exec({ action: "select-template" })).rejects.toThrow("templateName is required");
    });

    it("throws when template does not exist", async () => {
      const { exec } = setup();
      await expect(exec({ action: "select-template", templateName: "nonexistent" })).rejects.toThrow("Template not found");
    });

    it("sets phase to writing and persists", async () => {
      const { exec, pi, sessions } = setup();
      // Use a builtin template name — find one first
      const listRes = await exec({ action: "list-template" });
      const templates = JSON.parse(listRes.content[0].text) as { name: string }[];
      if (templates.length === 0) return; // no builtin templates available

      const name = templates[0].name;
      const res = await exec({ action: "select-template", templateName: name });
      expect(res.details.templateName).toBe(name);
      expect(res.details.action).toBe("select-template");
      expect(pi.appendEntry).toHaveBeenCalled();
      const state = sessions.get("test-session");
      expect(state?.phase).toBe("writing");
      expect(state?.templateName).toBe(name);
    });
  });

  // --- create-template ---
  describe("create-template", () => {
    beforeEach(() => { (fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear(); (fs.writeFileSync as ReturnType<typeof vi.fn>).mockClear(); });

    it("throws when parameters are missing", async () => {
      const { exec } = setup();
      await expect(exec({ action: "create-template" })).rejects.toThrow("templateName and templateContent are required");
    });

    it("throws when name sanitizes to empty", async () => {
      const { exec } = setup();
      await expect(exec({ action: "create-template", templateName: "!!!", templateContent: "x" }))
        .rejects.toThrow("Invalid template name");
    });

    it("writes file with sanitized name", async () => {
      const { exec } = setup();
      const res = await exec({ action: "create-template", templateName: "My Plan v2!", templateContent: "# hello" });
      expect(res.details.templateName).toBe("MyPlanv2");
      expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/test-project/.pi/plan-templates", { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith("/tmp/test-project/.pi/plan-templates/MyPlanv2.md", "# hello");
    });
  });

  // --- complete ---
  describe("complete", () => {
    it("does not advance when user cancels", async () => {
      const { exec, ctx, pi } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Modify the plan first");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("sets phase to complete and restores tools on execute", async () => {
      const { exec, ctx, pi, sessions } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute the plan");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(pi.setActiveTools).toHaveBeenCalledWith(undefined);
      expect(handlePlanComplete).toHaveBeenCalled();
      const state = sessions.get("test-session");
      expect(state?.phase).toBe("complete");
    });
  });

  // --- abort ---
  describe("abort", () => {
    it("resets state and cleans up session", async () => {
      const { exec, pi, sessions } = setup();
      // Pre-populate a session
      sessions.set("test-session", { isActive: true, phase: "writing", planFilePath: "/tmp/plan.md", requirement: "test", templateName: "t" });
      const res = await exec({ action: "abort" });
      expect(res.details.action).toBe("abort");
      expect(pi.setActiveTools).toHaveBeenCalledWith(undefined);
      expect(sessions.has("test-session")).toBe(false);
      expect(updatePlanWidget).toHaveBeenCalled();
    });
  });
});

describe("validateAction", () => {
  it("accepts valid actions", () => {
    for (const a of PLAN_ACTIONS) expect(validateAction(a)).toBe(true);
  });
  it("rejects invalid", () => {
    expect(validateAction("bogus")).toBe(false);
  });
});
