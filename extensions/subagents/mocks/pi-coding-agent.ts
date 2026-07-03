// mocks/pi-coding-agent.ts
//
// Vitest mock for @mariozechner/pi-coding-agent value exports.
// The shared/types stub only provides type declarations (ambient module),
// but index.ts imports getAgentDir as a value. This mock provides the runtime value.

export function getAgentDir(): string {
  return "/home/user/.pi/agent";
}
