---
"@zhushanwen/pi-evolve-daily": minor
---

Replace passive skill tracking with `use_skill` active declaration. The tracker now requires agents to explicitly declare skill execution intent, eliminating false positives from SKILL.md reads. State machine simplified to 6 states (`loaded`, `completed`, `error`, `cancelled`, `recorded`, `abandoned`) with `cancelled` replacing the old `dismissed` state. Added `skill-registry.ts` for skill name validation and updated steering prompts to reference `use_skill`.
