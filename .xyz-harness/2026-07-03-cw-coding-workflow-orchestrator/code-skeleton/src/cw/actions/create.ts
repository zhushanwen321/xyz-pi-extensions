/**
 * create action — 入口 action（UC-1）。锁 tier，建 topic 目录与 _cw.db。
 *
 * 关联：requirements UC-1（AC-1.1~1.4）；issues #1（CwStore 落地）。
 */

import type { ActionDeps, ActionResult, CwTopic } from "../types.js";

export interface CreateParams {
  action: "create";
  slug: string;
  tier: "lite" | "mid";
  objective: string;
  workspacePath?: string;
}

export function handleCreate(params: CreateParams, deps: ActionDeps): ActionResult {
  // 数据流：slug+tier+objective → 新 CwTopic（status=created, tier 锁定）→ store.insertTopic。
  // 不变式：tier 写入后只读（后续 action 的 format 校验兜底，D-003）。
  // 失败路径：slug 重复 → insertTopic 抛 PRIMARY KEY 冲突（AC-1.4）。
  const topicId = buildTopicId(params.slug);
  const workspacePath = params.workspacePath ?? deps.workspacePath;
  const topic: CwTopic = {
    schemaVersion: 1,
    topicId,
    slug: params.slug,
    tier: params.tier,
    objective: params.objective,
    workspacePath,
    createdAt: new Date().toISOString(),
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
  };
  deps.store.transaction(() => {
    // 接线：事务包裹 insert。
    deps.store.insertTopic(topic);
  });
  return {
    topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    nextAction: {
      // 按 tier 指向 plan（lite）或 clarify（mid）。
      action: params.tier === "lite" ? "plan" : "clarify",
      skill: params.tier === "lite" ? "lite-plan" : "mid-plan",
      guidance: `topic created (tier=${params.tier}); next: 产 ${params.tier === "lite" ? "plan.json" : "clarify.json"} 并调 cw(${params.tier === "lite" ? "plan" : "clarify"})`,
    },
  };
}

function buildTopicId(slug: string): string {
  // 数据流：cw- + 日期前缀 + slug（requirements §2 目录约定）。
  const date = new Date().toISOString().slice(0, 10);
  return `cw-${date}-${slug}`;
}
