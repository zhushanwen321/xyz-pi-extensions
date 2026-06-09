export const meta = {
  name: 'review-fix-loop',
  description: 'Review-fix loop: run code-review skill, fix issues, repeat until clean or max iterations',
  phases: [
    { title: 'Review', detail: 'Run code-review skill and produce structured report' },
    { title: 'Fix', detail: 'Fix all must-fix issues from review report' },
  ],
}

const MAX = (typeof args === 'number' ? args : args?.maxIterations) ?? 10
let totalFixed = 0
let done = 0
let clean = false

for (let round = 0; round < MAX; round++) {
  done = round + 1
  log(`--- Iteration ${done}/${MAX} ---`)

  // === Node 1: Review ===
  phase('Review')
  const rPath = `/tmp/review-fix-loop/report-${done}.md`

  const rv = await agent(
    [
      `Iteration ${done} of a review-fix loop.`,
      ``,
      `1. Invoke the Skill tool with: { "skill": "code-review", "args": "high" }`,
      `   This will review the current git diff at high effort.`,
      ``,
      `2. After the review completes, write ALL findings to ${rPath} as markdown.`,
      `   The file MUST contain:`,
      `   - Title: "# Review Report - Iteration ${done}"`,
      `   - A "## Summary" section with the explicit must-fix count`,
      `   - Each finding with: file path, line range, description, severity`,
      `   - Severity is one of: "must-fix" (bugs, security, logic errors, crashes) or "nice-to-have" (style, naming, perf)`,
      ``,
      `3. Finally, call the StructuredOutput tool with exactly:`,
      `   { "review-report": "${rPath}", "must-fix": <the count of must-fix issues> }`,
      ``,
      `If the review finds zero issues, write a report saying "No issues found" and set must-fix to 0.`,
    ].join('\n'),
    {
      label: `review-${done}`,
      phase: 'Review',
      schema: {
        type: 'object',
        properties: {
          'review-report': { type: 'string', description: 'Absolute path to the review report markdown file' },
          'must-fix': { type: 'number', description: 'Count of must-fix issues found' },
        },
        required: ['review-report', 'must-fix'],
      },
    }
  )

  if (!rv) { log('Review agent failed, stopping.'); break }

  const n = rv['must-fix']
  log(`Found ${n} must-fix issue(s). Report: ${rv['review-report']}`)

  // === Node 2: Judge ===
  if (n === 0) { clean = true; log('Code is clean!'); break }

  // === Node 3: Fix ===
  phase('Fix')
  log(`Fixing ${n} must-fix issue(s) from ${rv['review-report']}...`)

  const fx = await agent(
    [
      `Read the review report at: ${rv['review-report']}`,
      ``,
      `Fix ALL must-fix issues listed in the report.`,
      `For each issue:`,
      `1. Read the relevant source file`,
      `2. Apply the MINIMAL correct fix (no refactoring, no style changes)`,
      `3. Ensure the fix does not break surrounding code`,
      ``,
      `After fixing all issues, list every change you made (file:line -> what was fixed).`,
    ].join('\n'),
    { label: `fix-${done}`, phase: 'Fix' }
  )

  if (!fx) { log('Fix agent failed, stopping.'); break }

  totalFixed += n
  log(`Fixed ${n} issue(s). Total fixed: ${totalFixed}. Continuing to next review iteration...`)
}

log(`\n=== Loop Complete ===`)

return {
  iterations: done,
  maxIterations: MAX,
  totalFixed,
  clean,
  message: clean
    ? `Code clean after ${done} iteration(s). ${totalFixed} issue(s) fixed total.`
    : `Loop ended after ${done} iteration(s). ${totalFixed} issue(s) fixed. May have remaining issues.`,
}
