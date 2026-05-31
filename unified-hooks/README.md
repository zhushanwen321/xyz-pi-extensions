# unified-hooks — Unified Hooks Extension

Collect scattered hooks in one place for easy maintenance. Each hook is a self-contained module that can be enabled/disabled independently.

## Installation

```bash
ln -s /path/to/xyz-pi-extensions/unified-hooks ~/.pi/agent/extensions/unified-hooks
```

## Available Hooks

### edit-whitespace-autofix

When edit tool fails due to whitespace mismatch, injects a steering message that tells the AI to fix whitespace and retry.

**Trigger patterns:**
- `Could not find the exact text`
- `oldText must match exactly`
- `Could not find edits[`

**Behavior:**
1. Detect whitespace mismatch error from edit tool
2. Extract the file path from tool args
3. Inject steer message with `fix_whitespace.py --fix <file>` command
4. AI automatically fixes whitespace and retries the edit

### tool-error-handler

Logs all tool execution errors to console for debugging.

## Adding New Hooks

1. Create `src/hooks/my-hook.ts`:
   ```typescript
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

   export function setupMyHook(pi: ExtensionAPI): void {
     pi.on("tool_execution_end", async (event) => {
       if (event.toolName === "edit" && event.isError) {
         // Your logic
       }
     });
   }
   ```

2. Register in `src/index.ts` hookModules array

3. Type check: `npx tsc --noEmit`

## Important API Notes

- Use `pi.sendUserMessage()` in event handlers, **not** `ctx.sendUserMessage()` (only available in command context)
- `tool_execution_end` event has `{ toolCallId, toolName, args, result, isError }`
- Inject direct instructions in steer messages, don't try to invoke `/skill-name` via text
