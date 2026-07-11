// src/index.ts
//
// @zhushanwen/pi-workflow — DEPRECATED
// Superseded by @zhushanwen/pi-subagent-workflow (ADR-030).
// This stub only emits a deprecation warning and registers no tools.
// Migrate: pi install npm:@zhushanwen/pi-subagent-workflow

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function workflowExtension(_pi: ExtensionAPI): void {
  console.warn(
    "[pi-workflow] DEPRECATED: This package is superseded by @zhushanwen/pi-subagent-workflow (ADR-030). " +
      "Run: pi install npm:@zhushanwen/pi-subagent-workflow",
  );
}
