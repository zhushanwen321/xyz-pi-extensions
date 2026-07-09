/**
 * CW 状态机（D-009 主强制点）：声明式转换表 + 三重 guard + nextAction 组装。
 *
 * 三重校验（D-016 后）：
 *   1. checkLinear        — 线性 expectedStatus（currentState ∈ expectedStatuses[action]）
 *   2. checkPhaseCascade  — 跨阶段 gatePassed 级联（test 需 dev 全 Wave committed；retrospect 需 test 全 case passed）
 *   3. checkCacheConsistency — 从 gateHistory+waves+testCases 重算 gatePassed 与 topic 缓存比对（防篡改）
 *
 * guard 返回 GuardVerdict 对象，不 throw（DESIGN-IT-TWICE Agent2）。
 */

import type { CwStore } from "./store.js";
import type {
  CwAction,
  CwStatus,
  CwTopic,
  GuardVerdict,
  NextAction,
} from "./types.js";

// ── 声明式转换表（§4.2 architecture 的 1:1 编码，#2 方案 A） ──

export interface TransitionRule {
  /** 第一重：合法前置状态集（create 空=允许 topic=null）。 */
  expectedStatuses: CwStatus[];
  /** 流转后状态。 */
  nextStatus: CwStatus;
  /** 渐进式（dev/test）：已处 nextStatus 时态内推进，不再流转。 */
  progressive?: boolean;
  /** 第二重：跨阶段级联依赖（需该 phase gatePassed）。 */
  requirePhaseComplete?: CwAction;
}

export const TRANSITIONS: Partial<Record<CwAction, TransitionRule>> = {
  create: { expectedStatuses: [], nextStatus: "created" },
  plan: { expectedStatuses: ["created"], nextStatus: "planned" },
  clarify: { expectedStatuses: ["created"], nextStatus: "clarified" },
  detail: { expectedStatuses: ["clarified"], nextStatus: "detailed" },
  dev: {
    expectedStatuses: ["planned", "detailed", "developed"],
    nextStatus: "developed",
    progressive: true,
  },
  test: {
    expectedStatuses: ["developed", "tested"],
    nextStatus: "tested",
    progressive: true,
    requirePhaseComplete: "dev",
  },
  retrospect: {
    expectedStatuses: ["tested", "retrospected"],
    nextStatus: "retrospected",
    progressive: true,
    requirePhaseComplete: "test",
  },
  closeout: { expectedStatuses: ["retrospected"], nextStatus: "closed" },
};

// ── 三重 guard ───────────────────────────────────────────────

/** 第一重：线性 expectedStatus 校验。 */
export function checkLinear(
  action: CwAction,
  current: CwStatus | undefined,
): GuardVerdict {
  const rule = TRANSITIONS[action];
  if (!rule) {
    return { ok: false, code: "illegal_transition", reason: `unknown action: ${action}` };
  }
  // create 允许 current=undefined（无 topic）
  if (action === "create") {
    return { ok: true };
  }
  if (current === undefined) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `${action} requires existing topic (current=undefined)`,
    };
  }
  if (!rule.expectedStatuses.includes(current)) {
    return {
      ok: false,
      code: "illegal_transition",
      reason: `${action} expects status ∈ {${rule.expectedStatuses.join(", ")}}, got ${current}`,
    };
  }
  return { ok: true };
}

/** 第二重：跨阶段 gatePassed 级联。 */
export function checkPhaseCascade(action: CwAction, topic: CwTopic): GuardVerdict {
  const rule = TRANSITIONS[action];
  if (!rule?.requirePhaseComplete) {
    return { ok: true };
  }
  // 数据流：requirePhaseComplete 指向上一阶段，其 gatePassed 必须为 true。
  // 失败路径：上一阶段未完成 → phase_incomplete（不跑 gate，D-009 第二道）。
  const required = rule.requirePhaseComplete;
  const passed = computeGatePassed(required, topic);
  if (!passed) {
    return {
      ok: false,
      code: "phase_incomplete",
      reason: `${action} requires phase "${required}" complete (gatePassed), still pending`,
    };
  }
  return { ok: true };
}

