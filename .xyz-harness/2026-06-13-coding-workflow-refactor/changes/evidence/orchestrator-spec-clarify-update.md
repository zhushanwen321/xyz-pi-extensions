# Review/Gate 4-Stage Model — Spec Update Evidence

## Summary

Updated orchestrator and spec-clarify-phase specs to reflect the new 4-stage gate model:
1. gate-check(scope=deliverables) → review-loop(dimensions) → gate-check(scope=reviews) → retrospect

## Key Changes

### orchestrator/spec.md
- PhaseConfig interface: added `dimensions: ReviewDimension[]` field
- ReviewDimension interface: id, name, reviewPrefix, systemPrompt, focusPrompt, threshold, mayNeedUser
- All 5 PHASE_CONFIGS updated to 4-stage pipeline with dimensions
- Phase 1: 4 dimensions (authenticity, completeness, consistency, sufficiency)
- Phase 2: 3 dimensions (feasibility, spec-conformance, test-plan-quality)
- Phase 3: 3 dimensions (spec-conformance, code-quality, taste)
- Phase 4/5: empty dimensions
- Gate tool handler: rewritten as 4-stage flow with NEEDS_USER support
- run-op StringEnum: 11 actions (review-dispatch removed)
- L1/L2 pipelines: 4-stage model (no standalone review-dispatch)
- OperationRegistry: 12 operations (not 13)

### spec-clarify-phase/spec.md
- FR-SC0: pipeline updated to 4-stage with dimension descriptions
- FR-SC5: L1/L2 system/subsystem pipelines updated to 4-stage
- All review-dispatch references replaced with review-loop
- Run-op action list: 11 actions (review-dispatch removed)
