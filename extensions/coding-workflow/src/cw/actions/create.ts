/**
 * create action — 入口 action（UC-1）。锁 tier，建 topic 目录与 _cw.db。
 *
 * 关联：requirements UC-1（AC-1.1~1.4）；issues #1（CwStore 落地）。
 */

import type { ActionDeps, ActionResult, CwTopic } from "../types.js";
import { buildNextAction } from "../state-machine.js";
import { join } from "node:path";

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
  // topicDir 在 create 时算好存入（ROOT-01 修复）：= workspacePath/.xyz-harness/{slug}。
  // 后续 action loadTopic 后用 topic.topicDir 定位交付物，不再用 deps.workspacePath。
  // 失败路径：slug 重复 → insertTopic 抛 PRIMARY KEY 冲突（AC-1.4）。
  const topicId = buildTopicId(params.slug);
  const workspacePath = params.workspacePath ?? deps.workspacePath;
  const topicDir = join(workspacePath, ".xyz-harness", params.slug);
  const topic: CwTopic = {
    schemaVersion: 1,
    topicId,
    slug: params.slug,
    tier: params.tier,
    objective: params.objective,
    workspacePath,
    topicDir,
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
  // F5 修复：复用 buildNextAction，单一来源，避免 create.ts 与 state-machine.ts 两处 guidance 漂移。
  return {
    topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    nextAction: buildNextAction("create", topic),
  };
}

function buildTopicId(slug: string): string {
  // 数据流：cw- + 日期前缀 + slug（requirements §2 目录约定）。
  // topicId 用作 _cw.db 主键，与 topicDir（= .xyz-harness/{slug}/）解耦：
  // topicId 含 cw-{date}- 前缀便于全局识别；topicDir 用纯 slug 作目录名（agent 友好）。
  const ISO_DATE_PREFIX_LEN = 10; // YYYY-MM-DD
  const date = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LEN);
  return `cw-${date}-${slug}`;
}
