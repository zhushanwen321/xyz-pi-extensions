---
"@zhushanwen/pi-scheduler": patch
---

Fix cron expression parsing in /schedule command: add quote-aware tokenizer so quoted cron expressions (e.g. `cron '*/10 * * * *' prompt`) are correctly handled.
