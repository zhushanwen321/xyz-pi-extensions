const meta = {
  name: 'phase-specs-review-fix',
  description: '审查 docs/phase-specs/ 的设计一致性，循环修复 must/suggestion 直到无问题',
  phases: ['review-fix'],
};

const path = require('node:path');

const SPECS_DIR = path.join($WORKSPACE, 'docs', 'phase-specs');
const MAX_ITERATIONS = 10;
const SPEC_FILES = ['phase-1-spec.md', 'phase-2-plan.md', 'phase-3-dev.md', 'phase-4-test.md'];

function buildPrompt(round) {
  const files = SPEC_FILES.map(f => `- docs/phase-specs/${f}`);

  return [
    `你正在执行 phase-specs 设计一致性审查的第 ${round} 轮。`,
    '',
    '## 任务（严格按顺序执行）',
    '',
    '### 1. 审查 4 份 Phase Spec 的设计一致性',
    '',
    '逐一读取以下文件：',
    ...files,
    '',
    '按以下维度审查，每个问题给出 MUST / SUGGESTION 分级：',
    '',
    '**跨 Phase 一致性**：',
    '- Phase 过渡描述是否匹配（如 Phase 1 说"调用 phase-start(2)"但 Phase 2 入口描述不同）',
    '- 产出物是否在前后 Phase 中一致引用（Phase 2 产出的文件是否被 Phase 3/4 正确消费）',
    '- Review-Gate / Phase-Gate 阈值和规则是否跨 Phase 矛盾',
    '- 术语使用是否统一（同一概念是否在不同 Phase 用不同名字）',
    '',
    '**Phase 内部逻辑**：',
    '- 流程步骤是否自洽（描述的前后顺序、依赖关系是否合理）',
    '- Goal 任务列表是否与实际产出物对应',
    '- 失败处理路径是否完备（是否有未覆盖的失败场景）',
    '- 数量/阈值是否前后矛盾（如"最多3轮"与"连续2轮不降"是否在不同地方写法不同）',
    '',
    '**遗漏与冗余**：',
    '- 关键决策是否缺少理由说明',
    '- 是否有重复描述的段落（同一段逻辑在多处出现且版本不同）',
    '- Agent 文件规划是否与实际使用匹配',
    '',
    '### 2. 修复',
    '修复所有发现的 MUST 和 SUGGESTION 问题：',
    '- 修改对应的 phase spec 文件',
    '- 修复时保持文档整体风格一致',
    '',
    '### 3. 输出审查结果',
    '在本轮所有工作完成后，在回复末尾输出如下格式的 JSON 代码块：',
    '```json',
    '{',
    '  "mustFix": <本轮审查发现的MUST级别问题数量>,',
    '  "suggestions": <本轮审查发现的SUGGESTION级别问题数量>,',
    '  "findings": [',
    '    {"severity": "MUST", "location": "...", "description": "...", "fixInstruction": "..."}',
    '  ],',
    '  "summary": "一句话总结"',
    '}',
    '```',
    '',
    '**关键**：mustFix 和 suggestions 记录的是本轮审查时的原始发现数。即使你已经修复了这些问题，这两个数字也不要改。',
    '只有本轮审查真的什么问题都没发现时，才报告 mustFix=0, suggestions=0。',
  ].join('\n');
}

// ── 主循环 ────────────────────────────────────────────────

let iteration = 0;
let prevTotal = -1;
let stuckCount = 0;
let lastMustFix = -1;
let lastSuggestions = -1;

try {
while (iteration < MAX_ITERATIONS) {
  iteration++;

  const raw = await agent({
    prompt: buildPrompt(iteration),
    description: `phase-specs-review-round-${iteration}`,
  });

  // agent 可能返回对象（schema 生效）或字符串（schema 未生效），做防御性解析
  let state;
  if (typeof raw === 'object' && raw !== null) {
    state = raw;
  } else {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // 尝试从文本中提取 JSON 块
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      state = JSON.parse(jsonMatch[1]);
    } else {
      // 最后尝试直接 parse 整个文本
      try { state = JSON.parse(text); } catch { state = null; }
    }
  }

  if (!state || typeof state.mustFix !== 'number') {
    throw new Error(`Round ${iteration}: agent did not return valid state. Got: ${typeof raw}`);
  }

  const mustFix = state.mustFix;
  const suggestions = state.suggestions;

  lastMustFix = mustFix;
  lastSuggestions = suggestions;

  const total = mustFix + suggestions;

  // 退出：本轮审查未发现任何问题
  if (mustFix === 0 && suggestions === 0) break;

  // 卡死检测：总数连续不下降
  if (prevTotal >= 0 && total >= prevTotal) {
    stuckCount++;
    if (stuckCount >= 3) break;
  } else {
    stuckCount = 0;
  }

  prevTotal = total;
}

} finally {
  // safety net: no state file to clean, but keep structure for future use
}

const resolved = (lastMustFix + lastSuggestions) === 0;
return {
  iterations: iteration,
  remainingMust: lastMustFix,
  remainingSuggestions: lastSuggestions,
  completed: resolved,
  message: resolved
    ? `All issues resolved in ${iteration} round(s).`
    : `Stopped after ${iteration} rounds with ${lastMustFix} MUST + ${lastSuggestions} SUGGESTION(s) remaining.`,
};
