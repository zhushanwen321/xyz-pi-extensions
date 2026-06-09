const meta = {
  name: 'review-fix-loop',
  description: '循环审查-修复流程：code-review → fix → 直到无 must-fix 问题或达到上限',
  phases: ['review-fix-loop'],
};

const MAX_ROUNDS = $ARGS?.max_rounds ?? 10;
const reviewReportDir = require('node:path').join($WORKSPACE, '.pi', 'review-fix-loop');

// 确保报告目录存在
require('node:fs').mkdirSync(reviewReportDir, { recursive: true });

let round = 0;
let lastReportPath = '';

while (round < MAX_ROUNDS) {
  round++;

  // ─── 节点 1：Code Review ───────────────────────────────
  const review = await agent({
    prompt: `Round ${round}/${MAX_ROUNDS}。

你是代码审查专家。请对当前 worktree 相对于 main 的所有变更执行完整的 code review。

**审查范围**：
\`\`\`bash
git diff main...HEAD
\`\`\`

**审查维度**（全部覆盖）：
1. 业务逻辑：变更是否解决声明的问题、边界条件、回归风险
2. monorepo 影响：子包间依赖、循环依赖、公共 API 变更
3. 类型安全：完整类型标注、禁止 any
4. 扩展接口：tool/command schema 完整性、向后兼容
5. 测试：新增逻辑是否有对应测试
6. 代码质量：复杂度热点、重复代码、未使用导出

**输出要求**：
- 将完整审查报告写入文件 \`${reviewReportDir}/round-${round}-review.md\`
- 报告格式：总体评价 + 问题列表（严重程度/位置/问题/建议）+ 亮点
- 同时返回 must-fix 数量（必须修复的问题，不包括建议）`,
    schema: {
      type: 'object',
      properties: {
        review_report: {
          type: 'string',
          description: '审查报告文件的绝对路径',
        },
        must_fix: {
          type: 'number',
          description: '必须修复的问题数量（仅 MUST-fix，不含建议项）',
        },
      },
      required: ['review_report', 'must_fix'],
    },
    description: `review-round-${round}`,
  });

  lastReportPath = review.review_report;

  // ─── 节点 2：判断是否跳出 ───────────────────────────────
  if (review.must_fix === 0) {
    return {
      status: 'clean',
      rounds: round,
      last_report: lastReportPath,
      message: `代码审查通过，共 ${round} 轮，无需修复`,
    };
  }

  // ─── 节点 3：修复所有 must-fix 问题 ──────────────────────
  await agent({
    prompt: `Round ${round}/${MAX_ROUNDS}。

你是代码修复专家。审查报告已写入：\`${lastReportPath}\`

请：
1. 读取审查报告
2. 修复报告中所有 MUST-fix 级别的问题（忽略纯建议项）
3. 修复后提交：\`git add -A && git commit -m "fix: review round ${round}"\`

**修复原则**：
- 仅修复 must-fix，不要顺手改建议项
- 保持最小改动，不改变业务逻辑
- 修复后确保类型检查和 lint 通过`,
    description: `fix-round-${round}`,
  });
}

// 循环耗尽
return {
  status: 'max_rounds_reached',
  rounds: round,
  last_report: lastReportPath,
  message: `达到最大轮数 ${MAX_ROUNDS}，仍有 must-fix 问题待处理`,
};
