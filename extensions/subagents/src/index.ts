// src/index.ts
//
// @zhushanwen/pi-subagents — DEPRECATED
// Superseded by @zhushanwen/pi-subagent-workflow (ADR-030).
// This stub only emits a deprecation warning and registers no tools.
// Migrate: pi install npm:@zhushanwen/pi-subagent-workflow

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function subagentsExtension(_pi: ExtensionAPI): void {
  console.warn(
    "[pi-subagents] DEPRECATED: This package is superseded by @zhushanwen/pi-subagent-workflow (ADR-030). " +
      "Run: pi install npm:@zhushanwen/pi-subagent-workflow",
  );
}
