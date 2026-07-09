# Closeout Report — fix-ask-user-arrow-leak

## Topic Summary

修复 ask-user 编辑器方向键泄漏乱码（[D[D[D），重构键码解析为白名单架构（复用 SDK parseKey），同步完成 editorText→draftText 迁移、handleInput 拆分、UX 提示行补全。

## Deliverables

| 文档 | 路径 | 状态 |
|------|------|------|
| requirements.md | `.xyz-harness/fix-ask-user-arrow-leak/requirements.md` | ✅ |
| system-architecture.md | `.xyz-harness/fix-ask-user-arrow-leak/system-architecture.md` | ✅ |
| issues.md | `.xyz-harness/fix-ask-user-arrow-leak/issues.md` | ✅ |
| non-functional-design.md | `.xyz-harness/fix-ask-user-arrow-leak/non-functional-design.md` | ✅ |
| code-architecture.md | `.xyz-harness/fix-ask-user-arrow-leak/code-architecture.md` | ✅ |
| execution-plan.md | `.xyz-harness/fix-ask-user-arrow-leak/execution-plan.md` | ✅ |
| retrospect.md | `.xyz-harness/fix-ask-user-arrow-leak/retrospect.md` | ✅ |

## Code Changes

| 文件 | 改动 |
|------|------|
| `extensions/ask-user/src/component.ts` | handleEditorInput parseKey 四态路由 + draftText 迁移 + handleInput 拆分 |
| `extensions/ask-user/src/types.ts` | QuestionState 加 draftText 字段 |
| `extensions/ask-user/src/question-view.ts` | help 行扩展 + draftText 参数透传 |
| `extensions/ask-user/src/__tests__/fixtures.ts` | modifier 键序列常量 |
| `extensions/ask-user/src/__tests__/component-keymap.test.ts` | ~60 新用例 |
| `extensions/ask-user/src/__tests__/w2-draft-hint.test.ts` | ~20 新用例 |
| `extensions/ask-user/src/__tests__/w3-regression.test.ts` | ~20 新用例 |

## 沉淀记录

| 源 | 目标 | 内容 |
|------|------|------|
| non-functional-design.md | NFR.md CS-1 | parseKey 白名单约束（禁自建解析） [from: fix-ask-user-arrow-leak] |
| non-functional-design.md | NFR.md CS-2 | handleInput 行数上限 ≤40 行 [from: fix-ask-user-arrow-leak] |
| execution-plan.md | TEST-STRATEGY.md RB-1 | 方向键/功能键不泄漏回归基线 [from: fix-ask-user-arrow-leak] |
| execution-plan.md | TEST-STRATEGY.md RB-2 | 草稿跨 tab 切换保持回归基线 [from: fix-ask-user-arrow-leak] |

## Quality Metrics

- **测试**: 254 全绿（原 180 + 新增 ~74）
- **Typecheck**: 零错误
- **反模式检查**: AC-1~AC-4 全过
- **CW gate**: dev ✅ test ✅ retrospect ✅

## Resolved Issues

- #1 (P0): parseKey 白名单拦截 — 方向键/功能键不再泄漏
- #2 (P1): editorText→draftText 迁移
- #3 (P1): handleInput 拆分（路由 ≤40 行）
- #4 (P1): 提示行补全
- #5 (P1): 测试套件（负向+正向回归）

## Deferred

- #6: bracketed paste 跨 chunk 拆分（P3）
- #7: 选项 label 含逗号多选歧义（P3）
- #8: handleSubmitTabInput Tab 消费验证（P3）
