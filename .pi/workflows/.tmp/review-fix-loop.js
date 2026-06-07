const meta = {
  name: 'review-fix-loop',
  description: '循环 review-fix：审查代码→修复→提交，直到无 must-fix 问题',
  phases: ['review-fix'],
};

const MAX_ITERATIONS = 10;
const STUCK_THRESHOLD = 3;

function buildPrompt(round) {
  return [
    `你正在执行第 ${round} 轮代码审查与修复。`,
    '',
    '## 任务（严格按顺序执行）',
    '',
    '### 1. 审查代码',
    '',
    '运行 `git diff main...HEAD` 查看当前分支相对于 main 的所有变更。',
    '对每个变更文件进行代码审查，关注：',
    '- 业务逻辑正确性',
    '- 类型安全（禁止 any）',
    '- 边界条件和错误处理',
    '- 测试覆盖',
    '- 代码规范（单文件 ≤ 1000 行，函数 ≤ 80 行）',
    '',
    '每个问题分为两级：',
    '- MUST：必须修复的问题（逻辑错误、类型不安全、遗漏、回归风险）',
    '- SUGGESTION：建议改进（可读性、命名、性能优化）',
    '',
    '### 2. 修复',
    '修复所有发现的 MUST 和 SUGGESTION 问题。每个修复立即保存到文件。',
    '',
    '### 3. 提交',
    '所有修复完成后，运行一次 git add + commit。',
    'Commit message 格式：`fix: review round ${round} — N must-fix, M suggestions`',
    '',
    '### 4. 输出审查结果',
    '在本轮所有工作完成后，在回复末尾输出如下格式的 JSON 代码块：',
    '```json',
    '{',
    '  "mustFix": <本轮审查发现的MUST级别问题数量>,',
    '  "suggestions": <本轮审查发现的SUGGESTION级别问题数量>,',
    '  "findings": [',
    '    {"severity": "MUST", "file": "...", "line": 0, "description": "..."}',
    '  ],',
    '  "summary": "一句话总结"',
    '}',
    '```',
    '',
    '**关键**：mustFix 记录的是本轮审查时的原始发现数。即使你已经修复了这些问题，这个数字也不要改。',
    '只有本轮审查真的什么问题都没发现时，才报告 mustFix=0。',
  ].join('\n');
}

// ── 主循环 ────────────────────────────────────────────────

let iteration = 0;
let stuckCount = 0;
let prevTotal = -1;
let lastMustFix = -1;
let lastSuggestions = -1;

while (iteration < MAX_ITERATIONS) {
  iteration++;

  const raw = await agent({
    prompt: buildPrompt(iteration),
    description: `review-fix-round-${iteration}`,
  });

  // 防御性解析：agent 可能返回对象或字符串
  let state;
  if (typeof raw === 'object' && raw !== null) {
    state = raw;
  } else {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      state = JSON.parse(jsonMatch[1]);
    } else {
      try { state = JSON.parse(text); } catch { state = null; }
    }
  }

  if (!state || typeof state.mustFix !== 'number') {
    throw new Error(`Round ${iteration}: agent did not return valid state. Got: ${typeof raw}`);
  }

  lastMustFix = state.mustFix;
  lastSuggestions = state.suggestions ?? 0;
  const total = lastMustFix + lastSuggestions;

  // 退出：本轮未发现任何 must-fix 问题
  if (lastMustFix === 0) break;

  // 卡死检测：总数连续不下降
  if (prevTotal >= 0 && total >= prevTotal) {
    stuckCount++;
    if (stuckCount >= STUCK_THRESHOLD) break;
  } else {
    stuckCount = 0;
  }

  prevTotal = total;
}

const completed = lastMustFix === 0;
return {
  iterations: iteration,
  remainingMust: lastMustFix,
  remainingSuggestions: lastSuggestions,
  completed,
  message: completed
    ? `All issues resolved in ${iteration} round(s).`
    : `Stopped after ${iteration} rounds with ${lastMustFix} MUST + ${lastSuggestions} SUGGESTION(s) remaining.`,
};
