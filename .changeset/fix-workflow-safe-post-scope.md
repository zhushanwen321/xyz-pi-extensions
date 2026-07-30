---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix: all built-in workflows (parallel/chain/map-reduce/scatter-gather) crashed with "Worker exited with code 1".

Two root-cause bugs in `worker-script-builder.ts` (the generator of Worker-thread source code), both slipped through because existing tests were pure string `toContain` assertions that never executed the generated code:

1. **`_safePost` scope bug**: `_safePost` was declared inside the async IIFE but used in the outer `.then()`/`.catch()` return/error handlers (outside the IIFE scope). Every script `return` triggered `ReferenceError: _safePost is not defined` → Worker exit 1. Fix: hoist `_safePost` (and the `parentPort`/`workerData` handles) to module scope.

2. **`parallel()` Promise-array bug**: CC-compatible scripts write `parallel([agent({...}), ...])` passing an array of already-instantiated Promises. The implementation passed each Promise back into `agent()` as opts → `postMessage` `DataCloneError` → all agents rejected. Fix: thenable duck-type check at the top of the `parallel()` map callback to return in-flight Promises directly.

Also adds a three-layer test strategy (documented in `docs/extensions/subagents/testing.md`):
- **L2 runtime tests** (`worker-script-builder-runtime.test.ts`): spin up a real `node:worker_threads` Worker to execute the generated code, covering return/throw/agent/abort/workflow/execute paths plus the Promise-array regression.
- **L3 workflow E2E** (`workflows-e2e.test.ts`): run all 4 built-in workflows through the real `runAndWait` orchestration (real Worker thread + real scripts + real JsonlRunStore), mocking only the LLM `AgentRunner`. All 4 workflows now pass.
