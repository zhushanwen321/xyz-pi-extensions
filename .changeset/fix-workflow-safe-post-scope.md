---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix: all built-in workflows (parallel/chain/map-reduce/scatter-gather) crashed with "Worker exited with code 1".

Root cause: `_safePost` was declared inside the async IIFE but used in the outer `.then()`/`.catch()` return/error handlers (outside the IIFE scope). Every script `return` triggered `ReferenceError: _safePost is not defined` → the `.catch` handler hit the same error → unhandled rejection → Worker thread exit 1 → `handleWorkerError` retried 3× → run marked `done (failed)`. Diagnostics were lost because `_safePost` (which carries `workerLogs` back) was itself the broken function.

Fix: hoist `_safePost` to module scope alongside `_workerLogs`/`_pushWorkerLog` (resolving `parentPort` via `_moduleParentPort` at module load), matching the original design intent stated in the comments.

Also adds a runtime regression test (`worker-script-builder-runtime.test.ts`) that spins up a real `node:worker_threads` Worker to execute the generated code — existing tests were pure string `toContain` assertions and never executed the worker, which is why this scope bug slipped through.
