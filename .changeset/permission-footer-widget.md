---
"@zhushanwen/pi-permission": minor
"@zhushanwen/pi-statusline": minor
---

Permission footer migration + onboarding widget

- permission: removed self-managed footer, now registers footer line via globalThis Symbol handshake to statusline (solves footer single-slot conflict)
- permission: added status widget showing rule count + classifier model (auto mode)
- statusline: upgraded to footer canonical owner (footer-handshake-access.ts), buildLines aggregates external lines
- statusline: simplified line2 (speed/cache show current only, removed day marker)

BREAKING CHANGE for permission-only users (no statusline installed): footer mode label is no longer displayed. Install @zhushanwen/pi-statusline to restore, or use /permission status.
