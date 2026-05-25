/**
 * coding-workflow.js — xyz-harness 5-phase coding workflow
 *
 * Runs on the Pi Workflow Extension worker thread.
 * Globals injected by runtime: agent(), parallel(), pipeline(),
 * $ARGS, $WORKSPACE, $BUDGET.
 *
 * Usage: /workflow run coding-workflow --args requirement="..."
 */

const meta = {
  name: "coding-workflow",
  description: "5-phase coding workflow: spec → plan → dev → test → pr",
  phases: ["spec", "plan", "dev", "test", "pr"],
};

// ── Constants ────────────────────────────────────────────────

const HOME = require("node:os").homedir();
const SKILLS_DIR = `${HOME}/.pi/agent/skills`;
const GATE_SCRIPT = `${HOME}/.pi/agent/extensions/coding-workflow/gate-check.py`;
const MAX_GATE_RETRIES = 3;

// ── Helpers ──────────────────────────────────────────────────

/** Format today's date as YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Generate a slug from the requirement text */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);
}

/**
 * Run gate-check.py and return { passed, failures }.
 * Retries up to MAX_GATE_RETRIES on script execution failure.
 */
async function runGateCheck(topicDir, phase) {
  const { execFileSync } = require("node:child_process");
  let lastError;
  for (let attempt = 1; attempt <= MAX_GATE_RETRIES; attempt++) {
    try {
      const stdout = execFileSync("python3", [GATE_SCRIPT, topicDir, String(phase), "--json"], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    } catch (err) {
      lastError = err;
      // Non-zero exit = gate FAIL, parse stderr/stdout for details
      if (err.status === 1 && err.stdout) {
        try {
          return JSON.parse(err.stdout);
        } catch (_) { /* fall through to retry */ }
      }
    }
  }
  return { passed: false, failures: [`gate-check.py execution failed: ${lastError?.message}`] };
}

/** Parse YAML frontmatter verdict + must_fix from a review file */
function parseReviewVerdict(reviewPath) {
  const fs = require("node:fs");
  if (!fs.existsSync(reviewPath)) return { verdict: "fail", mustFix: -1 };
  const content = fs.readFileSync(reviewPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { verdict: "fail", mustFix: -1 };
  const yaml = fmMatch[1];
  const vMatch = yaml.match(/^verdict:\s*"?([^"\s\n]+)"?\s*$/m);
  const mMatch = yaml.match(/^must_fix:\s*(\d+)/m);
  return {
    verdict: vMatch?.[1] || "fail",
    mustFix: parseInt(mMatch?.[1] ?? "-1", 10),
  };
}

// ── Phase Runners ────────────────────────────────────────────

async function runPhase1_spec(topicDir, requirement) {
  // Step 1: Brainstorming + write spec
  await agent({
    prompt: [
      `You are executing Phase 1 (Spec) of the xyz-harness coding workflow.`,
      ``,
      `## Context`,
      `- Requirement: ${requirement}`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      ``,
      `## Instructions`,
      `1. First read the skill file at ${SKILLS_DIR}/xyz-harness-brainstorming/SKILL.md`,
      `2. Follow the skill's instructions to explore the requirement interactively`,
      `3. Write the spec.md file to ${topicDir}/spec.md with YAML frontmatter (verdict: pass)`,
      `4. The spec must include: overview, requirements, acceptance criteria, technical constraints`,
      `5. Ensure spec.md has complete, testable acceptance criteria (not vague)`,
      ``,
      `## Skill Reference`,
      `Read ${SKILLS_DIR}/xyz-harness-brainstorming/SKILL.md and follow its Phase 1 instructions.`,
      `Since this is non-interactive (auto mode), make reasonable assumptions and document them as [TBD].`,
    ].join("\n"),
    description: "Phase 1: brainstorming + write spec",
  });

  // Step 2: Expert review
  await agent({
    prompt: [
      `You are a spec reviewer for the xyz-harness workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      ``,
      `## Instructions`,
      `1. Read the expert reviewer skill at ${SKILLS_DIR}/xyz-harness-expert-reviewer/SKILL.md`,
      `2. Read the spec at ${topicDir}/spec.md`,
      `3. Perform a plan review (spec review mode) as described in the skill`,
      `4. Write the review to ${topicDir}/changes/reviews/spec_review_v1.md`,
      `   - YAML frontmatter: phase: spec, verdict: pass/fail, must_fix: <number>`,
      `   - Include findings, suggestions, and verdict`,
      `5. If must_fix > 0, update spec.md to address the issues, then write spec_review_v2.md`,
      `6. Repeat until must_fix = 0 and verdict = pass`,
    ].join("\n"),
    description: "Phase 1: spec expert review",
  });
}

async function runPhase2_plan(topicDir) {
  await agent({
    prompt: [
      `You are executing Phase 2 (Plan) of the xyz-harness coding workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      `- Spec file: ${topicDir}/spec.md (already completed in Phase 1)`,
      ``,
      `## Instructions`,
      `1. Read the skill file at ${SKILLS_DIR}/xyz-harness-writing-plans/SKILL.md`,
      `2. Read the spec at ${topicDir}/spec.md`,
      `3. Follow the skill instructions to create:`,
      `   - ${topicDir}/plan.md (with YAML frontmatter: verdict: pass)`,
      `   - ${topicDir}/e2e-test-plan.md (with YAML frontmatter: verdict: pass)`,
      `   - ${topicDir}/test_cases_template.json (with test_cases array, each having id/type/title)`,
      `4. Plan must cover all spec requirements; each task should be completable by one subagent`,
    ].join("\n"),
    description: "Phase 2: write plan + e2e + test cases",
  });

  // Expert review
  await agent({
    prompt: [
      `You are a plan reviewer for the xyz-harness workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      ``,
      `## Instructions`,
      `1. Read the expert reviewer skill at ${SKILLS_DIR}/xyz-harness-expert-reviewer/SKILL.md`,
      `2. Read ${topicDir}/spec.md and ${topicDir}/plan.md`,
      `3. Perform a plan review as described in the skill`,
      `4. Write the review to ${topicDir}/changes/reviews/plan_review_v1.md`,
      `   - YAML frontmatter: phase: plan, verdict: pass/fail, must_fix: <number>`,
      `5. If must_fix > 0, fix plan.md and e2e-test-plan.md, then write plan_review_v2.md`,
      `6. Repeat until must_fix = 0 and verdict = pass`,
    ].join("\n"),
    description: "Phase 2: plan expert review",
  });
}

async function runPhase3_dev(topicDir) {
  await agent({
    prompt: [
      `You are executing Phase 3 (Dev) of the xyz-harness coding workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      `- Spec: ${topicDir}/spec.md`,
      `- Plan: ${topicDir}/plan.md`,
      `- Test cases: ${topicDir}/test_cases_template.json`,
      ``,
      `## Instructions`,
      `1. Read the skill file at ${SKILLS_DIR}/xyz-harness-phase-dev/SKILL.md`,
      `2. Read spec.md and plan.md to understand the full context`,
      `3. Implement each task from plan.md following TDD approach`,
      `4. Run all tests and ensure they pass`,
      `5. Write ${topicDir}/changes/evidence/test_results.md with YAML frontmatter:`,
      `   verdict: pass, all_passing: true, linter_passed: true`,
      `6. Run linter/type-check if applicable and include results`,
      `7. Ensure code follows project CLAUDE.md conventions`,
    ].join("\n"),
    description: "Phase 3: implement code + run tests",
  });

  // Code review
  await agent({
    prompt: [
      `You are a code reviewer for the xyz-harness workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      `- Spec: ${topicDir}/spec.md`,
      ``,
      `## Instructions`,
      `1. Read the expert reviewer skill at ${SKILLS_DIR}/xyz-harness-expert-reviewer/SKILL.md`,
      `2. Read ${topicDir}/spec.md`,
      `3. Run \`git diff main\` or \`git diff origin/main\` in the workspace to see all code changes`,
      `4. Perform a code review as described in the skill`,
      `5. Write the review to ${topicDir}/changes/reviews/code_review_v1.md`,
      `   - YAML frontmatter: phase: dev, verdict: pass/fail, must_fix: <number>`,
      `6. If must_fix > 0, fix the code issues, re-run tests, update test_results.md, write code_review_v2.md`,
      `7. Repeat until must_fix = 0 and verdict = pass`,
    ].join("\n"),
    description: "Phase 3: code expert review",
  });
}

async function runPhase4_test(topicDir) {
  await agent({
    prompt: [
      `You are executing Phase 4 (Test) of the xyz-harness coding workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      `- Spec: ${topicDir}/spec.md`,
      `- Test cases template: ${topicDir}/test_cases_template.json`,
      `- Dev evidence: ${topicDir}/changes/evidence/test_results.md`,
      ``,
      `## Instructions`,
      `1. Read the skill file at ${SKILLS_DIR}/xyz-harness-phase-test/SKILL.md`,
      `2. Read test_cases_template.json to get all test case IDs`,
      `3. Execute each test case against the implemented code`,
      `4. For failed cases, fix the code and re-execute (increment round number)`,
      `5. Write ${topicDir}/changes/evidence/test_execution.json with format:`,
      `   { "test_execution": [{ caseId, round, passed, execute_steps: [...], verification_method }] }`,
      `6. Final round must have all cases passing`,
      `7. All template case IDs must be covered in execution records`,
    ].join("\n"),
    description: "Phase 4: execute integration tests",
  });
}

async function runPhase5_pr(topicDir) {
  await agent({
    prompt: [
      `You are executing Phase 5 (PR) of the xyz-harness coding workflow.`,
      ``,
      `## Context`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      `- Spec: ${topicDir}/spec.md`,
      ``,
      `## Instructions`,
      `1. Read the skill file at ${SKILLS_DIR}/xyz-harness-phase-pr/SKILL.md`,
      `2. Commit all changes with descriptive messages`,
      `3. Push the branch to remote`,
      `4. Create a Pull Request using gh CLI`,
      `5. Wait for CI to complete`,
      `6. Write ${topicDir}/changes/evidence/pr_evidence.md with YAML frontmatter:`,
      `   pr_created: true, pr_url: <url>, branch: <name>`,
      `7. Write ${topicDir}/changes/evidence/ci_results.md with YAML frontmatter:`,
      `   ci_passed: true, ci_url: <url>`,
      `8. If CI fails, fix issues, push again, update ci_results.md`,
      `9. Do NOT merge — merge happens only after manual verification`,
    ].join("\n"),
    description: "Phase 5: commit, push, create PR",
  });
}

// ── Gate + Review + Retrospect per phase ─────────────────────

async function gateAndReview(topicDir, phase, phaseName) {
  const reviewDir = `${topicDir}/changes/reviews`;
  const gateReviewPath = `${reviewDir}/gate_review_${phase}.md`;

  for (let attempt = 1; attempt <= MAX_GATE_RETRIES; attempt++) {
    // Gate check via gate-check.py
    const gateResult = await runGateCheck(topicDir, phase);
    if (!gateResult.passed) {
      if (attempt >= MAX_GATE_RETRIES) {
        throw new Error(
          `Phase ${phase} (${phaseName}) gate FAILED (attempt ${attempt}):\n` +
          (gateResult.failures || []).map((f) => `  - ${f}`).join("\n")
        );
      }
      // Dispatch fix agent and retry
      await agent({
        prompt: [
          `Gate check for Phase ${phase} (${phaseName}) FAILED with these issues:`,
          (gateResult.failures || []).map((f) => `- ${f}`).join("\n"),
          ``,
          `Fix these issues in ${topicDir}, then the gate will be re-checked.`,
          `Workspace: ${$WORKSPACE}`,
        ].join("\n"),
        description: `Phase ${phase}: fix gate failures (attempt ${attempt})`,
      });
      continue;
    }

    // Anti-fraud gate review
    await agent({
      prompt: [
        `You are the gate anti-fraud reviewer for the xyz-harness workflow.`,
        ``,
        `## Context`,
        `- Phase: ${phase} (${phaseName})`,
        `- Topic directory: ${topicDir}`,
        `- Workspace: ${$WORKSPACE}`,
        ``,
        `## Instructions`,
        `1. Read the gate reviewer skill at ${SKILLS_DIR}/xyz-harness-gate-reviewer/SKILL.md`,
        `2. Read ALL deliverable files for Phase ${phase} in ${topicDir}`,
        `3. Verify deliverables are genuine (not fabricated):`,
        `   - Phase 1: spec.md — check for real content, not just framework`,
        `   - Phase 2: plan.md, e2e-test-plan.md — check tasks map to spec requirements`,
        `   - Phase 3: test_results.md + code — check tests were actually run`,
        `   - Phase 4: test_execution.json — check records match real test execution`,
        `   - Phase 5: pr_evidence.md + ci_results.md — check PR and CI are real`,
        `4. Write ${gateReviewPath}`,
        `   - YAML frontmatter: phase: ${phaseName}, verdict: pass/fail, must_fix: <number>`,
        `5. Only report issues you are CERTAIN about (no guessing)`,
      ].join("\n"),
      description: `Phase ${phase}: gate anti-fraud review`,
    });

    // Parse review verdict
    const { verdict, mustFix } = parseReviewVerdict(gateReviewPath);
    if (verdict === "pass" && mustFix === 0) {
      return; // success
    }
    if (attempt >= MAX_GATE_RETRIES) {
      throw new Error(
        `Phase ${phase} (${phaseName}) gate review FAILED (verdict=${verdict}, must_fix=${mustFix})`
      );
    }
    // Dispatch fix agent for review issues
    await agent({
      prompt: [
        `Gate anti-fraud review for Phase ${phase} (${phaseName}) found ${mustFix} MUST_FIX issues.`,
        `Read ${gateReviewPath} for details.`,
        ``,
        `Fix these issues in ${topicDir}, then the gate will be re-checked.`,
        `Workspace: ${$WORKSPACE}`,
      ].join("\n"),
      description: `Phase ${phase}: fix gate review issues (attempt ${attempt})`,
    });
  }
}

async function retrospect(topicDir, phase, phaseName, isOverall) {
  const reviewDir = `${topicDir}/changes/reviews`;
  const fileName = isOverall ? "overall_retrospect.md" : `${phaseName}_retrospect.md`;

  const phaseList = isOverall
    ? "Phase 1 (spec), Phase 2 (plan), Phase 3 (dev), Phase 4 (test), Phase 5 (pr)"
    : `Phase ${phase} (${phaseName})`;

  const extraFiles = isOverall
    ? [
        `Also read these previous retrospective files (if they exist):`,
        `  - ${reviewDir}/spec_retrospect.md`,
        `  - ${reviewDir}/plan_retrospect.md`,
        `  - ${reviewDir}/dev_retrospect.md`,
        `  - ${reviewDir}/test_retrospect.md`,
      ].join("\n")
    : "";

  await agent({
    prompt: [
      `You are writing a retrospective for the xyz-harness workflow.`,
      ``,
      `## Context`,
      `- Phase: ${phaseList}`,
      `- Topic directory: ${topicDir}`,
      `- Workspace: ${$WORKSPACE}`,
      ``,
      `## Instructions`,
      `1. Read the retrospect skill at ${SKILLS_DIR}/harness-retrospect/SKILL.md`,
      `2. Read all deliverable files in ${topicDir}`,
      `${extraFiles}`,
      `3. Follow the skill instructions to write the retrospective`,
      `4. Output to: ${reviewDir}/${fileName}`,
      `5. YAML frontmatter: phase: ${isOverall ? "overall" : phaseName}, verdict: pass`,
    ].join("\n"),
    description: `Phase ${phase}: ${isOverall ? "overall" : phaseName} retrospect`,
  });
}

// ── Main ─────────────────────────────────────────────────────

(async () => {
  const requirement = $ARGS.requirement;
  if (!requirement) {
    throw new Error("Missing required argument: --args requirement=\"...\"");
  }

  const slug = slugify($ARGS.slug || requirement);
  const topicDir = `${$WORKSPACE}/.xyz-harness/${today()}-${slug}`;

  // Ensure directory structure
  await agent({
    prompt: [
      `Create the following directory structure under ${topicDir}:`,
      `  ${topicDir}/changes/reviews/`,
      `  ${topicDir}/changes/evidence/`,
      `Use: mkdir -p ${topicDir}/changes/reviews ${topicDir}/changes/evidence`,
    ].join("\n"),
    description: "Create topic directory structure",
  });

  const phases = [
    { num: 1, name: "spec",  run: () => runPhase1_spec(topicDir, requirement) },
    { num: 2, name: "plan",  run: () => runPhase2_plan(topicDir) },
    { num: 3, name: "dev",   run: () => runPhase3_dev(topicDir) },
    { num: 4, name: "test",  run: () => runPhase4_test(topicDir) },
    { num: 5, name: "pr",    run: () => runPhase5_pr(topicDir) },
  ];

  for (const phase of phases) {
    // Execute phase work
    await phase.run();

    // Gate check + anti-fraud review
    await gateAndReview(topicDir, phase.num, phase.name);

    // Retrospect (Phase 5 gets both per-phase + overall)
    await retrospect(topicDir, phase.num, phase.name, false);
    if (phase.num === 5) {
      await retrospect(topicDir, phase.num, "overall", true);
    }
  }

  return {
    topicDir,
    slug,
    phases: phases.map((p) => p.name),
    status: "completed",
  };
})();
