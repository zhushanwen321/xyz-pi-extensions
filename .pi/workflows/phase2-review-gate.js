const meta = {
  name: "phase2-review-gate",
  description: "Phase 2 Plan Review-Gate: L1 single-agent or L2 dual-agent serial",
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
  const { topicDir, complexity = "L1", maxRounds = 3 } = $ARGS;
  const reviewsDir = topicDir + "/changes/reviews/phase-2";
  let lastMustFix = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    let totalMustFix = 0;

    if (complexity === "L2") {
      // L2: two serial agents — requirements then BL coverage
      const reqRaw = await agent({
        prompt: [
          "Review plan requirements for Phase 2 (L2 mode).",
          "",
          "Topic directory: " + topicDir,
          "Round: " + round,
          "",
          "Instructions:",
          "1. Read " + topicDir + "/plan.md and " + topicDir + "/spec.md",
          "2. Evaluate plan feasibility, deliverable completeness, Execution Group quality",
          "3. Check Task List covers all spec Acceptance Criteria",
          "4. Write detailed review to: " + reviewsDir + "/plan_review_v" + round + ".md",
          "5. YAML frontmatter: verdict (pass/fail), must_fix (count)",
          "",
          "Report findings as structured JSON.",
        ].join("\n"),
        agent: "plan-requirements-reviewer",
        schema: reviewSchema,
        description: "phase2-plan-review-r" + round,
      });
      const reqParsed = parseResult(reqRaw);

      const blRaw = await agent({
        prompt: [
          "Review business logic coverage for Phase 2 (L2 mode).",
          "",
          "Topic directory: " + topicDir,
          "Round: " + round,
          "",
          "Instructions:",
          "1. Read " + topicDir + "/spec.md (Use Cases, Constraints) and " + topicDir + "/plan.md (Task List)",
          "2. Build mapping matrix: each Use Case → corresponding Task",
          "3. Flag uncovered Use Cases as must_fix",
          "4. Write detailed review to: " + reviewsDir + "/bl_review_v" + round + ".md",
          "5. YAML frontmatter: verdict (pass/fail), must_fix (count)",
          "",
          "Report findings as structured JSON.",
        ].join("\n"),
        agent: "plan-bl-requirements-reviewer",
        schema: reviewSchema,
        description: "phase2-bl-review-r" + round,
      });
      const blParsed = parseResult(blRaw);

      totalMustFix = (reqParsed.must_fix >= 0 ? reqParsed.must_fix : 0)
        + (blParsed.must_fix >= 0 ? blParsed.must_fix : 0);
    } else {
      // L1: single agent
      const raw = await agent({
        prompt: [
          "Review plan requirements for Phase 2.",
          "",
          "Topic directory: " + topicDir,
          "Round: " + round,
          "",
          "Instructions:",
          "1. Read " + topicDir + "/plan.md and " + topicDir + "/spec.md",
          "2. Evaluate plan feasibility, deliverable completeness, Execution Group quality",
          "3. Check Task List covers all spec Acceptance Criteria",
          "4. Write detailed review to: " + reviewsDir + "/plan_review_v" + round + ".md",
          "5. YAML frontmatter: verdict (pass/fail), must_fix (count)",
          "",
          "Report findings as structured JSON.",
        ].join("\n"),
        agent: "plan-requirements-reviewer",
        schema: reviewSchema,
        description: "phase2-plan-review-r" + round,
      });
      const parsed = parseResult(raw);
      totalMustFix = parsed.must_fix >= 0 ? parsed.must_fix : 0;
    }

    if (totalMustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0 };
    }

    // Stagnation check
    if (lastMustFix >= 0 && totalMustFix >= lastMustFix) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        return {
          passed: false,
          rounds: round,
          lastMustFix: totalMustFix,
          stagnation: true,
        };
      }
    } else {
      stagnationCount = 0;
    }
    lastMustFix = totalMustFix;
  }

  return {
    passed: false,
    rounds: maxRounds,
    lastMustFix: lastMustFix,
    maxRounds: true,
  };
})();
