---
phase: code-arch
machine_check: FAIL
---

# 机器检查报告 — code-arch

**Verdict:** FAIL

| 检查项 | 结果 | 详情 |
|--------|------|------|
| code-architecture.md 存在 | ✅ PASS | /Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-subagent-workflow-all-background/.xyz-harness/swf-scripts-docs-adr/code-architecture.md |
| frontmatter verdict | ✅ PASS | verdict: pass |
| 关键章节 | ✅ PASS | 全部 4 个必须章节存在 |
| 无占位符 | ✅ PASS | 无未替换占位符 |
| review-code-arch verdict | ✅ PASS | verdict: APPROVED |
| test-matrix 来源 B | ✅ PASS | 含 NFR 风险→用例映射表 |
| 来源 B 用例 ID 映射 | ✅ PASS | 来源 B 行均映射到用例 ID |
| 来源 A 测试层 | ✅ PASS | 来源 A 表含「测试层」列（mock/real） |
| 骨架源文件存在 | ✅ PASS | 4 个源文件 |
| 骨架无占位符/类型逃逸（③） | ✅ PASS | 无 TODO/eslint-disable/any/type:ignore/nolint 等逃逸 |
| god object（>600 行） | ✅ PASS | 最大文件 107 行 |
| 类型检查 | ⏭️ SKIP | 骨架无可识别语言的源文件（支持 .ts, .tsx, .py, .rs, .js, .jsx, .go, .java） |
| ②§11 grep pattern | ⏭️ SKIP | ②无「反模式检查」章节，跳过架构规则检查 |
| 调用链接线密度（③e） | ❌ FAIL | 全骨架无注入依赖接线——退化回 Level 0（方法体全 throw）。Level 1 要求模块内方法真实接线下游（this.x.foo() / self.x.foo() / receiver.x() 等），仅叶子逻辑 throw。见 skeleton-spike.md「分层接线规则」 |
| orphan 方法（③f） | ⏭️ SKIP | §3 未提取到签名表方法名（可能格式不同），跳过 |

> ⚠️ 存在机器可证的硬伤。review subagent 必须 CHANGES_REQUESTED，不许 APPROVED（硬阻断）。