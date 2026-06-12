---
"@zhushanwen/pi-todo": patch
---

Widget layout now switches between single and dual column based on Pi's widget line limit.

- Discovered Pi caps extension widgets at `InteractiveMode.MAX_WIDGET_LINES = 10` strings per widget.
- Todo widget reserves the header line and uses `max - 1 = 9` as the safe content budget.
- When the task count is 8 or fewer, the widget renders in a single column; 9 or more tasks switch to the existing dual-column layout to stay within the budget and avoid Pi's truncation.
