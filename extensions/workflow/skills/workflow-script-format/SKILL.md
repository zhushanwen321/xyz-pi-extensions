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

**[MANDATORY] Structured output rule:** When you need JSON/structured data from an agent, you MUST pass `schema`. The `schema` parameter triggers a tool-call mechanism where the LLM calls a `structured-output` tool to return validated JSON — this is reliable. NEVER ask the agent to "output JSON in a code block" or use regex to extract JSON from text.

```javascript
// ✅ CORRECT: use schema parameter — returns parsed JS object directly
const result = await agent({
  prompt: 'Analyze this code and rate it',
  schema: {
    type: 'object',
    properties: {
      score: { type: 'number' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['score'],
  },
  description: 'code-analysis',
});
// result is already a parsed object: { score: 8, issues: [...] }
```

```javascript
// ❌ WRONG: prompt-based JSON extraction — fragile, LLM often wraps in markdown
const result = await agent({ prompt: 'Analyze code. Output JSON: { "score": N }' });
// result is a string, you'd need regex to extract — DON'T do this
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

### `description` naming convention [MANDATORY]

`description` 用作 TUI 显示的 agent 标识，必须简短可读。规则：kebab-case，单词间用 `-` 分隔，不含 round/iteration 后缀。

```javascript
// ✅ CORRECT: kebab-case，单词间用 - 分隔
agent({ prompt: '...', description: 'review-business-logic' });
agent({ prompt: '...', description: 'fix-imports' });
agent({ prompt: '...', description: 'parse-must-fix' });

// ❌ WRONG: 无分隔符拼接（不可读）
agent({ prompt: '...', description: 'reviewbusinesslogic' });
agent({ prompt: '...', description: 'fiximports' });

// ❌ WRONG: 冗长描述（不是 label 用途）
agent({ prompt: '...', description: 'Review business logic against spec requirements' });

// ❌ WRONG: 不必要的 round/iteration 后缀（TUI 自带序号）
agent({ prompt: '...', description: 'review-business-logic-round-1' });
// ✅ CORRECT: 去掉 round 后缀
agent({ prompt: '...', description: 'review-business-logic' });
```

## Constraints

- `agent()` calls **must be deterministic in order** for pause/resume to work correctly.
- `parallel()` has no concurrency limit — be mindful of API rate limits.
- Throwing an error aborts the workflow (after retries).
- Use `require()` for Node.js built-ins: `const fs = require('node:fs');`

## Complete Example

```javascript
const meta = { name: 'review-fix-loop', description: 'Loop: review → fix → commit until clean', phases: ['review-fix'] };

const MAX_ROUNDS = 10;
let round = 0;

while (round < MAX_ROUNDS) {
  round++;
  const result = await agent({
    prompt: `Round ${round}: Review git diff main...HEAD. Fix all issues. Commit with: fix: review round ${round}.`,
    schema: {
      type: 'object',
      properties: {
        mustFix: { type: 'number', description: 'Number of MUST-fix issues found' },
        suggestions: { type: 'number', description: 'Number of suggestions' },
        summary: { type: 'string' },
      },
      required: ['mustFix'],
    },
    description: `review-${round}`,
  });

  // result is already a parsed object thanks to schema
  if (result.mustFix === 0) break;
}

return { rounds: round, clean: true };
```

## Script Size Guideline

Keep scripts under **100 lines**. Scripts are orchestration glue, not business logic.
If a script exceeds 100 lines, split into multiple smaller workflow scripts.

## Verification Patterns

Workflow nodes should be **verifiable** — every critical execution path needs a check that the AI's output is correct. Two patterns are supported:

### Pattern A: Node-Internal Verification

Embed self-check instructions directly in the prompt and require a structured output that includes validation. Best for: trivial classification, single-step lookups, format checks.

```javascript
// Example: classify severity of a code review finding
const result = await agent({
  prompt: `Classify the severity of this finding: "${findingText}".
The selfCheck field MUST reflect whether severity and reason are both present and consistent.`,
  schema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
      selfCheck: { type: 'object', properties: { valid: { type: 'boolean' }, reason: { type: 'string' } } },
    },
    required: ['severity', 'reason', 'selfCheck'],
  },
  description: 'classify-severity',
});

if (!result.selfCheck.valid) {
  throw new Error(`self-check failed: ${result.selfCheck.reason}`);
}
```

**Pros:** Single call, low overhead. **Cons:** Self-check is part of the same call — AI can lie about validation.

### Pattern B: Follow-up Verify Node

A second `agent()` call that explicitly verifies the previous result. Best for: critical mutations, data transforms, anything where errors propagate downstream.

```javascript
// Example: review a file, then verify the review is complete
const review = await agent({
  prompt: `Review ${file} for issues. Report each finding with severity and reason.`,
  schema: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, reason: { type: 'string' } } } } },
    },
    required: ['findings'],
  },
  description: `review-${file}`,
});

const verify = await agent({
  prompt: `You are verifying a code review. The previous output was:
${JSON.stringify(review)}
Did the review cover: (1) all functions in the file, (2) at least 3 potential issues, (3) severity rating for each?`,
  schema: {
    type: 'object',
    properties: {
      valid: { type: 'boolean' },
      missingItems: { type: 'array', items: { type: 'string' } },
    },
    required: ['valid'],
  },
  description: `verify-review-${file}`,
});

if (!verify.valid) {
  throw new Error(`verification failed for ${file}: ${verify.missingItems.join(', ')}`);
}
```

**Pros:** Independent check, harder to game. **Cons:** Doubles agent calls.

### Decision Tree

```
Is the step a critical data transform or mutation?
├─ YES → Use Pattern B (follow-up verify)
└─ NO
   ├─ Trivial classification / format check?
   │  └─ YES → Use Pattern A (node-internal)
   └─ Read-only / informational?
      └─ No verification needed
```

### Anti-pattern

- **Never skip verification entirely on critical execution paths** — even with strong prompts, AI outputs are probabilistic. A verify step catches hallucinations before they propagate.
