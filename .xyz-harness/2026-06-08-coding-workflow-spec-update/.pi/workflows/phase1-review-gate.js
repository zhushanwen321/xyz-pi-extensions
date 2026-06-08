const meta = { name: "phase1-review-gate", description: "Phase 1 Spec Review-Gate" };

(async () => {
  const { topicDir } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-1`;
  let lastMustFix = -1;

  for (let round = 1; round <= 3; round++) {
    await agent({
      prompt: `Review ${topicDir}/spec.md (round ${round}).\n` +
        `1. Read spec.md\n` +
        `2. Check completeness, consistency, clarity, scope, YAGNI\n` +
        `3. Fix simple issues directly in spec.md\n` +
        `4. Write review to: ${reviewsDir}/spec_review_v${round}.md\n` +
        `5. YAML frontmatter: verdict (pass/fail), must_fix (number)`,
      agent: "spec-requirements-reviewer",
      description: `spec-review-r${round}`,
    });

    // Read review file to extract must_fix
    const reviewPath = `${reviewsDir}/spec_review_v${round}.md`;
    const reviewContent = await agent({
      prompt: `Read ${reviewPath} and return only the must_fix count as a number. If file not found or no must_fix, return 0.`,
      description: `parse-spec-review-r${round}`,
    });

    const mustFix = parseInt(reviewContent.trim(), 10) || 0;

    if (mustFix <= 0) {
      return {
        passed: true,
        rounds: round,
        lastMustFix: 0,
        reviewPath,
      };
    }

    if (lastMustFix >= 0 && mustFix >= lastMustFix) {
      return {
        passed: false,
        rounds: round,
        lastMustFix: mustFix,
        stagnation: true,
        reviewPath,
      };
    }
    lastMustFix = mustFix;
  }

  return {
    passed: false,
    rounds: 3,
    lastMustFix,
    maxRounds: true,
    reviewPath: `${reviewsDir}/spec_review_v3.md`,
  };
})();
