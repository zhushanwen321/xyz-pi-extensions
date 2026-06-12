const meta = {
  name: "review-fix-loop",
  description: "Review-fix loop: parallel review (5 agents, 3+2 batched) → aggregate → fix → re-review until clean or max rounds",
  phases: [
    { title: "Scan", detail: "Optional fallow static analysis pre-scan" },
    { title: "Review", detail: "Run 5 review agents in 2 batches + aggregate into unified report" },
    { title: "Fix", detail: "Fix all must-fix issues from aggregated review report" },
  ],
};

// ── Shared schemas ─────────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

const reviewerSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to the written review report (.md)" },
    must_fix: { type: "number", description: "Number of must-fix issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level issues found" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to aggregated.md" },
    must_fix: { type: "number", description: "Total must-fix after dedup across all dimensions" },
    suggestion: { type: "number", description: "Total suggestions after dedup across all dimensions" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

// ── Helpers ────────────────────────────────────────────────────────

function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return null;
}

function normalizeAggregatorResult(raw) {
  const parsed = parseResult(raw);
  if (!parsed) return null;
  // Agent may use its own internal field names; map them to the workflow schema.
  const mustFix =
    typeof parsed.must_fix === "number" ? parsed.must_fix :
    typeof parsed.totalMustFix === "number" ? parsed.totalMustFix :
    typeof parsed.mustFix === "number" ? parsed.mustFix :
    undefined;
  const suggestion =
    typeof parsed.suggestion === "number" ? parsed.suggestion :
    typeof parsed.totalSuggestions === "number" ? parsed.totalSuggestions :
    typeof parsed.suggestions === "number" ? parsed.suggestions :
    0;
  if (typeof mustFix !== "number") return null;
  return {
    report_file: parsed.report_file || parsed.reportFile,
    must_fix: mustFix,
    suggestion,
  };
}

// ── Build review agent calls for a round ───────────────────────────

function buildReviewCalls(round, max, roundDir, fallowSummary) {
  const header = `Round ${round}/${max}`;
  const diffCmd = "Review \`git diff main...HEAD\` for all changes against main.";
  const fallowCtx = fallowSummary ? "\nFallow pre-scan context: " + fallowSummary : "";

  const baseCall = (agent, description, reportName, focus) => ({
    prompt: [header + " — " + description, "", diffCmd,
      "Focus: " + focus,
      "Write report to: " + roundDir + "/" + reportName + ".md" + fallowCtx].join("\n"),
    agent,
    schema: reviewerSchema,
    description: agent.replace(/-/g, "") + "-round-" + round,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  return [
    baseCall("review-business-logic", "BUSINESS LOGIC REVIEW", "business-logic",
      "business logic correctness, boundary conditions, regression risk."),
    baseCall("review-monorepo-impact", "MONOREPO IMPACT REVIEW", "monorepo-impact",
      "workspace deps, circular deps, public API changes, extension-dependencies.json."),
    baseCall("review-type-safety", "TYPE SAFETY REVIEW", "type-safety",
      "complete type annotations, no `any`, use `unknown` or concrete types, run tsc."),
    baseCall("review-extension-api", "EXTENSION API REVIEW", "extension-api",
      "tool/command schema completeness, Pi manifest, backward compat, resource containment."),
    baseCall("review-test-coverage", "TEST COVERAGE REVIEW", "test-coverage",
      "tests for new logic, edge case coverage, vitest framework compliance."),
  ];
}

// ── Main Loop ──────────────────────────────────────────────────────

const MAX = $ARGS.maxRounds ?? 10;
const STUCK_THRESHOLD = 3;
const SKIP_FALLOW = $ARGS.skipFallow ?? false;
let totalFixed = 0;
let round = 0;
let clean = false;

// Stuck detection state
let stuckCount = 0;
let prevTotal = -1;

// Optional fallow scan (once before first round)
let fallowSummary = "";
if (!SKIP_FALLOW) {
  phase("Scan");
  try {
    const fallowRaw = await agent({
      prompt: [
        "Fallow pre-scan for review-fix-loop.",
        "",
        "Steps:",
        "1. Check if fallow is installed: `which fallow`",
        "2. If installed, run: `fallow audit --base main --format json --quiet`",
        "3. Extract: complexity hotspots, dead code, unused exports, circular deps",
        "4. Write summary to /tmp/review-fix-loop/fallow-scan.md",
        "5. If fallow not installed, write a one-line note and skip",
      ].join("\n"),
      description: "fallow-prescan",
    });
    const fr = parseResult(fallowRaw);
    if (fr) fallowSummary = fr.summary || fr.output || "";
    if (fallowSummary) log("Fallow scan: " + fallowSummary);
  } catch {
    log("Fallow scan skipped.");
  }
}

while (round < MAX) {
  round++;
  log(`--- Round ${round}/${MAX} ---`);

  // ── Phase: Review (batched 3+2) ──────────────────────────
  phase("Review");
  const roundDir = `/tmp/review-fix-loop/round-${round}`;
  require("fs").mkdirSync(roundDir, { recursive: true });
  const allCalls = buildReviewCalls(round, MAX, roundDir, fallowSummary);

  // Batch 1: first 3 agents
  log("Review batch 1/2 (3 agents)...");
  const batch1 = await parallel(allCalls.slice(0, 3));

  // Batch 2: remaining 2 agents
  log("Review batch 2/2 (2 agents)...");
  const batch2 = await parallel(allCalls.slice(3));

  // Parse all results, tolerate individual failures
  const allRaw = [...batch1, ...batch2];
  const reviewResults = [];
  for (let i = 0; i < allRaw.length; i++) {
    const parsed = parseResult(allRaw[i]);
    if (parsed && typeof parsed.must_fix === "number") {
      reviewResults.push(parsed);
    } else {
      log("  ⚠ " + allCalls[i].description + " failed, skipping.");
    }
  }
  log(`Reviews: ${reviewResults.length}/5 succeeded.`);

  if (reviewResults.length === 0) {
    log("All review agents failed, stopping.");
    break;
  }

  // ── Aggregate ────────────────────────────────────────────
  const aggRaw = await agent({
    prompt: [
      `Round ${round}/${MAX} — AGGREGATE REVIEWS`,
      "",
      "Merge sub-review reports into a unified report.",
      "",
      "Sub-review results: " + JSON.stringify(reviewResults),
      "outputDir: " + roundDir,
      "",
      "Steps:",
      "1. Read each report_file from sub-review results",
      "2. Deduplicate overlapping findings by (file, line, description)",
      "3. Merge statistics: sum must_fix and suggestion after dedup",
      "4. Write " + roundDir + "/aggregated.md (human-readable report for fix agent)",
      "5. If a report file is missing, note in summary but don't fail",
      "",
      "IMPORTANT: After writing the reports, you MUST return a JSON object with exactly these fields:",
      '- "report_file": absolute path to ' + roundDir + "/aggregated.md",
      '- "must_fix": total number of MUST_FIX issues after dedup',
      '- "suggestion": total number of SUGGESTION issues after dedup',
    ].join("\n"),
    agent: "review-aggregator",
    schema: aggregatorSchema,
    description: `aggregate-round-${round}`,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  const agg = normalizeAggregatorResult(aggRaw);
  if (!agg || typeof agg.must_fix !== "number") {
    log("Aggregator returned invalid result: " + JSON.stringify(aggRaw));
    log("Aggregator failed, stopping.");
    break;
  }

  const mustFix = agg.must_fix;
  const suggestion = agg.suggestion ?? 0;
  log(`Aggregated: ${mustFix} must-fix + ${suggestion} suggestion(s).`);

  // ── Gate: clean? ─────────────────────────────────────────
  if (mustFix === 0) {
    clean = true;
    log("Code is clean!");
    break;
  }

  // ── Stuck detection ──────────────────────────────────────
  const total = mustFix + suggestion;
  if (prevTotal >= 0 && total >= prevTotal) {
    stuckCount++;
    if (stuckCount >= STUCK_THRESHOLD) {
      log(`Stuck: total issues not decreasing for ${STUCK_THRESHOLD} rounds. Stopping.`);
      break;
    }
  } else {
    stuckCount = 0;
  }
  prevTotal = total;

  // ── Phase: Fix ───────────────────────────────────────────
  phase("Fix");

  let reportContent;
  try {
    reportContent = require("fs").readFileSync(agg.report_file, "utf-8");
  } catch {
    reportContent = "(could not read aggregated report)";
  }

  const fxRaw = await agent({
    prompt: [
      `Fix round ${round}: Fix ALL must-fix issues from the aggregated review report below.`,
      "",
      "## Aggregated Review Report",
      reportContent,
      "",
      "## Instructions",
      "- Fix every must-fix issue listed in the report",
      "- Apply the MINIMAL correct fix (no refactoring, no style changes)",
      "- Verify each fix by reading the changed file afterwards",
      "- After all fixes, commit with message: `fix: review round " + round + " — " + mustFix + " must-fix`",
      "",
      "Return the count of issues fixed.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        fixed_count: { type: "number", description: "Number of issues fixed" },
        fixes: { type: "array", items: { type: "string" }, description: "One-line description of each fix" },
      },
      required: ["fixed_count"],
    },
    description: `fix-round-${round}`,
  });

  const fx = parseResult(fxRaw);
  if (!fx) {
    log("Fix agent failed, stopping.");
    break;
  }

  totalFixed += fx.fixed_count ?? mustFix;
  log(`Fixed ${fx.fixed_count ?? mustFix} issue(s). Total: ${totalFixed}. Continuing...`);
}

log("\n=== Loop Complete ===");

return {
  rounds: round,
  maxRounds: MAX,
  totalFixed,
  clean,
  message: clean
    ? `Code clean after ${round} round(s). ${totalFixed} issue(s) fixed total.`
    : `Stopped after ${round} round(s). ${totalFixed} issue(s) fixed. May have remaining issues.`,
};
