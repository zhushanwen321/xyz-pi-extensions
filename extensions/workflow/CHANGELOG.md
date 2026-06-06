# @zhushanwen/pi-workflow

## 0.1.9

### Patch Changes

- f7367e8: Fix agent subprocess killed prematurely by 120s hard timeout. Increase to 24h safety net and add proper abort signal propagation on terminate/pause/abort.

## 0.1.8

### Patch Changes

- Fix model polling, widget rendering, and reduce complexity

## 0.1.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications
- Updated dependencies
  - @zhushanwen/pi-model-switch@0.2.6

## 0.1.5

### Patch Changes

- Add storage externalization, approval/verification gates, soft budget warning, and AgentPool optimizations

## 0.1.4

### Patch Changes

- Add auto/force mode to workflow-run tool with progressive discovery

## 0.1.3

### Patch Changes

- e19ed88: fix: remove hardcoded models and paths from review agents; fix Pi SDK type compat in evolve-daily and workflow

## 0.1.2

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
