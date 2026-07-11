// scatter-gather.example.js — 分发-收集模板（UC-3）
//
// 模式（三段）：
//   段 1 scatter: workflow("split", data) → 出 shards[]
//   段 2 process: parallel(shards.map(s => workflow("process", {shard:s}))) → 并行处理
//   段 3 gather:  workflow("merge", results) → 合并
//
// 用法：复制本文件到 .pi/workflows/ 或 ~/.pi/agent/workflows/，改 workflow 名后：
//   workflow run scatter-gather --args dataPath=/path/to/big.json
//
// ⚠️ lintScript 约束（本模板已遵守）：
//   - 含 parallel() 入口（兼展示 workflow() 嵌套：split/merge + process）
//   - 禁止 bare IIFE / 禁止变量名 result

const meta = {
  name: "scatter-gather",
  description: "分发-收集模板：split → parallel process → merge 三段",
  phases: ["scatter", "process", "gather"],
};

const fs = require("fs");

// ── 入参（$ARGS）──────────────────────────────────────────────────
const dataPath = $ARGS.dataPath;
if (!dataPath) {
  throw new Error("scatter-gather 缺少必需参数 dataPath。用法：workflow run scatter-gather --args dataPath=/path/to/big.json");
}
if (!fs.existsSync(dataPath)) {
  throw new Error("dataPath 不存在: " + dataPath);
}

log("scatter-gather 开始，dataPath=" + dataPath);

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：scatter（split workflow 分片数据）──────────────────────
  phase("scatter");
  currentPhase = "scatter";
  const splitOutcome = await workflow("split", {
    source: dataPath,
    // split workflow 决定分片数（按数据量/可用配额），返回 shards 数组
  });
  if (splitOutcome.error) throw new Error("split 失败: " + splitOutcome.error);

  // split workflow 返回的 content 应是分片清单（JSON 字符串或 parsedOutput 数组）
  // 用 schema 让 split 直接返回结构化 shards（参考 workflow-script-format 结构化输出规则）
  const shards = splitOutcome.parsedOutput || JSON.parse(splitOutcome.content);
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new Error("split 返回的 shards 非数组或为空");
  }
  log("split 出 " + shards.length + " 个分片");

  // ── 段 2：process（parallel 并行处理每个分片）────────────────────
  phase("process");
  currentPhase = "process";
  // parallel() allSettled 语义：单个分片处理失败不 reject，收集后统一判断
  const processed = await parallel(
    shards.map((shard, idx) => workflow("process", { shard, shardIndex: idx })),
  );

  const shardResults = [];
  let failedShards = 0;
  for (let i = 0; i < processed.length; i++) {
    const p = processed[i];
    if (!p || p.error) {
      shardResults.push({ shardIndex: i, status: "failed", error: p ? p.error : "无返回" });
      failedShards++;
    } else {
      shardResults.push({ shardIndex: i, status: "ok", content: p.content });
    }
  }
  if (failedShards === shards.length) {
    throw new Error("全部分片处理失败（" + failedShards + "/" + shards.length + "）");
  }
  log("process 完成：ok=" + (shards.length - failedShards) + " failed=" + failedShards);

  // ── 段 3：gather（merge workflow 合并结果）───────────────────────
  phase("gather");
  currentPhase = "gather";
  const merged = await workflow("merge", {
    shardResults,
    totalShards: shards.length,
    failedShards,
  });
  if (merged.error) throw new Error("merge 失败: " + merged.error);

  outcome = {
    status: failedShards > 0 ? "partial" : "ok",
    phase: currentPhase,
    shards_total: shards.length,
    shards_failed: failedShards,
    merged: merged.content,
    message: "scatter-gather 完成：split " + shards.length + " → process（失败 " + failedShards + "）→ merge",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "scatter-gather 在 " + currentPhase + " 段失败",
  };
}

return outcome;
