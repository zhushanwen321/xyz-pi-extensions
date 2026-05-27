import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "last-activity";

function formatElapsed(now: number, last: number): string {
  const diff = now - last;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function lastActivityHook(pi: ExtensionAPI) {
  let lastTimestamp = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.on("agent_end", async (_event, ctx) => {
    lastTimestamp = Date.now();
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `last ${formatTime(lastTimestamp)}`),
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    if (timer) clearInterval(timer);

    timer = setInterval(() => {
      if (lastTimestamp === 0) return;
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("dim", `last ${formatTime(lastTimestamp)} (${formatElapsed(Date.now(), lastTimestamp)})`),
      );
    }, 10_000);
  });

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
