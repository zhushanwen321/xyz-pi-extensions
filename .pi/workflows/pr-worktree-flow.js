const meta = {
  name: 'pr-worktree-flow',
  description: 'Parallel validation (tsc + lint + test) then create PR if all pass',
  phases: ['validate', 'create-pr']
};

const cwd = $WORKSPACE;

// Phase 1: Validate — three independent checks in parallel
const [tscResult, lintResult, testResult] = await parallel([
  {
    prompt: `Run TypeScript type check. Execute: cd ${cwd} && npx tsc --noEmit 2>&1
Report concisely: "PASS" or "FAIL: N errors" followed by the first 10 errors with file:line.`,
    description: 'tsc type check'
  },
  {
    prompt: `Run ESLint on all source files. Execute: cd ${cwd} && npx eslint extensions/ shared/ --max-warnings 0 2>&1
Report concisely: "PASS" or "FAIL: N errors, N warnings" followed by the first 10 issues.`,
    description: 'lint check'
  },
  {
    prompt: `Run tests. Execute: cd ${cwd} && pnpm -r test 2>&1
Report concisely: "PASS: N tests" or "FAIL: N passed, N failed" followed by failed test names.`,
    description: 'unit tests'
  }
]);

// Phase 2: Create PR — only if all validations passed
const prResult = await agent({
  prompt: [
    `Create a PR for the current branch.`,
    ``,
    `Steps:`,
    `1. cd ${cwd}`,
    `2. Detect current branch: git branch --show-current`,
    `3. Detect latest commit message: git log -1 --format=%s`,
    `4. Detect diff summary: git diff --stat origin/main...HEAD`,
    `5. Run: bash ~/.claude/skills/pr-worktree/pr-worktree.sh`,
    `6. Report the PR number and URL`,
    ``,
    `Validation results from Phase 1:`,
    `- tsc: ${String(tscResult).slice(0, 300)}`,
    `- lint: ${String(lintResult).slice(0, 300)}`,
    `- test: ${String(testResult).slice(0, 300)}`,
    ``,
    `If any validation failed, report the failures and do NOT create the PR.`,
    `If all passed, proceed with pr-worktree.sh. Use the detected commit message as title.`,
  ].join('\n'),
  description: 'create PR'
});

return {
  tsc: tscResult,
  lint: lintResult,
  test: testResult,
  pr: prResult
};
