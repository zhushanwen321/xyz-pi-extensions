# ADR-030: Subagents-Workflow Package Merge & Execution Chain Unification

**Status**: accepted
**Date**: 2026-07-10
**Topic**: swf-merge-exec-chain (T1)
**From**: [from: swf-merge-exec-chain T1 包结构合并 + 执行链统一]

## Context

@zhushanwen/pi-subagents and @zhushanwen/pi-workflow shared ~1200 lines of duplicate code
(pi-runner, agent-discovery, concurrency-gate, execution-record, jsonl-to-agent-event,
extractYamlField). Both packages independently spawned Pi subprocesses via separate code paths.

## Decision

1. Merge both packages into @zhushanwen/pi-subagents-workflow with a three-layer architecture
   (interface/orchestration/execution)
2. Unify the execution chain: SubprocessAgentRunner delegates to SubagentService.executeAndAwait
   instead of independently spawning Pi
3. Eliminate duplicate code per D-A7 classification table
4. Keep old packages unchanged (D-004)

## Consequences

- Single spawn path: session-runner.runSpawn is the sole Pi subprocess spawn point
- executeAndAwait provides sync-await interface for orchestration layer while internally
  using background pipeline (no followUp injection, nesting guardrail)
- T2 (delete sync mode, pool layering, notification merge) and T3 (prefab scripts, docs,
  old-package deprecation) deferred to subsequent topics
