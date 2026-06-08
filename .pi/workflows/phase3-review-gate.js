const meta = {
  name: "phase3-review-gate",
  description: "Phase 3 Dev Review-Gate: 3-stage nested review with fix loop",
};

// ── Schemas ────────────────────────────────────────────────────────

const stage1Schema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    mustFix: { type: "number" },
    reviewMetrics: {
      type: "object",
      properties: {
        specCoverage: { type: "number" },
        planCoverage: { type: "number" },
        acCoverage: { type: "number" },
        simulatedDataPaths: { type: "array", items: { type: "string" } },
      },
    },
  },
  required: ["verdict", "mustFix"],
};

const reviewerSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    mustFix: { type: "number" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
  required: ["verdict", "mustFix"],
};

const fixWorkerSchema = {
  type: "object",
  properties: {
    mustFix: { type: "number" },
    fileGroups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          issues: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
  required: ["mustFix"],
};

const fileFixSchema = {
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
// didn't apply, in which case the value is a string.
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return { verdict: "fail", mustFix: -1 };
}

function slugifyFile(filePath) {
  return String(filePath || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Build a Stage 2 reviewer prompt from a shared template.
function buildReviewerPrompt(kind, focus, reviewsDir, topicDir, outer, inner) {
  return [
    kind + " review (r" + outer + "-" + inner + ").",
    "Topic: " + topicDir,
    "Focus: " + focus + ".",
    "Write review to: " + reviewsDir + "/" + kind + "_review_v" + outer + "_" + inner + ".md",
  ].join("\n");
}

// ── Main ───────────────────────────────────────────────────────────

(async () => {
  const { topicDir, maxOuterRounds = 3, maxInnerRounds = 3 } = $ARGS;
  const reviewsDir = topicDir + "/changes/reviews/phase-3";

  for (let outer = 1; outer <= maxOuterRounds; outer++) {

    // ── STAGE 1: Spec-plan conformance ──────────────────────────
    const stage1Raw = await agent({
      prompt: [
        "Stage 1: Spec-plan conformance review for Phase 3.",
        "Topic directory: " + topicDir,
        "Outer round: " + outer,
        "",
        "1. Read " + topicDir + "/spec.md and " + topicDir + "/plan.md",
        "2. Inspect implementation under " + topicDir + "/changes/",
        "3. Verify implementation conforms to spec ACs and plan Task List",
        "4. Measure coverage (0..1): specCoverage, planCoverage, acCoverage",
        "5. If any AC lacks fixture data, list the data paths in simulatedDataPaths",
        "6. Write review to: " + reviewsDir + "/stage1_review_v" + outer + ".md",
        "7. YAML frontmatter: verdict (pass/fail), must_fix (number)",
        "",
        "Return JSON: { verdict, mustFix, reviewMetrics: { specCoverage, planCoverage, acCoverage, simulatedDataPaths } }",
      ].join("\n"),
      agent: "spec-plan-conformance-reviewer",
      schema: stage1Schema,
      description: "phase3-stage1-outer" + outer,
    });
    const stage1 = parseResult(stage1Raw);
    const stage1MustFix = (stage1 && typeof stage1.mustFix === "number") ? stage1.mustFix : -1;

    if (stage1.verdict !== "pass" || stage1MustFix > 0) {
      return { passed: false, stage: 1, outer: outer, lastMustFix: stage1MustFix };
    }

    // ── STAGE 1.5: Simulated data generation (conditional) ─────
    const simPaths = (stage1.reviewMetrics && Array.isArray(stage1.reviewMetrics.simulatedDataPaths))
      ? stage1.reviewMetrics.simulatedDataPaths
      : [];
    if (simPaths.length > 0) {
      await agent({
        prompt: [
          "Stage 1.5: Generate simulated test data for Phase 3.",
          "Topic directory: " + topicDir,
          "Paths to populate: " + simPaths.join(", "),
          "Create realistic fixture data at each path. Do not modify source code.",
        ].join("\n"),
        description: "phase3-stage1.5-outer" + outer,
      });
    }

    // ── STAGE 2: Code-quality review-fix loop ──────────────────
    let lastMustFix = -1;
    let stagnationCount = 0;

    for (let inner = 1; inner <= maxInnerRounds; inner++) {

      // Batch 1: 4 parallel reviewers. Pool maxConcurrency=4, so the
      // 5th reviewer (integration) must run as a separate agent().
      const batch1 = await parallel([
        {
          prompt: buildReviewerPrompt("standards", "coding conventions, type safety, file/function size limits, lint rules", reviewsDir, topicDir, outer, inner),
          agent: "review-standards",
          schema: reviewerSchema,
          description: "phase3-std-r" + outer + "-" + inner,
        },
        {
          prompt: buildReviewerPrompt("taste", "architecture, naming, abstraction quality, long-term maintainability", reviewsDir, topicDir, outer, inner),
          agent: "review-taste",
          schema: reviewerSchema,
          description: "phase3-taste-r" + outer + "-" + inner,
        },
        {
          prompt: buildReviewerPrompt("robustness", "error handling, edge cases, concurrency, resource cleanup", reviewsDir, topicDir, outer, inner),
          agent: "review-robustness",
          schema: reviewerSchema,
          description: "phase3-robust-r" + outer + "-" + inner,
        },
        {
          prompt: buildReviewerPrompt("fallow", "dead code, duplicate code, unused exports, stale comments", reviewsDir, topicDir, outer, inner),
          agent: "fallow-reviewer",
          schema: reviewerSchema,
          description: "phase3-fallow-r" + outer + "-" + inner,
        },
      ]);

      // Batch 2: integration reviewer (waits for a pool slot).
      const integration = parseResult(await agent({
        prompt: [
          "Integration review (r" + outer + "-" + inner + ").",
          "Topic: " + topicDir,
          "Focus: cross-module consistency, public API surface, exported types, breakage from this round's changes.",
          "Write review to: " + reviewsDir + "/integration_review_v" + outer + "_" + inner + ".md",
        ].join("\n"),
        agent: "review-integration",
        schema: reviewerSchema,
        description: "phase3-integ-r" + outer + "-" + inner,
      }));

      // All five reviews feed the fix worker.
      const allReviews = batch1.map(parseResult);
      allReviews.push(integration);

      // ── Fix worker: aggregate & group by file ───────────────
      const fixPlanRaw = await agent({
        prompt: [
          "Aggregate 5 reviewer reports into a fix plan for Phase 3.",
          "Topic directory: " + topicDir,
          "Round: outer=" + outer + " inner=" + inner,
          "Reviewer findings: " + JSON.stringify(allReviews),
          "",
          "1. Deduplicate overlapping must_fix issues across reviewers",
          "2. Group remaining issues by file path",
          "3. If no must_fix issues remain, set mustFix=0 and fileGroups=[]",
          "",
          "Return JSON: { mustFix: number, fileGroups: [{ file: string, issues: [{...}] }] }",
        ].join("\n"),
        schema: fixWorkerSchema,
        description: "phase3-fix-r" + outer + "-" + inner,
      });
      const fixPlan = parseResult(fixPlanRaw);
      const totalMustFix = (fixPlan && typeof fixPlan.mustFix === "number") ? fixPlan.mustFix : -1;

      if (totalMustFix <= 0) {
        return { passed: true, stage: 2, outer: outer, inner: inner, lastMustFix: 0 };
      }

      // ── Serial file fix loop (one agent per file) ───────────
      const groups = (fixPlan && Array.isArray(fixPlan.fileGroups)) ? fixPlan.fileGroups : [];
      for (const group of groups) {
        const file = (group && group.file) || "unknown";
        await agent({
          prompt: [
            "Fix file: " + file,
            "Topic directory: " + topicDir,
            "Round: outer=" + outer + " inner=" + inner,
            "Issues: " + JSON.stringify((group && group.issues) || []),
            "Apply fixes directly. Do not touch unrelated code.",
            "Return JSON: { fixed: number, remaining: number }.",
          ].join("\n"),
          schema: fileFixSchema,
          description: "phase3-fix-r" + outer + "-" + inner + "-" + slugifyFile(file),
        });
      }

      // Stagnation: 2 consecutive rounds with no decrease → early exit.
      if (lastMustFix >= 0 && totalMustFix >= lastMustFix) {
        stagnationCount++;
        if (stagnationCount >= 2) {
          return {
            passed: false,
            stage: 2,
            outer: outer,
            inner: inner,
            lastMustFix: totalMustFix,
            stagnation: true,
          };
        }
      } else {
        stagnationCount = 0;
      }
      lastMustFix = totalMustFix;
    }

    // Inner exhausted: stop here. Outer is only entered once because
    // the spec-plan recheck on a fresh changes/ tree is what each new
    // outer round would buy us, and a full restart is cheap.
    return { passed: false, stage: 2, outer: outer, lastMustFix: lastMustFix, maxInnerRounds: true };
  }

  return { passed: false, lastMustFix: -1, maxOuterRounds: true };
})();