/** 第三重：缓存一致性（防篡改，DESIGN-IT-TWICE Agent3）。 */
export function checkCacheConsistency(topic: CwTopic, store: CwStore): GuardVerdict {
  // 数据流：从 store 重算各 phase 的 gatePassed，与 topic 缓存字段逐项比对。
  // 不变式：缓存值必须 === 重算值；任一不一致 → cache_inconsistent（疑似篡改）。
  for (const phase of Object.keys(topic.gatePassed) as CwAction[]) {
    const cached = topic.gatePassed[phase];
    const recomputed = computeGatePassedFromStore(phase, topic, store);
    if (cached !== recomputed) {
      return {
        ok: false,
        code: "cache_inconsistent",
        reason: `phase ${phase}: cached=${String(cached)} !== recomputed=${String(recomputed)}`,
      };
    }
  }
  return { ok: true };
}

/** guard 串行跑三重，任一 fail 短路返回。 */
export function guard(
  action: CwAction,
  topic: CwTopic | null,
  store: CwStore,
): GuardVerdict {
  // 接线：三重串行调用，fail 短路。
  const linear = checkLinear(action, topic?.status);
  if (!linear.ok) {
    return linear;
  }
  if (action === "create") {
    return { ok: true };
  }
  if (!topic) {
    return { ok: false, code: "illegal_transition", reason: "topic required" };
  }
  const cascade = checkPhaseCascade(action, topic);
  if (!cascade.ok) {
    return cascade;
  }
  const cache = checkCacheConsistency(topic, store);
  if (!cache.ok) {
    return cache;
  }
  return { ok: true };
}

// ── 状态流转 ─────────────────────────────────────────────────

/** 计算流转后状态（progressive 已处 nextStatus 时原地停留，§4.3 态内推进）。 */
export function computeNextStatus(action: CwAction, current: CwStatus): CwStatus {
  const rule = TRANSITIONS[action];
  if (!rule) {
    throw new Error(`unknown action: ${action}`);
  }
  // 接线：progressive + 已达 nextStatus → 不流转（态内推进）。
  if (rule.progressive && current === rule.nextStatus) {
    return current;
  }
  return rule.nextStatus;
}

// ── gatePassed 计算（逻辑模型层，#2 第二/三重共用） ──────────

/** 从 topic 逻辑模型算 phase 是否完成（不查 store，第二重 guard 用）。 */
export function computeGatePassed(phase: CwAction, topic: CwTopic): boolean {
  // 数据流：dev=全 Wave committed；test=全 case passed；single-shot=gateHistory 有 pass。
  // 叶子：聚合体留 ⑥Wave。
  void phase;
  void topic;
  throw new Error("not implemented: computeGatePassed 聚合（⑥Wave 落地）");
}

/** 从 store 重算（第三重防篡改，与缓存比对）。 */
function computeGatePassedFromStore(
  phase: CwAction,
  topic: CwTopic,
  store: CwStore,
): boolean {
  // 数据流：读 store 的 waves/testCases/gateHistory 重算，独立于 topic 缓存。
  // SDK 契约：store.loadGateHistory/loadTopic 返回原始数据。
  // 叶子：重算体留 ⑥Wave。
  void phase;
  void topic;
  void store;
  throw new Error("not implemented: computeGatePassedFromStore 重算（⑥Wave 落地）");
}

// ── nextAction 组装（#9 扁平结构，§10.4 skill 映射表） ───────

export function buildNextAction(action: CwAction, topic: CwTopic): NextAction {
  // 数据流：按 tier + 当前 status + gatePassed 推 action/skill/guidance/waves/testCases。
  // skill 映射见 architecture §10.4（test 阶段 skill 留空）。
  // 叶子：映射表 + guidance 文案留 ⑥Wave。
  void action;
  void topic;
  throw new Error("not implemented: buildNextAction 映射（⑥Wave 落地）");
}
