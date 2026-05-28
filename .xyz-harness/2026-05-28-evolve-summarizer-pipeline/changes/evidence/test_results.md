---
verdict: pass
all_passing: true
---

# Test Results — Evolve Summarizer Pipeline

## Test Execution Summary

All **13** test cases from `test_cases_template.json` executed and passed.

| Result | Count |
|--------|-------|
| ✅ PASS | 13 |
| ❌ FAIL | 0 |

See `test_execution.json` for detailed per-case evidence.

## Key Results

### Compression Ratio
- Raw report: **545KB** (retrospective-2026-05-27.json, 673 sessions)
- Signal report: **6.1KB**
- Compression ratio: **89x** (1.1% of original)

### Anomaly Detection
- Tool failure detection: ✅ (found at 35% error rate)
- Dormant skill detection: ✅ (flagged 12+ unused skills)
- Token hotspot detection: ✅
- User correction anomaly: ✅

### Data Pipeline
- Metrics snapshot extraction: ✅ (all 22 fields populated)
- Metrics history sliding window (30 max): ✅
- Trend delta filtering (10% threshold): ✅
- Effect review building: ✅ (before/after comparison)
- GC retention policies: ✅ (reports: 3 max, daily: 90 days)

## TypeScript Type Check

```
cd evolution-engine && npx tsc --noEmit
```
**0 errors. All types valid.**

## ESLint

```
cd xyz-pi-extensions && npm run lint
```
**0 errors in evolution-engine/** (pre-existing errors in other packages only).

## Files Impacted

| File | Lines | Type |
|------|-------|------|
| `evolution-engine/src/summarizer.ts` | ~400 | new |
| `evolution-engine/src/effect-tracker.ts` | ~157 | new |
| `evolution-engine/src/gc.ts` | ~124 | new |
| `evolution-engine/src/types.ts` | +69 | modified |
| `evolution-engine/src/state.ts` | +53 | modified |
| `evolution-engine/src/judge.ts` | +82/-47 | modified |
| `evolution-engine/src/commands.ts` | +51/-14 | modified |
| `evolution-engine/src/templates/session-quality.txt` | updated | modified |
| `evolution-engine/src/index.ts` | +7 | modified |