// fallow-ignore-file unused-type — barrel export exposes Gate API for external consumers
export { type Gate, type GateContext, type GateResult } from "./gate.js";
export { ReviewGate } from "./review-gate.js";
export { PhaseGate } from "./phase-gate.js";
export { TestFixLoopGate } from "./test-fix-loop.js";
