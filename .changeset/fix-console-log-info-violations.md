---
"@zhushanwen/pi-model-switch": patch
"@zhushanwen/pi-unified-hooks": patch
---

fix: replace console.log/info with console.warn to prevent input area leak

- model-switch/advisor.ts: replace console.info with silent fallback
- unified-hooks/tool-error-handler.ts: replace console.log with console.warn
- unified-hooks/index.ts: replace console.log with console.warn
- Add §10 logging standard to pi-extension-standards.md
- Add pre-commit hook to detect console.log/info violations
