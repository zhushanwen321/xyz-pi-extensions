/**
 * CW 状态机（D-009 主强制点）：声明式转换表 + 三重 guard + nextAction 组装。
 *
 * 三重校验（D-016 后）：
 *   1. checkLinear        — 线性 expectedStatus（currentState ∈ expectedStatuses[action]）
 *   2. checkPhaseCascade  — 跨阶段 gatePassed 级联（test 需 dev 全 Wave committed；retrospect 需 test 全 case passed）
 *   3. checkCacheConsistency — 数据完整性 self-check：从 waves/testCases/gateHistory 重算 gatePassed 与 topic 缓存比对（D-017，捕捉 store bug，非安全机制）
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

/** 第三重：缓存一致性 self-check（D-017：数据完整性，捕捉 store 层 bug，非安全机制）。 */
export function checkCacheConsistency(topic: CwTopic, store: CwStore): GuardVerdict {
  // 数据流：从 topic 的 waves/testCases/gateHistory 重算各 phase 的 gatePassed，与 topic 缓存字段逐项比对。
  // 不变式：缓存值必须 === 重算值；任一不一致 → cache_inconsistent（store 层 bug 指示，非恶意篡改——
  // honest agent 不改 _cw.db；malicious agent 改缓存+证据即绕过，本 check 不防此路径，详见 decisions D-017）。
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

/**
 * 从 topic 逻辑模型算 phase 是否完成（不查 store，第二重 guard + 第三重 self-check 共用）。
 *
 * 完成语义：
 *   - dev：全 Wave committed（≥1 个 Wave 且全部 committed；空 waves 不算完成——防退化路径）
 *   - test：全 testCase passed（≥1 个且全部 passed；空 testCases 不算完成）
 *   - single-shot（plan/clarify/detail/retrospect/closeout）：gateHistory 有该 phase 的 pass 记录
 *   - create：无 gate → 永远 false
 */
export function computeGatePassed(phase: CwAction, topic: CwTopic): boolean {
  if (phase === "dev") {
    return topic.waves.length > 0 && topic.waves.every((w) => w.committed !== null);
  }
  if (phase === "test") {
    return (
      topic.testCases.length > 0 && topic.testCases.every((c) => c.status === "passed")
    );
  }
  // single-shot：gateHistory 有该 phase 的 pass 记录（create 落到此分支，无 gate 记录 → false）
  return topic.gateHistory.some((e) => e.phase === phase && e.result === "pass");
}

/** 从 topic 原始数据重算（第三重 self-check，与缓存比对；store 参数留未来扩展）。 */
function computeGatePassedFromStore(
  phase: CwAction,
  topic: CwTopic,
  store: CwStore,
): boolean {
  // D-017：第三重语义是「缓存 vs 重算」。重算用 topic 内的原始数据（waves/testCases/gateHistory，
  // 这些是 store.loadTopic 读出的非缓存字段），与 topic.gatePassed 缓存比对。
  // store 参数当前 void：不重新 loadTopic（db 可能已变 + 性能开销）；留作未来需要读最新 db 状态时扩展。
  void store;
  return computeGatePassed(phase, topic);
}

// ── nextAction 组装（#9 扁平结构，§10.4 skill 映射表） ───────

/** 把 Wave[] 压成 nextAction.waves 进度（id + committed 布尔）。 */
function waveProgress(topic: CwTopic): NextAction["waves"] {
  return topic.waves.map((w) => ({ id: w.id, committed: w.committed !== null }));
}

/** 把 TestCase[] 压成 nextAction.testCases 进度（id + status）。 */
function testCaseProgress(topic: CwTopic): NextAction["testCases"] {
  return topic.testCases.map((c) => ({ id: c.id, status: c.status }));
}

export function buildNextAction(action: CwAction, topic: CwTopic): NextAction {
  // 数据流：按 tier + action + gatePassed 推 action/skill/guidance/waves/testCases。
  // skill 映射见 architecture §10.4（test 阶段无专用 skill，skill 留空）。
  switch (action) {
    case "create": {
      // create 后：lite→plan，mid→clarify（D-003 tier 锁定决定分支）
      if (topic.tier === "lite") {
        return {
          action: "plan",
          skill: "lite-plan",
          guidance:
            "topic 已建立（tier=lite）。下一步：调 lite-plan skill 产出 plan.json（含 waves + testCases），完成后调 cw plan 提交。",
        };
      }
      return {
        action: "clarify",
        skill: "mid-plan",
        guidance:
          "topic 已建立（tier=mid）。下一步：调 mid-plan skill 产出 clarify.json + requirements.md + system-architecture.md，完成后调 cw clarify 提交。",
      };
    }
    case "plan": {
      // plan 后：dev
      return {
        action: "dev",
        skill: "coding-execute",
        guidance:
          "plan gate 通过，waves/testCases 已写入 _cw.db。下一步：调 coding-execute skill 按 Wave 派发 subagent 执行，commit 后调 cw dev 提交 commitHash。",
        waves: waveProgress(topic),
      };
    }
    case "clarify": {
      // clarify 后：detail
      return {
        action: "detail",
        skill: "mid-detail-plan",
        guidance:
          "clarify gate 通过。下一步：调 mid-detail-plan skill 产出 detail.json + issues/nfr/code-arch/execution-plan，完成后调 cw detail 提交。",
      };
    }
    case "detail": {
      // detail 后：dev
      return {
        action: "dev",
        skill: "coding-execute",
        guidance:
          "detail gate 通过，waves/testCases 已写入 _cw.db。下一步：调 coding-execute skill 按 Wave 派发 subagent 执行，commit 后调 cw dev 提交 commitHash。",
        waves: waveProgress(topic),
      };
    }
    case "dev": {
      // dev 后：gatePassed.dev → test；否则继续 dev（渐进式提交，态内推进）
      if (computeGatePassed("dev", topic)) {
        return {
          action: "test",
          // §10.4：test 阶段无专用 skill——agent 直接执行测试（可经 coding-execute skill 的 test 派发）后调 cw test
          guidance:
            "所有 Wave 已 committed，dev 阶段完成。下一步：执行 testCases（可经 coding-execute skill 派发 test-runner），跑完调 cw test 提交 actual/screenshotPath。",
          waves: waveProgress(topic),
          testCases: testCaseProgress(topic),
        };
      }
      return {
        action: "dev",
        skill: "coding-execute",
        guidance:
          "dev 阶段进行中，仍有 Wave 未 committed。下一步：继续调 coding-execute skill 执行剩余 Wave，commit 后调 cw dev 提交 commitHash。",
        waves: waveProgress(topic),
      };
    }
    case "test": {
      // test 后：gatePassed.test → retrospect；否则继续 test（渐进式提交，态内推进）
      if (computeGatePassed("test", topic)) {
        return {
          action: "retrospect",
          skill: "coding-retrospect",
          guidance:
            "所有 testCase 已 passed，test 阶段完成。下一步：调 coding-retrospect skill 产出复盘报告，完成后调 cw retrospect 提交。",
        };
      }
      return {
        action: "test",
        // §10.4：test 阶段无专用 skill
        guidance:
          "test 阶段进行中，仍有 testCase 未 passed。下一步：继续执行剩余 testCase（修复 failed / 补跑 pending），跑完调 cw test 提交结果。",
        testCases: testCaseProgress(topic),
      };
    }
    case "retrospect": {
      // retrospect 后：closeout
      return {
        action: "closeout",
        skill: "coding-closeout",
        guidance:
          "retrospect gate 通过。下一步：调 coding-closeout skill 归档本次设计/实施沉淀（ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY），完成后调 cw closeout 提交。",
      };
    }
    case "closeout": {
      // closeout 后：topic 已关闭，无后续 action（终态不可逆，§4.4）
      return {
        guidance:
          "topic 已关闭（closed）。本次编码流程结束，所有交付物已归档，_cw.db 进入终态。",
      };
    }
  }
}
