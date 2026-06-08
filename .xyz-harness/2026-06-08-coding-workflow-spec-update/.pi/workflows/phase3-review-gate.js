const meta = { name: "phase3-review-gate", description: "Phase 3 Dev Review-Gate (3 stages)" };

(async () => {
  const { topicDir } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-3`;

  for (let outer = 1; outer <= 3; outer++) {
    // Stage 1: spec-plan conformance
    await agent({
      prompt: `Stage 1: Spec-plan conformance review (outer ${outer}).\n` +
        `Read: spec.md, plan.md, use-cases.md, git diff, source code\n` +
        `Write: ${reviewsDir}/spec_plan_conformance_v${outer}.md`,
      agent: "spec-plan-conformance-reviewer",
      description: `spec-plan-conformance-o${outer}`,
    });

    const s1Path = `${reviewsDir}/spec_plan_conformance_v${outer}.md`;
    const s1MustFix = await parseMustFix(s1Path);
    if (s1MustFix > 0) {
      return { passed: false, stage: 1, outer, mustFix: s1MustFix };
    }

    // Stage 1.5: simulated data generation
    await agent({
      prompt: `Stage 1.5: Generate simulated data based on ${s1Path}.`,
      agent: "simulated-data-generator",
      description: `simulated-data-o${outer}`,
    });

    // Stage 2: parallel reviewers + fix loop
    let lastMustFix = -1;
    let stagCount = 0;

    for (let inner = 1; inner <= 3; inner++) {
      // Parallel 5 reviewers
      const reviewersDir = `${reviewsDir}/phase-3`;
      const [std, taste, robust, fallow, integ] = await parallel([
        agent({
          prompt: `Standards review\nfiles: git diff --name-only main\ncwd: ${process.cwd()}\noutput: ${reviewersDir}/standards_review_v${outer}.md\nskill_path: ${process.cwd()}/skills/xyz-harness-standards-reviewer/SKILL.md`,
          agent: "review-standards",
          description: `standards-o${outer}-i${inner}`,
        }),
        agent({
          prompt: `Taste review\nfiles: git diff --name-only main\ncwd: ${process.cwd()}\noutput: ${reviewersDir}/taste_review_v${outer}.md\nskill_path: ${process.cwd()}/skills/xyz-harness-standards-reviewer/SKILL.md`,
          agent: "review-taste",
          description: `taste-o${outer}-i${inner}`,
        }),
        agent({
          prompt: `Robustness review\nfiles: git diff --name-only main\ncwd: ${process.cwd()}\noutput: ${reviewersDir}/robustness_review_v${outer}.md\nskill_path: ${process.cwd()}/skills/xyz-harness-robustness-reviewer/SKILL.md`,
          agent: "review-robustness",
          description: `robustness-o${outer}-i${inner}`,
        }),
        agent({
          prompt: `Fallow review\ncwd: ${process.cwd()}\noutput: ${reviewersDir}/fallow_review_v${outer}.md`,
          agent: "fallow-reviewer",
          description: `fallow-o${outer}-i${inner}`,
        }),
        agent({
          prompt: `Integration review\nfiles: git diff --name-only main\ncwd: ${process.cwd()}\noutput: ${reviewersDir}/integration_review_v${outer}.md\nskill_path: ${process.cwd()}/skills/xyz-harness-integration-reviewer/SKILL.md`,
          agent: "review-integration",
          description: `integration-o${outer}-i${inner}`,
        }),
      ]);

      // Fix worker aggregates
      const fixPlan = await agent({
        prompt: `Aggregate 5 reviewer results and generate fix plan.`,
        agent: "review-sync-fix-worker",
        description: `fix-worker-o${outer}-i${inner}`,
      });

      const mustFix = await parseMustFixFromJson(fixPlan);
      if (mustFix <= 0) {
        return { passed: true, outer, inner };
      }

      // Fix by file (serial)
      const files = await parseFilesFromFixPlan(fixPlan);
      for (const file of files) {
        await agent({
          prompt: `Fix issues in ${file.path}`,
          agent: "file-fix-subagent",
          description: `file-fix-${file.path}`,
        });
      }

      if (lastMustFix >= 0 && mustFix >= lastMustFix) {
        stagCount++;
        if (stagCount >= 2) {
          return { passed: false, stagnation: true, outer, inner };
        }
      }
      lastMustFix = mustFix;
    }
  }

  return { passed: false, maxOuter: true };
})();

async function parseMustFix(reviewPath) {
  const content = await agent({ prompt: `Read ${reviewPath}, return must_fix count only`, description: "parse-must-fix" });
  return parseInt(content.trim(), 10) || 0;
}

async function parseMustFixFromJson(jsonStr) {
  try { return JSON.parse(jsonStr).mustFix || 0; } catch { return 0; }
}

async function parseFilesFromFixPlan(jsonStr) {
  try { return JSON.parse(jsonStr).files || []; } catch { return []; }
}
