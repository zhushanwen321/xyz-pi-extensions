---
verdict: pass
---

# E2E Test Plan — Skill & Agent Usage Tracker

## Test Scenarios

### TS-1: Skill Full-Text Load Counting (AC-1)

**Objective:** Verify that reading a skill's SKILL.md file increments the skill's counter in usage-stats.json.

**Preconditions:**
- usage-tracker extension installed
- At least one skill available (e.g., usage-analyzer)
- usage-stats.json may or may not exist

**Steps:**
1. Start a new Pi session
2. Ask Pi to read the SKILL.md file of an available skill (e.g., "read the usage-analyzer skill")
3. After Pi completes the read, check `~/.pi/agent/usage-stats.json`
4. Verify the `skills` field contains an entry for the skill with count ≥ 1

**Expected:** Counter increments for each skill full-text read.

### TS-2: Agent Invocation Counting (AC-2)

**Objective:** Verify that calling a subagent increments the agent's counter.

**Preconditions:**
- usage-tracker extension installed
- subagent tool available

**Steps:**
1. Start a new Pi session
2. Trigger a single-mode subagent call (e.g., delegate a task to "general-purpose")
3. Check `~/.pi/agent/usage-stats.json` — verify the agent count ≥ 1
4. Trigger a parallel-mode subagent call with 2+ agents (e.g., tasks: [{agent: "a"}, {agent: "b"}])
5. Verify each agent in the parallel call has its own counter incremented
6. Trigger a chain-mode subagent call with 2+ agents (e.g., chain: [{agent: "a"}, {agent: "b"}])
7. Verify each agent in the chain has its own counter incremented

**Expected:** Counter increments for each agent invocation in all three modes (single, parallel, chain).

### TS-3: Multi-Session Accumulation (AC-3)

**Objective:** Verify that multiple sessions accumulate counts without overwriting.

**Preconditions:**
- usage-tracker extension installed
- Two sequential Pi sessions

**Steps:**
1. Session 1: Read a skill file → verify count = 1
2. End Session 1
3. Session 2: Read the same skill file → verify count = 2

**Expected:** Counts accumulate across sessions. No overwrite.

### TS-4: Write Failure Resilience (AC-4)

**Objective:** Verify that file write failure does not crash Pi.

**Preconditions:**
- usage-tracker extension installed
- Ability to make stats file path unwritable

**Steps:**
1. Make `~/.pi/agent/usage-stats.json` read-only (`chmod 000`)
2. Start Pi session and trigger a skill read
3. Verify Pi continues to function normally
4. Verify stderr contains `[usage-tracker] Failed to write stats` message
5. Restore permissions (`chmod 644`)

**Expected:** Pi runs without error. Failure logged to stderr.

### TS-5: Usage Analyzer Skill (AC-5)

**Objective:** Verify the usage-analyzer skill guides agent to produce analysis.

**Preconditions:**
- usage-analyzer skill installed
- usage-stats.json has non-empty data

**Steps:**
1. Ask Pi "analyze my skill usage" or "what skills am I not using?"
2. Verify Pi loads the usage-analyzer skill
3. Verify Pi reads `~/.pi/agent/usage-stats.json`
4. Verify Pi produces a structured report with rankings and recommendations

**Expected:** Agent reads data file and produces analysis per skill framework.

### TS-6: No Tool/Command Registration (AC-6)

**Objective:** Verify extension does not register any tool, command, or widget.

**Preconditions:**
- usage-tracker extension installed

**Steps:**
1. Start Pi session
2. Check that no new tool named "usage-tracker" or "usage-stats" appears in available tools
3. Check that no new command "/usage" or "/usage-stats" appears

**Expected:** Extension is invisible to user except via data file.

## Test Environment

- Pi agent running locally
- `~/.pi/agent/usage-stats.json` (auto-created by extension)
- Available skills and agents for triggering counting
- File permission manipulation for TS-4
