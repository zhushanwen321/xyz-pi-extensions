---
"@zhushanwen/pi-evolve-daily": patch
"@zhushanwen/pi-subagents": patch
---

Fix stale skill-state prompts after navigate/fork + improve background subagent notifications.

**evolve-daily**: Stop spurious "skills being tracked" prompts after navigate/fork/clone. Three root causes fixed:
- Cross-branch state bleed: `reconstructState` now reads only the current branch path (`getBranch()`) instead of all entries from every branch.
- Immediate injection on fork: `handleSessionRestore` no longer triggers a turn on session switch; `before_agent_start` injects on the user's next message instead.
- Abandoned-item zombie prompts: abandoned items are no longer surfaced in the prompt list (only loaded/error).

**subagents**: Background completion notification improvements:
- Fix background color break after ellipsis (truncLine's `\x1b[0m` global reset was clearing the purple background mid-line).
- Shorten head line: use `shortId` instead of full job id, truncate model name.
- Add rounded purple border (`╭─╮│╰─╯`) matching the workflow notify visual style.
