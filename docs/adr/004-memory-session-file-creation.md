# ADR 004: Memory Session File Creation via copyFileSync

**Context:** Subagent memory mode needs to create a persistent session file co-located with the main session file, using a specific naming convention (`{basename}.mem-{id}.jsonl`). Pi's `--fork` CLI flag creates a new session but places it in the default session directory — we cannot control the file path or naming.

**Decision:** Use `fs.copyFileSync(mainSessionFile, memoryFilePath)` to create the initial memory session file. On subsequent calls, use `--session <memoryFilePath>` to resume.

**Reasoning:** `copyFileSync` gives us full control over the file path and naming convention. It produces a consistent snapshot of the main session at fork time. The alternative (`--fork` + move) is fragile and depends on Pi's internal session directory behavior. The trade-off is that the copied file retains the main session's UUID in its header, but `--session` opens any valid JSONL file regardless of header UUID.
