# @zhushanwen/pi-unified-hooks

## 0.1.0

### Minor Changes

- Add subagent-list-injector hook to inject available subagent list into system prompt

## 0.0.5

### Patch Changes

- 5c35364: fix: replace console.log/info with console.warn to prevent input area leak

  - model-switch/advisor.ts: replace console.info with silent fallback
  - unified-hooks/tool-error-handler.ts: replace console.log with console.warn
  - unified-hooks/index.ts: replace console.log with console.warn
  - Add §10 logging standard to pi-extension-standards.md
  - Add pre-commit hook to detect console.log/info violations

## 0.0.4

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.0.3

### Patch Changes

- 4de6d3a: i18n adaptation: replace all hardcoded Chinese strings with English across 7 extensions
