const meta = { name: "phase2-review-gate", description: "Phase 2 Plan Review-Gate" };

(async () => {
  const { topicDir, complexity = "L1" } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-2`;
  let lastMustFix = -1;

  for (let round = 1; round <= 3; round++) {
    // L1: single reviewer / L2: two serial reviewers
    if (complexity === "L1") {
      await agent({
        prompt: `Review plan deliverables (round ${round}).\n` +
          `Read: plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md\n` +
          `Write review to: ${reviewsDir}/plan_review_v${round}.md`,
        agent: "plan-requirements-reviewer",
        description: `plan-review-r${round}`,
      });
    } else {
      await agent({
        prompt: `Review plan deliverables (round ${round}, L2 first pass).\n` +
          `Read: plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md\n` +
          `Write review to: ${reviewsDir}/plan_review_v${round}.md`,
        agent: "plan-requirements-reviewer",
        description: `plan-review-r${round}-p1`,
      });
      await agent({
        prompt: `L2 business logic review (round ${round}, second pass).\n` +
          `Read: spec.md, plan.md, interface_chain.json, use-cases.md\n` +
          `Write review to: ${reviewsDir}/plan_bl_review_v${round}.md`,
        agent: "plan-bl-requirements-reviewer",
        description: `plan-bl-review-r${round}`,
      });
    }

    // Parse must_fix from review file(s)
    const reviewPath = `${reviewsDir}/plan_review_v${round}.md`;
    const mustFix = await parseMustFix(reviewPath);

    if (mustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0, reviewPath };
    }

    if (lastMustFix >= 0 && mustFix >= lastMustFix) {
      return { passed: false, rounds: round, lastMustFix, stagnation: true, reviewPath };
    }
    lastMustFix = mustFix;
  }

  return { passed: false, rounds: 3, lastMustFix, maxRounds: true };
})();

async function parseMustFix(reviewPath) {
  const content = await agent({
    prompt: `Read ${reviewPath} and return only the must_fix count as a number. If not found, return 0.`,
    description: "parse-must-fix",
  });
  return parseInt(content.trim(), 10) || 0;
}
