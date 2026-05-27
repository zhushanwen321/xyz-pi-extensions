const meta = {
  name: "demo",
  description: "Demo workflow — 验证最小可用路径",
  phases: ["analyze", "summarize"],
};

// $ARGS is injected by the runtime from workerData.args
const file = $ARGS.file ?? "README.md";

// Phase 1: 分析文件结构
const analysis = await agent({
  prompt:
    `Read the file "${file}" and list its key sections (headings, chapters, or major partitions). ` +
    "Return as a JSON array of section title strings.",
  schema: { type: "array", items: { type: "string" } },
  description: "Analyze file structure",
});

// Phase 2: 生成摘要
const summary = await agent({
  prompt:
    `Based on the following file sections, write a concise one-paragraph summary of the document: ` +
    JSON.stringify(analysis),
  description: "Summarize file",
});

return { file, sections: analysis, summary };
