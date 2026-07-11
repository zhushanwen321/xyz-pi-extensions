// map-reduce.example.js — 映射-归约模板（UC-4）
//
// 模式（两段）：
//   段 1 map:    parallel(items.map(i => workflow("map", {item:i}))) → mapped[]
//   段 2 reduce: workflow("reduce", mapped) → 归约结果
//
// 与 scatter-gather 的区别：scatter-gather 强调数据分片（split 决定分片数）；
// map-reduce 强调对固定 items 数组的变换+聚合（items 已知，map 变换、reduce 聚合）。
//
// 用法：复制本文件到 .pi/workflows/ 或 ~/.pi/agent/workflows/，改 workflow 名后：
//   workflow run map-reduce --args itemsPath=/path/to/items.json
//
// ⚠️ lintScript 约束（本模板已遵守）：
//   - 含 parallel() 入口（兼展示 workflow() 嵌套：map + reduce）
//   - 禁止 bare IIFE / 禁止变量名 result

const meta = {
  name: "map-reduce",
  description: "映射-归约模板：parallel map → reduce 两段",
  phases: ["map", "reduce"],
};

const fs = require("fs");

// ── 入参（$ARGS）──────────────────────────────────────────────────
const itemsPath = $ARGS.itemsPath;
if (!itemsPath) {
  throw new Error("map-reduce 缺少必需参数 itemsPath。用法：workflow run map-reduce --args itemsPath=/path/to/items.json");
}
if (!fs.existsSync(itemsPath)) {
  throw new Error("itemsPath 不存在: " + itemsPath);
}

log("map-reduce 开始，itemsPath=" + itemsPath);

let currentPhase = "init";
let outcome;

try {
  // 读 items 数组（外部数据，非 workflow 状态文件）
  const rawItems = JSON.parse(fs.readFileSync(itemsPath, "utf-8"));
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("itemsPath 内容非数组或为空");
  }
  log("读入 " + rawItems.length + " 个 item");

  // ── 段 1：map（parallel 对每个 item 并行变换）────────────────────
  phase("map");
  currentPhase = "map";
  // parallel() allSettled 语义：单个 map 失败不 reject
  const mappedRaw = await parallel(
    rawItems.map((item, idx) => workflow("map", { item, itemIndex: idx })),
  );

  const mapped = [];
  let mapFailed = 0;
  for (let i = 0; i < mappedRaw.length; i++) {
    const m = mappedRaw[i];
    if (!m || m.error) {
      // map 失败的 item 用 error 占位传入 reduce，由 reduce 决定跳过还是报错
      mapped.push({ itemIndex: i, status: "failed", error: m ? m.error : "无返回" });
      mapFailed++;
    } else {
      mapped.push({ itemIndex: i, status: "ok", content: m.content });
    }
  }
  if (mapFailed === rawItems.length) {
    throw new Error("全部 map 失败（" + mapFailed + "/" + rawItems.length + "）");
  }
  log("map 完成：ok=" + (rawItems.length - mapFailed) + " failed=" + mapFailed);

  // ── 段 2：reduce（workflow 聚合所有 map 结果）───────────────────
  phase("reduce");
  currentPhase = "reduce";
  const reduced = await workflow("reduce", {
    mapped,
    totalItems: rawItems.length,
    mapFailed,
  });
  if (reduced.error) throw new Error("reduce 失败: " + reduced.error);

  outcome = {
    status: mapFailed > 0 ? "partial" : "ok",
    phase: currentPhase,
    items_total: rawItems.length,
    map_failed: mapFailed,
    reduced: reduced.content,
    message: "map-reduce 完成：map " + rawItems.length + " 项（失败 " + mapFailed + "）→ reduce",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "map-reduce 在 " + currentPhase + " 段失败",
  };
}

return outcome;
