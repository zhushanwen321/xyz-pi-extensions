# Bug: `setActiveTools(undefined)` throws "toolNames is not iterable"

## Summary

`pi.setActiveTools(undefined)` throws `TypeError: toolNames is not iterable`. The TypeScript declaration suggests `undefined` is a valid argument (to "restore all tools"), but the runtime implementation does not handle it.

## Reproduction

```typescript
// In any extension:
pi.setActiveTools(undefined);
// → TypeError: toolNames is not iterable
```

**Real-world trigger**: An extension restricts tools during a "plan mode" (`pi.setActiveTools(["read", "bash", "grep", "find", "ls", "plan"])`), then tries to restore all tools when exiting that mode by calling `pi.setActiveTools(undefined)`.

## Root Cause

In `agent-session.js`, `setActiveToolsByName` directly iterates the parameter without a null/undefined guard:

```javascript
// agent-session.js:568
setActiveToolsByName(toolNames) {
    const tools = [];
    const validToolNames = [];
    for (const name of toolNames) {  // ← TypeError when toolNames is undefined
        // ...
    }
}
```

The call chain is: `pi.setActiveTools(toolNames)` → `runtime.setActiveTools(toolNames)` → `agentSession.setActiveToolsByName(toolNames)` — no layer handles the `undefined` case.

## Expected Behavior

Either:

1. **(Preferred)** `setActiveTools(undefined)` / `setActiveTools(null)` restores all registered tools (the "reset to default" semantic that extensions naturally expect), OR
2. The TypeScript declaration is corrected to `setActiveTools(toolNames: string[]): void` (no `undefined`) and the docs clarify that extensions must call `pi.getAllTools()` to restore the full set.

Option 1 is better because "restrict tools → restore all" is a common pattern. Extensions shouldn't need to know the full tool list at restore time — the registry already has that information.

## Suggested Fix

```javascript
setActiveToolsByName(toolNames) {
    // Restore all tools when undefined/null is passed
    if (toolNames == null) {
        toolNames = Array.from(this._toolRegistry.keys());
    }
    const tools = [];
    const validToolNames = [];
    for (const name of toolNames) {
        // ... existing logic unchanged
    }
}
```

## Environment

- Pi version: 0.79.1
- `@earendil-works/pi-coding-agent` 0.79.1

## Workaround (extension-side)

```typescript
// Instead of:
pi.setActiveTools(undefined);

// Use:
pi.setActiveTools(pi.getAllTools().map(t => t.name));
```
