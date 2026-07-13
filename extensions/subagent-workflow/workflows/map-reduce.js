// map-reduce.js — 映射-归约（通用 subagent 编排）
//
// 模式（两段）：
//   段 1 map:    parallel() 对每个 item 并行执行 operation
//   段 2 reduce: agent() 把所有 map 结果归约成单一结果
//
// 与 scatter-gather 的区别：scatter-gather 强调"拆分"（scatter 决定子任务数）；
// map-reduce 强调对"已知 items 数组"的变换+聚合（items 已有，map 变换、reduce 归约）。
//
// 用法：
//   workflow run map-reduce --args 'items=["file1.ts","file2.ts","file3.ts"]' --args operation="审查代码风格"
//   workflow run map-reduce --args itemsJson=/path/to/items.json --args operation="..."
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口（兼 agent 嵌套），禁止 bare IIFE

const meta = {
  name: "map-reduce",
  description: "通用编排：parallel map → reduce 两段，处理已知 items 数组",
  phases: ["map", "reduce"],
};

const fs = require("fs");

// ── 入参（$ARGS）──────────────────────────────────────────────────
const operation = $ARGS.operation;
if (!operation) {
  throw new Error(
    'map-reduce 缺少必需参数 operation。用法：workflow run map-reduce --args operation="<对每个 item 做什么>"',
  );
}

// items 来源：直接数组 或 itemsJson 文件路径（二选一）
let items = $ARGS.items;
if (!items) {
  const itemsPath = $ARGS.itemsJson;
  if (!itemsPath) {
    throw new Error(
      'map-reduce 需要 items（直接数组）或 itemsJson（JSON 文件路径）参数',
    );
  }
  if (!fs.existsSync(itemsPath)) {
    throw new Error("itemsJson 文件不存在: " + itemsPath);
  }
  items = JSON.parse(fs.readFileSync(itemsPath, "utf-8"));
}

if (!Array.isArray(items) || items.length === 0) {
  throw new Error("items 不是数组或为空");
}

log("map-reduce 开始，items=" + items.length + " 个，operation=" + operation);

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：map（parallel 对每个 item 并行变换）────────────────────
  phase("map");
  currentPhase = "map";

  // 每个 item 字符串化，便于拼进 prompt
  const mappedRaw = await parallel(
    items.map((item, idx) =>
      agent({
        prompt:
          "对以下 item 执行操作：\n\noperation：" + operation +
          "\nitem：" + (typeof item === "string" ? item : JSON.stringify(item)),
        schema: {
          type: "object",
          properties: {
            itemIndex: { type: "number", description: "item 序号" },
            mapped: { type: "string", description: "map 后的结果" },
          },
          required: ["itemIndex", "mapped"],
        },
        description: "map-reduce-map-" + idx,
      })
    ),
  );

  const mapped = [];
  let mapFailed = 0;
  for (let i = 0; i < mappedRaw.length; i++) {
    const r = mappedRaw[i];
    if (!r || r.error) {
      mapped.push({
        itemIndex: i,
        item: items[i],
        status: "failed",
        error: r ? r.error : "agent 无返回",
      });
      mapFailed++;
    } else {
      mapped.push({
        itemIndex: i,
        item: items[i],
        status: "ok",
        mapped: r.mapped,
      });
    }
  }
  if (mapFailed === items.length) {
    throw new Error("全部 map 失败（" + mapFailed + "/" + items.length + "）");
  }
  log("map 完成：ok=" + (items.length - mapFailed) + " failed=" + mapFailed);

  // ── 段 2：reduce（agent 聚合所有 map 结果）──────────────────────
  phase("reduce");
  currentPhase = "reduce";
  const reduced = await agent({
    prompt:
      "以下是对 " + items.length + " 个 item 执行「" + operation + "」的结果，请归约成单一结论：\n\n" +
      JSON.stringify(mapped, null, 2),
    schema: {
      type: "object",
      properties: {
        reduced: { type: "string", description: "归约后的最终结果" },
        stats: { type: "string", description: "统计摘要（成功率/共性发现等）" },
      },
      required: ["reduced", "stats"],
    },
    description: "map-reduce-reduce",
  });

  outcome = {
    status: mapFailed > 0 ? "partial" : "ok",
    phases_run: ["map", "reduce"],
    items_total: items.length,
    items_mapped: items.length - mapFailed,
    reduced: { reduced: reduced.reduced, stats: reduced.stats },
    message: "map-reduce 完成：map " + items.length + " 项（失败 " + mapFailed + "）→ reduce",
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
