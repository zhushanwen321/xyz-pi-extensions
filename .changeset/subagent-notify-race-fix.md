---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix non-deterministic loss of subagent completion notifications.

Subagent completion notifications are delivered via a detached microtask
calling `sendMessage({ triggerTurn: true, deliverAs: "steer" })`. When this
microtask lands inside the main agent's `agent_end` → `finishRun` race window
(`isStreaming` still `true`), pi's `sendCustomMessage` takes the steer branch:
the message is enqueued into `steeringQueue`, but the run loop has already
ended and nothing drains the queue — the notification is silently dropped and
the main agent never produces a follow-up turn.

Fix: add an `isIdle()` gate in `BgNotifier.flushPendingNotifications`. When the
main agent is still streaming, flush backs off (`setTimeout` 100ms) and retries
until idle, then sends synchronously. Because `isIdle()` and `sendMessage`
share the same synchronous read of `agent.state.isStreaming` (host.sendMessage
does not await), once `isIdle` returns `true` the subsequent `sendMessage` is
guaranteed to hit the `triggerTurn` branch and start a new turn. A backoff cap
(50 × 100ms = 5s) forces a fallback send to avoid notification starvation when
the main agent stays busy for a long turn.

`isIdle` is injected from `ctx.isIdle()` in `session_start`, threaded through
`SubagentService` → `piAdapter()` → `NotifierHost`. It is optional, so legacy
hosts without it keep the original immediate-send behavior.
