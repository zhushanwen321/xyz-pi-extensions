---
name: workflow-script-format
description: >-
  Reference for writing workflow JS scripts. Auto-loaded when using workflow-generate
  or writing/editing workflow scripts for Pi. Covers runtime environment, injected
  globals, constraints, and script patterns. Not for general coding or subagent usage.
---

# Workflow Script Format Reference

## Runtime Environment

- Script runs inside an **async IIFE in a Worker thread**. Top-level await IS supported.
- **DO NOT use `import`/`export` (ESM) syntax**. Use `require()` for Node.js built-ins.
- The script's **`return` value IS captured** and sent back to the main thread.

## Required: Meta Declaration

Every script MUST declare `meta` at the top level:

```javascript
const meta = { name: 'workflow-name', description: '...', phases: ['phase1', 'phase2'] };
```

`name` must match the filename stem. `phases` is for display only.

## Injected Globals (pre-defined, do NOT redeclare)

### `agent(opts)` — Call an AI agent

Returns `parsedOutput` (structured data when schema provided) or `content` (string).

```javascript
const result = await agent({
  prompt: 'Analyze this code',
  schema: { type: 'object', properties: { score: { type: 'number' } } },
  model: 'anthropic/claude-sonnet-4',
  description: 'code-analysis'
});
```

### `parallel(calls)` — Run multiple agent calls concurrently

```javascript
const [r1, r2, r3] = await parallel([
  agent({ prompt: 'Review file A', description: 'review-a' }),
  agent({ prompt: 'Review file B', description: 'review-b' }),
  agent({ prompt: 'Review file C', description: 'review-c' }),
]);
```

No concurrency limit — be mindful of API rate limits.

### `pipeline(stages)` — Execute stages sequentially

Each stage receives the previous stage's result.

```javascript
const final = await pipeline([
  () => agent({ prompt: 'Analyze code', description: 'analyze' }),
  (prev) => agent({ prompt: `Write tests for: ${prev}`, description: 'test-gen' }),
]);
```

### Other globals

- `$ARGS` — Object with workflow arguments (from `--args key=val`)
- `$WORKSPACE` — Absolute path to the project workspace root
- `$BUDGET` — Budget info: `{ usedTokens, usedCost, maxTokens?, maxTimeMs? }`

## Constraints

- `agent()` calls **must be deterministic in order** for pause/resume to work correctly.
- `parallel()` has no concurrency limit — be mindful of API rate limits.
- Throwing an error aborts the workflow (after retries).
- Use `require()` for Node.js built-ins: `const fs = require('node:fs');`

## Complete Example

```javascript
const meta = { name: 'pre-commit-check', description: 'Run tsc + lint + test', phases: ['check'] };

const [tscResult, lintResult] = await parallel([
  agent({ prompt: 'Run npx tsc --noEmit and report errors', description: 'tsc' }),
  agent({ prompt: 'Run pnpm lint and report errors', description: 'lint' }),
]);

const testResult = await agent({ prompt: 'Run pnpm test and report results', description: 'test' });

return {
  tsc: tscResult.includes('error') ? 'failed' : 'passed',
  lint: lintResult.includes('error') ? 'failed' : 'passed',
  test: testResult.includes('FAIL') ? 'failed' : 'passed',
};
```

## Script Size Guideline

Keep scripts under **100 lines**. Scripts are orchestration glue, not business logic.
If a script exceeds 100 lines, split into multiple smaller workflow scripts.
