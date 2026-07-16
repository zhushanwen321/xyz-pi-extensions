# @zhushanwen/pi-structured-output

## 0.3.3

### Patch Changes

- 96aed1d: Fix test infrastructure broken by workflow directory removal: give plan and structured-output their own self-contained mocks/ dirs (previously aliased the now-deleted ../workflow/mocks/\*). Update coding-workflow README to reference @zhushanwen/pi-subagent-workflow (replacing deprecated @zhushanwen/pi-workflow).

## 0.3.1

### Patch Changes

- Add positive/negative examples to tool description; fix schema param type to accept any JSON Schema shape

## 0.3.0

### Minor Changes

- structured-output: unconditional global tool (schema+data params), remove env-gated mode. workflow: remove text fallback, rely on tool call only.

## 0.2.2

### Patch Changes

- Fix pi.extensions path: ./src/index.ts → ./index.ts

## 0.2.1

### Patch Changes

- Fix 7 issues: inject schema into prompt/description, fix enforcement semantics, add retry cap, remove terminate flag, add Ajv WeakMap cache

## 0.2.0

### Minor Changes

- Initial release: structured-output tool for Pi with Ajv validation
