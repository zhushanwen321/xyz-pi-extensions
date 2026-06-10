const meta = {
  name: "review-fix-loop",
  description: "Review-fix loop: code-review → fix → re-review until clean or max rounds",
  phases: [
    { title: "Review", detail: "Run code-review skill and produce structured report" },
    { title: "Fix", detail: "Fix all must-fix issues from review report" },
  ],
};

const MAX = $ARGS.maxRounds ?? 10;
const STUCK_THRESHOLD = 3;
let totalFixed = 0;
let round = 0;
let clean = false;

// Stuck detection state
let stuckCount = 0;
let prevTotal = -1;

while (round < MAX) {
  round++;
  log(`--- Round ${round}/${MAX} ---`);

  // ── Phase 1: Review ──────────────────────────────────
  phase("Review");
  const reportPath = `/tmp/review-fix-loop/report-${round}.md`;

  const rv = await agent({
    prompt: [
      `Round ${round}/${MAX} — CODE REVIEW`,
      "",
      "Review `git diff main...HEAD` for all changes against main.",
      "",
      "Steps:",
      "1. Execute a full code review (business logic, types, error handling, tests, code quality)",
      "2. Classify each finding as must-fix or suggestion",
      "3. Write the complete review report to " + reportPath,
      "   The report MUST contain:",
      '   - Title: "# Review Report — Round ' + round + '"',
      "   - A Summary section with the must-fix count and suggestion count",
      "   - Each finding: file path, line range, description, severity",
      "",
      "If no issues found, write a report saying \"No issues found\" and set counts to 0.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        reportPath: { type: "string", description: "Absolute path to the review report file" },
        mustFix: { type: "number", description: "Number of must-fix issues found" },
        suggestions: { type: "number", description: "Number of suggestions found" },
        summary: { type: "string", description: "Brief summary of findings" },
      },
      required: ["reportPath", "mustFix"],
    },
    description: `review-round-${round}`,
    skill: "code-review",
  });

  if (!rv) {
    log("Review agent returned nothing, stopping.");
    break;
  }

  const mustFix = rv.mustFix;
  const suggestions = rv.suggestions ?? 0;
  log(`Found ${mustFix} must-fix + ${suggestions} suggestion(s). Report: ${rv.reportPath}`);

  // ── Gate: clean? ─────────────────────────────────────
  if (mustFix === 0) {
    clean = true;
    log("Code is clean!");
    break;
  }

  // ── Stuck detection ──────────────────────────────────
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

  // ── Phase 2: Fix ─────────────────────────────────────
  phase("Fix");

  // Read report content to inline in fix prompt
  let reportContent;
  try {
    reportContent = require("fs").readFileSync(rv.reportPath, "utf-8");
  } catch {
    reportContent = "(could not read report file)";
  }

  const fx = await agent({
    prompt: [
      `Fix round ${round}: Fix ALL must-fix issues from the review report below.`,
      "",
      "## Review Report",
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
