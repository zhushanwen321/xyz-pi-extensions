const meta = {
  name: "phase1-review-gate",
  description: "Phase 1 Spec Review-Gate: review and fix spec.md in a loop",
};

// Shared schema for structured agent output
const reviewSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    must_fix: { type: "number" },
    summary: { type: "string" },
  },
  required: ["verdict", "must_fix", "summary"],
};

// Parse agent() return value — may be parsed JSON or raw string
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return { verdict: "fail", must_fix: -1, summary: "Could not parse review output" };
}

(async () => {
  const { topicDir, maxRounds = 3 } = $ARGS;
  const reviewsDir = topicDir + "/changes/reviews/phase-1";
  let lastMustFix = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const reviewPath = reviewsDir + "/spec_review_v" + round + ".md";

    const raw = await agent({
      prompt: [
        "Review and fix spec.md for Phase 1.",
        "",
        "Topic directory: " + topicDir,
        "Round: " + round,
        "",
        "Instructions:",
        "1. Read " + topicDir + "/spec.md",
        "2. Evaluate completeness, consistency, clarity",
        "3. For must_fix issues, fix them directly in spec.md",
        "4. Write detailed review report to: " + reviewPath,
        "5. YAML frontmatter must include: verdict (pass/fail), must_fix (number of blocking issues)",
        "",
        "After reviewing, report your findings as structured JSON.",
        "If all issues are fixed, set verdict=pass and must_fix=0.",
      ].join("\n"),
      agent: "spec-requirements-reviewer",
      schema: reviewSchema,
      description: "phase1-spec-review-r" + round,
    });

    const parsed = parseResult(raw);
    const mustFix = parsed.must_fix;

    if (mustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0, reviewPath: reviewPath };
    }

    // Stagnation check
    if (lastMustFix >= 0 && mustFix >= lastMustFix) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        return {
          passed: false,
          rounds: round,
          lastMustFix: mustFix,
          stagnation: true,
          reviewPath: reviewPath,
        };
      }
    } else {
      stagnationCount = 0;
    }
    lastMustFix = mustFix;
  }

  return {
    passed: false,
    rounds: maxRounds,
    lastMustFix: lastMustFix,
    maxRounds: true,
  };
})();
