---
"@zhushanwen/pi-model-switch": patch
---

Fix config path mismatch and add v1 config migration. The extension was looking for config at `~/.pi/agent/extensions/model-switch/model-policy.json` but the actual file is at `~/.pi/agent/model-policy.json`. Also adds v1→v2 config format migration, proactive model switching triggers in promptSnippet, and specific action recommendations in context injection.
