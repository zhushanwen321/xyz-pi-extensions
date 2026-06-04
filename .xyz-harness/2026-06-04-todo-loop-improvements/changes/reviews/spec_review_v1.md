---
review:
  type: spec_review
  round: 1
  target: ".xyz-harness/2026-06-04-todo-loop-improvements/spec.md"
  verdict: fail
  must_fix: 1
  summary: "Verification data chain broken: verifyText not exposed to AI context. 1 MUST FIX, 4 LOW, 2 INFO."
---

# Spec Review — todo-loop-improvements (Round 1)

## Summary
Spec is well-structured with clear FRs, ACs, and constraints. One critical issue: verifyText content is declared in the data model but never exposed to the AI, making the verification feature non-functional.

## Issues Found

### MUST FIX
| # | Severity | Location | Title | Status |
|---|----------|----------|-------|--------|
| 1 | MUST_FIX | FR-4 / FR-1 | AI cannot read verifyText content to perform verification | open |

### LOW
| # | Severity | Location | Title | Status |
|---|----------|----------|-------|--------|
| 2 | LOW | FR-2 | verifyTexts length exceeded silently ignored | open |
| 3 | LOW | AC-4.1 | auto clear '2 turns after' start timing ambiguous | open |
| 4 | LOW | FR-4 | REMINDER_INTERVAL vs STALL_THRESHOLD gradient unclear | open |
| 5 | LOW | FR-5 | Context re-injection on session restore not discussed | open |

### INFO
| # | Severity | Location | Title | Status |
|---|----------|----------|-------|--------|
| 6 | INFO | FR-6 | Message type name not specified | open |
| 7 | INFO | FR-1~3 | [VERIFIED] marker meaning not explained | open |

## Conclusion
1 MUST FIX blocks approval. Once verifyText exposure is fixed (spec update), re-review required.
