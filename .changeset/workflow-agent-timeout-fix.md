---
"@zhushanwen/pi-workflow": patch
---

Fix agent subprocess killed prematurely by 120s hard timeout. Increase to 24h safety net and add proper abort signal propagation on terminate/pause/abort.
