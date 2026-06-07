const meta = { name: 'review-fix-loop-v2', description: 'Loop: code review → fix → commit until no must-fix issues remain', phases: ['review-fix-loop'] };

const MAX_ROUNDS = 10;
let round = 0;

while (round < MAX_ROUNDS) {
  round++;

  // Step 1: Review + Fix + Commit in one agent call
  const result = await agent({
    prompt: [
      `Review-Fix Loop Round ${round}/${MAX_ROUNDS}`,
      '',
      'You are in a review-fix loop. For this round:',
      '',
      '1. REVIEW: Run `git diff main...HEAD` to see all changes. Review for:',
      '   - Business logic errors (wrong behavior, missing edge cases)',
      '   - Type safety violations (any, missing types)',
      '   - Test coverage gaps',
      '   - Spec conformance issues',
      '   - Code quality (magic numbers, dead code, duplicated logic)',
      '',
      '2. FIX: For each MUST-fix issue, fix it now. Use edit tool to make changes.',
      '',
      '3. COMMIT: After all fixes, commit with message: `fix: review round ${round} — <brief summary>`',
      '   If no fixes needed, skip commit.',
      '',
      '4. REPORT: Output the structured JSON with exact counts.',
      '',
      'IMPORTANT:',
      '- Only count issues found during THIS round of review (not fixes applied)',
      '- mustFix = issues that MUST be fixed before merge (bugs, type errors, spec violations)',
      '- suggestions = nice-to-have improvements that were NOT fixed this round',
      '- The mustFix count is the count BEFORE you fix them, representing what was found',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        mustFix: {
          type: 'number',
          description: 'Number of MUST-fix issues found in this review round (before fixes were applied)',
        },
        suggestions: {
          type: 'number',
          description: 'Number of suggestion-level issues found (not fixed this round)',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what was reviewed and fixed',
        },
        fixed: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of issues that were fixed in this round',
        },
      },
      required: ['mustFix', 'summary'],
    },
    description: `review-fix-round-${round}`,
  });

  console.log(`Round ${round}: mustFix=${result.mustFix}, suggestions=${result.suggestions ?? 0}, summary="${result.summary}"`);

  // Step 2: Loop termination check
  if (result.mustFix === 0) {
    console.log(`No must-fix issues found after round ${round}. Loop complete.`);
    break;
  }

  console.log(`Found ${result.mustFix} must-fix issues. Continuing to round ${round + 1}...`);
}

const finalDiff = await agent({
  prompt: 'Run `git diff main...HEAD --stat` and summarize the total changes across all review rounds.',
  schema: {
    type: 'object',
    properties: {
      filesChanged: { type: 'number' },
      totalSummary: { type: 'string' },
    },
    required: ['filesChanged', 'totalSummary'],
  },
  description: 'final-summary',
});

return { rounds: round, maxRounds: MAX_ROUNDS, filesChanged: finalDiff.filesChanged, summary: finalDiff.totalSummary };
