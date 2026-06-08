const meta = {
  name: "phase4-test-fix-loop",
  description: "Phase 4 Test-Fix Loop: core then noncore serial test-fix cycles",
};

// ── Schemas ────────────────────────────────────────────────────────

const testExecuteSchema = {
  type: "object",
  properties: {
    total: { type: "number" },
    passed: { type: "number" },
    failed: { type: "number" },
    skipped: { type: "number" },
    fixed: { type: "number" },
  },
  required: ["total", "passed", "failed"],
};

const fixWorkerSchema = {
  type: "object",
  properties: {
    fixed: { type: "number" },
    remaining: { type: "number" },
  },
  required: ["fixed", "remaining"],
};

// ── Helpers ────────────────────────────────────────────────────────

// agent() returns the unwrapped value (parsedOutput ?? content). Be
// defensive: a downstream agent may emit raw JSON text if its schema
// didn't apply, in which case the value is a string. Sentinel -1
// values for `failed`/`passed`/`total` signal a parse failure.
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return { failed: -1, passed: -1, total: -1 };
}

// Build the coordinator prompt for one (scope, round) tuple.
function buildCoordPrompt(scope, topicDir, round) {
  const incremental = round > 1
    ? "Apply incremental strategy: only rerun fixed + dependent cases from the previous round."
    : "Run all " + scope + " cases from scratch.";
  return [
    "Test execute coordinator for Phase 4.",
    "Topic directory: " + topicDir,
    "Scope: " + scope,
    "Round: " + round,
    "",
    "Instructions:",
    "1. Read " + topicDir + "/changes/test_cases_template.json",
    "2. Filter cases where phase=4 and scope=" + scope,
    "3. " + incremental,
    "4. Dispatch wave: parallel test-case-subagent invocations",
    "5. Write execution state to " + topicDir + "/changes/reviews/phase-4/test-execute-v" + round + "-" + scope + ".json",
    "6. Return JSON: { total, passed, failed, skipped, fixed }",
  ].join("\n");
}

// Build the fix-worker prompt for one (scope, round) tuple.
function buildFixPrompt(scope, topicDir, round, coordResult) {
  return [
    "Test fix worker for Phase 4.",
    "Topic directory: " + topicDir,
    "Scope: " + scope,
    "Round: " + round,
    "",
    "Previous round summary: " + JSON.stringify(coordResult || {}),
    "",
    "Instructions:",
    "1. Read " + topicDir + "/changes/reviews/phase-4/test-execute-v" + round + "-" + scope + ".json",
    "2. Identify all failed cases",
    "3. Apply minimal-scope fixes; do not change unrelated code or test specs",
    "4. Return JSON: { fixed, remaining }",
  ].join("\n");
}

// ── Loop ───────────────────────────────────────────────────────────

// Run a test-fix loop for a single scope (core | noncore).
// Stagnation: maxStagnation consecutive rounds with no decrease in
// `failed` count triggers early exit.
async function runTestFixLoop(scope, topicDir, maxRounds, maxStagnation) {
  let lastFailed = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // Coordinator: construct JSON, dispatch wave, report summary.
    const coordRaw = await agent({
      prompt: buildCoordPrompt(scope, topicDir, round),
      agent: "test-execute-coordinator",
      schema: testExecuteSchema,
      description: "test-coord-" + scope + "-r" + round,
    });
    const coordResult = parseResult(coordRaw);
    const failed = (coordResult && typeof coordResult.failed === "number")
      ? coordResult.failed
      : -1;

    // Pass gate: no failed cases this round.
    if (failed === 0) {
      return {
        passed: true,
        scope: scope,
        round: round,
        total: (coordResult && coordResult.total) || 0,
      };
    }

    // Fix worker: address all failed cases.
    await agent({
      prompt: buildFixPrompt(scope, topicDir, round, coordResult),
      agent: "test-fix-worker",
      schema: fixWorkerSchema,
      description: "test-fix-" + scope + "-r" + round,
    });

    // Stagnation: maxStagnation consecutive rounds with no decrease.
    if (lastFailed >= 0 && failed >= lastFailed) {
      stagnationCount++;
      if (stagnationCount >= maxStagnation) {
        return {
          passed: false,
          scope: scope,
          round: round,
          lastFailed: failed,
          stagnation: true,
        };
      }
    } else {
      stagnationCount = 0;
    }
    lastFailed = failed;
  }

  return {
    passed: false,
    scope: scope,
    lastFailed: lastFailed,
    maxRounds: true,
  };
}

// ── Main ───────────────────────────────────────────────────────────

(async () => {
  const { topicDir, maxRounds = 10, maxStagnation = 3 } = $ARGS;

  // Workflow 1: Core cases (gate on pass before running non-core).
  const core = await runTestFixLoop("core", topicDir, maxRounds, maxStagnation);
  if (!core.passed) {
    return { core: core, noncore: null, overall: false };
  }

  // Workflow 2: Non-core cases (only after core passes).
  const noncore = await runTestFixLoop("noncore", topicDir, maxRounds, maxStagnation);
  return { core: core, noncore: noncore, overall: noncore.passed };
})();
