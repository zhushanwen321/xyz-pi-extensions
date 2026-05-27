/**
 * Standalone integration tests for evolution-engine
 * Tests pure logic functions without Pi runtime
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Absolute path to src dir
const srcDir = new URL("../src", import.meta.url).pathname;

const { loadPending, savePending, appendHistory, loadHistory } = await import(
  path.resolve(srcDir, "state.ts")
);
const { parseJudgeOutput, buildJudgeInput } = await import(
  path.resolve(srcDir, "judge.ts")
);
const { applyUnifiedDiff, applySuggestion } = await import(
  path.resolve(srcDir, "applier.ts")
);
const { checkAutoTriggerRules, cleanExpiredFlags } = await import(
  path.resolve(srcDir, "monitor.ts")
);

let passed = 0;
let failed = 0;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: msg });
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `evo-test-${prefix}-`));
}

// ─── TC-5-03: Auto-trigger skip on insufficient data ───
await test("TC-5-03: checkAutoTriggerRules with empty daily/ returns empty", () => {
  const dir = makeTempDir("empty-data");
  const dailyDir = path.join(dir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const flags = checkAutoTriggerRules(dir);
  assert.ok(Array.isArray(flags));
  assert.equal(flags.length, 0);
  fs.rmSync(dir, { recursive: true });
});

await test("TC-5-03: cleanExpiredFlags with nonexistent dir does not throw", () => {
  const dir = path.join(os.tmpdir(), `evo-test-nonexist-${Date.now()}`);
  assert.doesNotThrow(() => cleanExpiredFlags(dir));
});

// ─── State tests ───
await test("State: loadPending returns null for missing file", () => {
  const dir = makeTempDir("no-pending");
  const result = loadPending(dir);
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true });
});

await test("State: savePending + loadPending roundtrip", () => {
  const dir = makeTempDir("roundtrip");
  const pending = {
    generatedAt: new Date().toISOString(),
    reportUsed: "report.json",
    suggestions: [
      {
        id: "sug-1",
        target: "claude-md" as const,
        targetPath: "~/.pi/agent/CLAUDE.md",
        severity: "high" as const,
        confidence: 0.85,
        title: "Remove duplicate rule",
        description: "Rule X appears twice",
        rationale: "Deduplication improves clarity",
        diff: "--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +1,1 @@\n-old\n+new",
        status: "pending" as const,
      },
    ],
  };
  savePending(dir, pending);
  const loaded = loadPending(dir);
  assert.ok(loaded);
  assert.equal(loaded.suggestions.length, 1);
  assert.equal(loaded.suggestions[0].id, "sug-1");
  assert.equal(loaded.suggestions[0].confidence, 0.85);
  fs.rmSync(dir, { recursive: true });
});

await test("State: loadHistory returns [] for missing file", () => {
  const dir = makeTempDir("no-history");
  const result = loadHistory(dir);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
  fs.rmSync(dir, { recursive: true });
});

await test("State: appendHistory + loadHistory roundtrip", () => {
  const dir = makeTempDir("history");
  const entry = {
    timestamp: new Date().toISOString(),
    action: "apply" as const,
    suggestionId: "sug-1",
    targetPath: "~/.pi/agent/CLAUDE.md",
    backupPath: "/tmp/backup.md",
    diff: "--- a\n+++ b\n",
    title: "Test",
  };
  appendHistory(dir, entry);
  const history = loadHistory(dir);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, "apply");
  fs.rmSync(dir, { recursive: true });
});

await test("State: appendHistory respects limit parameter", () => {
  const dir = makeTempDir("history-limit");
  for (let i = 0; i < 5; i++) {
    appendHistory(dir, {
      timestamp: new Date().toISOString(),
      action: "apply",
      suggestionId: `sug-${i}`,
      targetPath: "~/.pi/agent/CLAUDE.md",
      backupPath: `/tmp/backup-${i}.md`,
      diff: "",
      title: `Test ${i}`,
    });
  }
  const limited = loadHistory(dir, 3);
  assert.equal(limited.length, 3);
  const all = loadHistory(dir, 10);
  assert.equal(all.length, 5);
  fs.rmSync(dir, { recursive: true });
});

// ─── TC-8-01: Diff apply ───
await test("TC-8-01: applyUnifiedDiff applies valid diff", () => {
  const dir = makeTempDir("diff-apply");
  const filePath = path.join(dir, "test.md");
  fs.writeFileSync(filePath, "line1\nline2\nline3\n");

  const diff =
    "--- a/test.md\n+++ b/test.md\n@@ -1,3 +1,3 @@\n line1\n-line2\n+MODIFIED\n line3\n";

  const result = applyUnifiedDiff(filePath, diff);
  assert.ok(result.success, `applyUnifiedDiff failed: ${result.reason}`);

  const content = fs.readFileSync(filePath, "utf-8");
  assert.ok(content.includes("MODIFIED"));
  assert.ok(!content.includes("line2"));
  fs.rmSync(dir, { recursive: true });
});

await test("TC-8-01: applyUnifiedDiff detects conflict", () => {
  const dir = makeTempDir("diff-conflict");
  const filePath = path.join(dir, "test.md");
  fs.writeFileSync(filePath, "COMPLETELY DIFFERENT CONTENT\n");

  const diff =
    "--- a/test.md\n+++ b/test.md\n@@ -1,1 +1,1 @@\n-old line\n+new line\n";

  const result = applyUnifiedDiff(filePath, diff);
  assert.ok(!result.success);
  assert.ok(
    result.reason?.includes("conflict") || result.reason?.includes("not match"),
    `unexpected reason: ${result.reason}`
  );
  fs.rmSync(dir, { recursive: true });
});

await test("TC-8-01: applySuggestion rejects path outside whitelist", async () => {
  const dir = makeTempDir("whitelist");
  const backupDir = path.join(dir, "backups");

  const result = await applySuggestion(
    {
      id: "sug-1",
      target: "claude-md",
      targetPath: "/etc/passwd",
      severity: "high",
      confidence: 0.9,
      title: "Evil",
      description: "Should be rejected",
      rationale: "Security test",
      diff: "",
      status: "pending",
    },
    backupDir
  );

  assert.ok(!result.success);
  assert.ok(
    result.reason?.includes("not allowed"),
    `unexpected reason: ${result.reason}`
  );
  fs.rmSync(dir, { recursive: true });
});

// ─── TC-9-01: parseJudgeOutput ───
await test("TC-9-01: parseJudgeOutput returns empty array for []", () => {
  const result = parseJudgeOutput("[]");
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

await test("TC-9-01: parseJudgeOutput parses valid suggestions", () => {
  const input = JSON.stringify([
    {
      target: "claude-md",
      targetPath: "~/.pi/agent/CLAUDE.md",
      severity: "high",
      confidence: 0.85,
      title: "Remove duplicate",
      description: "Rule X duplicated",
      rationale: "Dedup improves clarity",
      diff: "--- a\n+++ b\n",
    },
    {
      target: "skills",
      targetPath: "~/.pi/agent/skills/test/SKILL.md",
      severity: "low",
      confidence: 0.6,
      title: "Update trigger words",
      description: "Add more trigger words",
      rationale: "Current triggers miss some cases",
      diff: "",
    },
  ]);

  const result = parseJudgeOutput(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "pending");
  assert.equal(result[0].confidence, 0.85);
  assert.equal(result[1].severity, "low");
});

await test("TC-9-01: parseJudgeOutput handles markdown fence", () => {
  const input = "```json\n[{\"target\":\"claude-md\",\"targetPath\":\"~/.pi/agent/CLAUDE.md\",\"severity\":\"medium\",\"confidence\":0.7,\"title\":\"Test\",\"description\":\"desc\",\"rationale\":\"rat\",\"diff\":\"\"}]\n```";
  const result = parseJudgeOutput(input);
  assert.equal(result.length, 1);
});

await test("TC-9-01: parseJudgeOutput skips entries with invalid confidence", () => {
  const input = JSON.stringify([
    {
      target: "claude-md",
      targetPath: "~/.pi/agent/CLAUDE.md",
      severity: "high",
      confidence: 1.5,
      title: "Bad",
      description: "Should be skipped",
      rationale: "Test",
      diff: "",
    },
    {
      target: "claude-md",
      targetPath: "~/.pi/agent/CLAUDE.md",
      severity: "high",
      confidence: 0.8,
      title: "Good",
      description: "Should be kept",
      rationale: "Test",
      diff: "",
    },
  ]);

  const result = parseJudgeOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Good");
});

// ─── TC-5-01: token-decline ───
await test("TC-5-01: token-decline flag created when 3 consecutive days above baseline", () => {
  const dir = makeTempDir("token-decline");
  const dailyDir = path.join(dir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });

  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now - i * 86400000);
    const dateStr = date.toISOString().split("T")[0];
    const isRecent = i < 3;
    const totalInput = isRecent ? 900 : 300;
    const sessions = 3;

    fs.writeFileSync(
      path.join(dailyDir, `${dateStr}.json`),
      JSON.stringify({
        date: dateStr,
        sessions,
        toolCalls: { total: 50, byTool: {}, failures: {}, editRetries: 0 },
        tokenUsage: { totalInput, totalOutput: 100, turns: 10 },
        skillTriggers: {},
        agentCalls: 0,
      })
    );
  }

  const flagsDir = path.join(dir, "auto-trigger.flags");
  if (fs.existsSync(flagsDir)) fs.rmSync(flagsDir, { recursive: true });

  const flags = checkAutoTriggerRules(dir);
  const tokenFlag = flags.find((f) => f.rule === "token-decline");
  assert.ok(tokenFlag, "should create token-decline flag");
  assert.ok(
    tokenFlag.detail.includes("consecutive"),
    `detail should mention consecutive: ${tokenFlag.detail}`
  );
  fs.rmSync(dir, { recursive: true });
});

// ─── TC-5-02: skill-dormant ───
await test("TC-5-02: skill-dormant flag created for skills > 30 days inactive", () => {
  const dir = makeTempDir("skill-dormant");
  const dailyDir = path.join(dir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });

  const today = new Date().toISOString().split("T")[0];
  fs.writeFileSync(
    path.join(dailyDir, `${today}.json`),
    JSON.stringify({
      date: today,
      sessions: 1,
      toolCalls: { total: 10, byTool: {}, failures: {}, editRetries: 0 },
      tokenUsage: { totalInput: 100, totalOutput: 50, turns: 5 },
      skillTriggers: {},
      agentCalls: 0,
    })
  );

  const dormantDate = new Date(Date.now() - 45 * 86400000).toISOString();
  fs.writeFileSync(
    path.join(dir, "skill-triggers.json"),
    JSON.stringify({
      "old-skill": { count: 5, lastTriggered: dormantDate },
      "active-skill": { count: 100, lastTriggered: new Date().toISOString() },
    })
  );

  const flagsDir = path.join(dir, "auto-trigger.flags");
  if (fs.existsSync(flagsDir)) fs.rmSync(flagsDir, { recursive: true });

  const flags = checkAutoTriggerRules(dir);
  const dormantFlag = flags.find((f) => f.rule === "skill-dormant");
  assert.ok(dormantFlag, "should create skill-dormant flag");
  assert.ok(
    dormantFlag.detail.includes("old-skill"),
    `detail should mention old-skill: ${dormantFlag.detail}`
  );
  fs.rmSync(dir, { recursive: true });
});

// ─── TC-5-03: No false flags when healthy ───
await test("TC-5-03: no flags when data is healthy", () => {
  const dir = makeTempDir("healthy");
  const dailyDir = path.join(dir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });

  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now - i * 86400000);
    const dateStr = date.toISOString().split("T")[0];
    fs.writeFileSync(
      path.join(dailyDir, `${dateStr}.json`),
      JSON.stringify({
        date: dateStr,
        sessions: 3,
        toolCalls: { total: 50, byTool: {}, failures: {}, editRetries: 0 },
        tokenUsage: { totalInput: 300, totalOutput: 100, turns: 10 },
        skillTriggers: {},
        agentCalls: 0,
      })
    );
  }

  fs.writeFileSync(
    path.join(dir, "skill-triggers.json"),
    JSON.stringify({
      "active-skill": { count: 100, lastTriggered: new Date().toISOString() },
    })
  );

  const flagsDir = path.join(dir, "auto-trigger.flags");
  if (fs.existsSync(flagsDir)) fs.rmSync(flagsDir, { recursive: true });

  const flags = checkAutoTriggerRules(dir);
  assert.equal(flags.length, 0, `should have no flags, got: ${flags.map((f) => f.rule).join(", ")}`);
  fs.rmSync(dir, { recursive: true });
});

// ─── buildJudgeInput target filtering ───
await test("buildJudgeInput filters report for target 'claude-md'", () => {
  const dir = makeTempDir("judge-input");
  const tmpDir = path.join(dir, "tmp");
  const templateDir = path.join(srcDir, "templates");
  fs.mkdirSync(tmpDir, { recursive: true });

  const report = {
    _meta: { generatedAt: new Date().toISOString() },
    tool_stats: { total_calls: 100, by_tool: {}, edit_retry_rate: 0.05 },
    token_stats: { total_input: 50000, total_output: 10000 },
    skill_stats: { installed_skills: 20, triggered_skills: 10 },
    error_stats: { total_errors: 5, by_tool: {} },
  };

  const input = buildJudgeInput(report, "claude-md", tmpDir);
  assert.equal(input.target, "claude-md");
  assert.ok(input.reportPath);
  assert.ok(input.promptFilePath);
  assert.ok(fs.existsSync(input.reportPath));
  fs.rmSync(dir, { recursive: true });
});

// ─── Summary ───
console.log(`\n${"=".repeat(50)}`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log(`${"=".repeat(50)}`);
if (failed > 0) {
  console.log("\nFailed tests:");
  results
    .filter((r) => !r.ok)
    .forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
}
process.exit(failed > 0 ? 1 : 0);
