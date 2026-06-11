const meta = {
  name: "review-fix-loop",
  description: "Review-fix loop: parallel review (5 agents) → aggregate → fix → re-review until clean or max rounds",
  phases: [
    { title: "Scan", detail: "Optional fallow static analysis pre-scan" },
    { title: "Review", detail: "Run 5 parallel review agents + aggregate into unified report" },
    { title: "Fix", detail: "Fix all must-fix issues from aggregated review report" },
  ],
};

// ── Shared schema for all 5 review agents ──────────────────────────

const reviewerSchema = {
  type: "object",
  properties: {
    reportPath: { type: "string", description: "Absolute path to the review report file" },
    mustFix: { type: "number", description: "Number of must-fix issues found" },
    suggestions: { type: "number", description: "Number of suggestions found" },
    summary: { type: "string", description: "Brief summary of findings" },
  },
  required: ["reportPath", "mustFix"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    aggregatedJson: { type: "string", description: "Path to aggregated.json" },
    aggregatedMd: { type: "string", description: "Path to aggregated.md" },
    mustFix: { type: "number", description: "Total must-fix count after dedup" },
    suggestions: { type: "number", description: "Total suggestions count after dedup" },
    summary: { type: "string", description: "Brief summary of aggregated findings" },
  },
  required: ["aggregatedMd", "mustFix"],
};

// ── Helpers ────────────────────────────────────────────────────────

function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return null;
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
        "3. Extract: complexity hotspots (>80 lines / >15 cyclomatic), dead code, unused exports, circular deps",
        "4. Write summary to /tmp/review-fix-loop/fallow-scan.md",
        "5. If fallow not installed, write a one-line note and skip",
        "",
        "Return JSON with the scan summary.",
      ].join("\n"),
      schema: {
        type: "object",
        properties: {
          reportPath: { type: "string" },
          summary: { type: "string" },
        },
      },
      description: "fallow-prescan",
    });
    const fallowResult = parseResult(fallowRaw);
    if (fallowResult && fallowResult.summary) {
      fallowSummary = fallowResult.summary;
      log("Fallow scan complete: " + fallowSummary);
    }
  } catch {
    log("Fallow scan skipped (error or not installed).");
  }
}

while (round < MAX) {
  round++;
  log(`--- Round ${round}/${MAX} ---`);

  // ── Phase: Review (parallel 5 agents + aggregate) ────────
  phase("Review");
  const roundDir = `/tmp/review-fix-loop/round-${round}`;

  // Launch 5 parallel review agents
  const reviewResults = await parallel([
    {
      prompt: [
        `Round ${round}/${MAX} — BUSINESS LOGIC REVIEW`,
        "",
        "Review `git diff main...HEAD` for all changes against main.",
        "Focus: business logic correctness, boundary conditions, regression risk.",
        "Write report to: " + roundDir + "/business-logic.md",
        fallowSummary ? "Fallow pre-scan context: " + fallowSummary : "",
      ].join("\n"),
      agent: "review-business-logic",
      schema: reviewerSchema,
      description: `review-bl-round-${round}`,
    },
    {
      prompt: [
        `Round ${round}/${MAX} — MONOREPO IMPACT REVIEW`,
        "",
        "Review `git diff main...HEAD` for all changes against main.",
        "Focus: workspace deps, circular deps, public API changes, extension-dependencies.json.",
        "Write report to: " + roundDir + "/monorepo-impact.md",
      ].join("\n"),
      agent: "review-monorepo-impact",
      schema: reviewerSchema,
      description: `review-mono-round-${round}`,
    },
    {
      prompt: [
        `Round ${round}/${MAX} — TYPE SAFETY REVIEW`,
        "",
        "Review `git diff main...HEAD` for all changes against main.",
        "Focus: complete type annotations, no `any`, use `unknown` or concrete types, run tsc.",
        "Write report to: " + roundDir + "/type-safety.md",
      ].join("\n"),
      agent: "review-type-safety",
      schema: reviewerSchema,
      description: `review-types-round-${round}`,
    },
    {
      prompt: [
        `Round ${round}/${MAX} — EXTENSION API REVIEW`,
        "",
        "Review `git diff main...HEAD` for all changes against main.",
        "Focus: tool/command schema completeness, Pi manifest, backward compat, resource containment.",
        "Write report to: " + roundDir + "/extension-api.md",
      ].join("\n"),
      agent: "review-extension-api",
      schema: reviewerSchema,
      description: `review-ext-round-${round}`,
    },
    {
      prompt: [
        `Round ${round}/${MAX} — TEST COVERAGE REVIEW`,
        "",
        "Review `git diff main...HEAD` for all changes against main.",
        "Focus: tests for new logic, edge case coverage, vitest framework compliance.",
        "Write report to: " + roundDir + "/test-coverage.md",
      ].join("\n"),
      agent: "review-test-coverage",
      schema: reviewerSchema,
      description: `review-test-round-${round}`,
    },
  ]);

  // Parse results, filter out failed agents
  const parsedReviews = reviewResults.map(parseResult).filter(Boolean);
  log(`Completed ${parsedReviews.length}/5 review agents.`);

  // ── Aggregate ────────────────────────────────────────────
  const agg = await agent({
    prompt: [
      `Round ${round}/${MAX} — AGGREGATE REVIEWS`,
      "",
      "Merge all sub-review results into a unified report.",
      "",
      "reviewResults: " + JSON.stringify(parsedReviews),
      "outputDir: " + roundDir,
      "round: " + round,
      "",
      "Steps:",
      "1. Read each reportPath from reviewResults",
      "2. Deduplicate overlapping findings by (file, line, description)",
      "3. Merge statistics across dimensions",
      "4. Write " + roundDir + "/aggregated.json (structured) and " + roundDir + "/aggregated.md (human-readable)",
      "",
      "Return the aggregated JSON output.",
    ].join("\n"),
    agent: "review-aggregator",
    schema: aggregatorSchema,
    description: `aggregate-round-${round}`,
  });

  if (!agg) {
    log("Aggregator returned nothing, stopping.");
    break;
  }

  const mustFix = agg.mustFix;
  const suggestions = agg.suggestions ?? 0;
  log(`Aggregated: ${mustFix} must-fix + ${suggestions} suggestion(s). Report: ${agg.aggregatedMd}`);

  // ── Gate: clean? ─────────────────────────────────────────
  if (mustFix === 0) {
    clean = true;
    log("Code is clean!");
    break;
  }

  // ── Stuck detection ──────────────────────────────────────
  const total = mustFix + suggestions;
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

  // Read aggregated report content to inline in fix prompt
  let reportContent;
  try {
    reportContent = require("fs").readFileSync(agg.aggregatedMd, "utf-8");
  } catch {
    reportContent = "(could not read aggregated report file)";
  }

  const fx = await agent({
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
      "Return the count of issues fixed and a list of what you changed.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        fixedCount: { type: "number", description: "Number of issues fixed" },
        fixes: {
          type: "array",
          items: { type: "string" },
          description: "One-line description of each fix",
        },
      },
      required: ["fixedCount"],
    },
    description: `fix-round-${round}`,
  });

  if (!fx) {
    log("Fix agent returned nothing, stopping.");
    break;
  }

  totalFixed += fx.fixedCount ?? mustFix;
  log(`Fixed ${fx.fixedCount ?? mustFix} issue(s). Total fixed: ${totalFixed}. Continuing...`);
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
