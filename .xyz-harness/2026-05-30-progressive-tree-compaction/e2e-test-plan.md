---
verdict: pass
---

# E2E Test Plan — Progressive Tree Compaction

## Test Scenarios

### Scenario 1: Full cycle — start session → 30 user messages → compression triggers → tree appended

1. Start Pi session with infinite-context extension loaded
2. Send ~20 short user messages (each ~100 chars)
3. Verify: after context usage crosses 50%, a compact tree is created
4. Verify: the tree has `root.children` with groups covering the compressed segments
5. Send ~10 more user messages
6. Verify: second compression creates new groups appended to `root.children`
7. Verify: old groups remain unchanged

### Scenario 2: Dynamic retention window

1. Start with low context usage (< 50%)
2. Verify: no compression triggered
3. Increase context usage to 50-70% range
4. Verify: `getRetentionWindow(65)` returns 8 completed segments
5. Verify: first compression includes segments older than the 8 retained

### Scenario 3: Compression scope within ratio

1. Artificially create 20 segments with known digest sizes
2. Set retention to 2 segments (usage ratio 85%)
3. Call `computeCompressionScope()` with retention + 18 remaining segs
4. Verify: returned scope has estimated after/denominator ratio between 20-50%
5. Verify: if 18 segs still < 20%, all 18 are included

### Scenario 4: Append-only tree structure

1. Run first compression → tree has groups [A, B]
2. Run second compression → tree has groups [A, B, C, D]
3. Verify: groups A, B summaries are unchanged
4. Verify: groups C, D segIds correspond to the new segments
5. Verify: tree depth stays at 2 (root → group → leaf)

### Scenario 5: Compression failure → fallback

1. Kill the Pi subprocess during compression
2. Verify: `handleCompressionFailure` retries once
3. Verify: on second failure, `ruleBasedFallback` produces a valid tree
4. Verify: `fallbackUsed` flag is true
5. Verify: tree has all segments as individual leaf nodes

### Scenario 6: Low context — no compression

1. Maintain context usage < 50%
2. Send 30 user messages
3. Verify: no compact tree entries in session
4. Verify: `isCompressing()` never true
5. Verify: all messages remain in original form

### Scenario 7: Context injection includes all tree nodes

1. After compression, inspect `assembleMessages()` output
2. Verify: output contains recall prompt custom message
3. Verify: output contains one `ic-summary` custom message per tree node
4. Verify: leaf summary count matches number of compressed segments
5. Verify: no raw segment file content in the messages

### Scenario 8: Compression ratio stability (AC-5)

1. Prepare 3 sets of segments with known digest sizes (small, medium, large)
2. For each set, run `computeCompressionScope()` with controlled retention
3. Verify: estimated ratio (estimatedAfterTokens / denominator) ∈ [0.2, 0.5]
4. After actual LLM compression, compute actual ratio = actualTreeTokens / denominator
5. Verify: |actualRatio - estimatedRatio| ≤ 0.2 (≤ 20 percentage points deviation)
6. Repeat for all 3 sets

### Scenario 9: Context usage fluctuates

1. Start with 80% usage, retention = 2
2. Compression triggers, compresses oldest segments
3. Context usage drops to 40%
4. Send more messages, usage climbs back to 60%
5. Verify: second compression uses retention = 8 (not 2)
6. Verify: previously compressed segments are NOT re-compressed

## Test Environment

- Pi runtime with infinite-context extension registered
- A test Pi session with configurable context window (default 200K)
- Simulated user messages at varying lengths to control context usage
- Monitor: session entries (ic-segment, ic-compact-tree), `TreeCompactor` internal state, `ContextAssembler` output
- Use `getContextUsage()` mock or real Pi environment
