---
phase: issues
machine_check: FAIL
---

# 机器检查报告 — issues

**Verdict:** FAIL

| 检查项 | 结果 | 详情 |
|--------|------|------|
| issues.md 存在 | ✅ PASS | /Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-subagent-workflow-all-background/.xyz-harness/swf-scripts-docs-adr/issues.md |
| frontmatter verdict | ✅ PASS | verdict: pass |
| 关键章节 | ✅ PASS | 全部 2 个必须章节存在 |
| 无占位符 | ✅ PASS | 无未替换占位符 |
| review-issues verdict | ✅ PASS | verdict: APPROVED |
| P0/P1 issue ≥2 方案对比 | ✅ PASS | 全部 P0/P1 issue 有 ≥2 方案 |
| blocked_by 无幽灵依赖 | ✅ PASS | 所有 blocked_by 引用都存在 |
| P 级一致性 | ✅ PASS | P 级与 blocked_by 一致 |
| 覆盖核验表形式 | ❌ FAIL | 行1: 既无 #issue 也无 N/A — #Issue \| 覆盖 UC |

> ⚠️ 存在机器可证的硬伤。review subagent 必须 CHANGES_REQUESTED，不许 APPROVED（硬阻断）。