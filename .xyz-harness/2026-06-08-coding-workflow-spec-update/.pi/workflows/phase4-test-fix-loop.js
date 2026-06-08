const meta = { name: "phase4-test-fix-loop", description: "Phase 4 Test-Fix Loop (core -> noncore)" };

(async () => {
  const { topicDir } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-4`;

  async function runTestFixLoop(scope) {
    let lastFailed = -1;
    let stagCount = 0;

    for (let round = 1; round <= 10; round++) {
      const stateFile = `${reviewsDir}/test-execute-v${round}-${scope}.json`;

      // Coordinator constructs JSON + dispatches Wave
      await agent({
        prompt: `Construct ${scope} test-execute v${round}. Read test_cases_template.json, filter phase=4 ${scope} cases.`,
        agent: "test-execute-coordinator",
        description: `coordinator-${scope}-r${round}`,
      });

      // Wave parallel testing (up to 3 subagents per wave)
      const result = await agent({
        prompt: `Execute ${scope} test Wave (round ${round}). Update ${stateFile}.`,
        agent: "test-case-subagent",
        description: `test-execution-${scope}-r${round}`,
      });

      const { failed, passed, skipped } = await parseSummary(result);

      if (failed > 0) {
        await agent({
          prompt: `Fix ${scope} failed cases (round ${round}).`,
          agent: "test-fix-worker",
          description: `fix-worker-${scope}-r${round}`,
        });
      }

      if (failed === 0) {
        return { passed: true, round };
      }

      if (lastFailed >= 0 && failed >= lastFailed) {
        stagCount++;
        if (stagCount >= 3) {
          return { passed: false, stagnation: true, round };
        }
      }
      lastFailed = failed;
    }

    return { passed: false, maxRounds: true };
  }

  const core = await runTestFixLoop("core");
  if (!core.passed) return { core, noncore: null };

  const noncore = await runTestFixLoop("noncore");
  return { core, noncore };
})();

async function parseSummary(resultStr) {
  try {
    const data = JSON.parse(resultStr);
    return {
      failed: data.summary?.failed || 0,
      passed: data.summary?.passed || 0,
      skipped: data.summary?.skipped || 0,
    };
  } catch {
    return { failed: 0, passed: 0, skipped: 0 };
  }
}
