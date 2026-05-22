---
verdict: pass
must_fix: 0
---

# Code Review — Subagent TUI 渲染统一与优化

## Review Summary

All 8 functional requirements from the spec are implemented correctly. Changes are confined to two files (render.ts, index.ts). Type check passes (0 errors), lint passes (0 errors).

## Spec Compliance

| F | Requirement | Verification | Status |
|---|-------------|-------------|--------|
| F1 | 3-line header (mode + session ID / agent + model + time / activity) | renderCall: `⏳ chain #shortId` + agents line + task previews; renderResult: all functions pass sessionShortId | ✅ |
| F2 | Real-time elapsed timer | `context.state.interval` guard with `setInterval(1s)` + `context.invalidate()`, cleanup on `!hasAnyRunning` | ✅ |
| F3 | Activity stream with text output, filter thinking | `getDisplayItems()` filters `part.type === "thinking"`, interleaves text/toolCall, `TEXT_PREVIEW_LINES=3` | ✅ |
| F4 | Execution order per mode | Single: simple header; Parallel: table with progress; Chain: numbered steps + ○⏳✅ icons | ✅ |
| F5 | Collapsible with per-mode constants | `COLLAPSED_ITEM_COUNT=10`, `CHAIN_COLLAPSED_ITEM_COUNT=5` | ✅ |
| F6 | Remove collect_subagent | Tool registration + params type + 3 description references removed; cleanup method retained | ✅ |
| F7 | Unified renderCall | All modes: `⏳` + mode + `#shortId` + agents + model/thinking | ✅ |
| F8 | Semantic status icons | `STATUS_ICONS`/`STATUS_COLORS` maps (⏳/warning, ✅/success, ❌/error, ○/muted) | ✅ |

## Code Quality

### Positive Findings
1. **Timer guard pattern correct**: Uses `!ctxState.timerInterval` for dedup, matching bash.ts proven pattern. Avoids the module-level `isDone` anti-pattern.
2. **Session isolation respected**: `capturedSessionId` is scoped inside the extension factory function closure, not at module level.
3. **Minimal diff**: Only touches 2 files, no unrelated changes.
4. **Backward compatible**: render functions accept optional `sessionShortId`/`elapsed` params with defaults.
5. **Clean removal**: `collect_subagent` removal removes the tool registration and 3 description references, but keeps `spawnManager.cleanupAllJobs()` in `session_shutdown`.

### Areas Reviewed
- No `any` types introduced ✅
- No `Promise.all` where `Promise.allSettled` should be used ✅ (no new promises)
- `setInterval` properly cleaned up ✅
- No hardcoded ANSI codes — uses `theme.fg()` semantic tokens ✅
- No silencing of catches ✅
- No unbounded while loops ✅

## Conclusion

**Verdict: pass. MUST FIX: 0.** All changes match the spec, type-check, lint-clean, and follow project conventions.
