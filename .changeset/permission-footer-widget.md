---
"@zhushanwen/pi-permission": minor
"@zhushanwen/pi-statusline": patch
---

Permission footer migration + onboarding widget

- permission: removed self-managed footer, now registers footer line via globalThis Symbol handshake to statusline (solves footer single-slot conflict)
- permission: added status widget showing rule count + classifier model (auto mode, since removed — see hotfix below)
- statusline: upgraded to footer canonical owner (footer-handshake-access.ts), buildLines aggregates external lines
- statusline: simplified line2 (speed/cache show current only, removed day marker, since restored — see hotfix below)

# Hotfix — restore speed/cache day metrics + merge widget info into footer

Two regressions from W1/W2 fixed in patch (0.4.8 → 0.4.9):

- statusline: restore dual-value display for speed/cache (was oversimplified to current-only in W1):
  `speed 58t/s · day 70t/s` / `cache 96% · day 91%`. current=0/null hides whole segment.
- permission: delete the standalone widget (classifier model moved to a widget in W2, leaving footer
  with only mode + enabled); merge all info into the footer line:
  `[permission] auto · enabled · N user rule(s) · classifier: <model>`
  classifier shown only in auto mode with non-empty model.
- permission: replace `refreshWidget(ctx)` calls with `requestFooterRender()`.

BREAKING CHANGE for permission-only users (no statusline installed): footer mode label is no longer displayed. Install @zhushanwen/pi-statusline to restore, or use /permission status.
