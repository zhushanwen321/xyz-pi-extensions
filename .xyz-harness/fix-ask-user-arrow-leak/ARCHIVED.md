# ARCHIVED — fix-ask-user-arrow-leak

**归档日期**: 2026-07-09
**CW Topic**: cw-2026-07-09-fix-ask-user-arrow-leak
**状态**: closed

## 沉淀去向

- NFR.md ← CS-1 (parseKey 白名单约束) + CS-2 (handleInput 行数上限) [from: fix-ask-user-arrow-leak]
- TEST-STRATEGY.md ← RB-1 (方向键不泄漏) + RB-2 (草稿跨 tab 保持) [from: fix-ask-user-arrow-leak]
- DESIGN-LOG.md ← fix-ask-user-arrow-leak 状态更新为 archived

## topic 文档保留在原位

- requirements.md → `.xyz-harness/fix-ask-user-arrow-leak/requirements.md`
- system-architecture.md → `.xyz-harness/fix-ask-user-arrow-leak/system-architecture.md`
- issues.md → `.xyz-harness/fix-ask-user-arrow-leak/issues.md`
- non-functional-design.md → `.xyz-harness/fix-ask-user-arrow-leak/non-functional-design.md`
- code-architecture.md → `.xyz-harness/fix-ask-user-arrow-leak/code-architecture.md`
- execution-plan.md → `.xyz-harness/fix-ask-user-arrow-leak/execution-plan.md`
- retrospect.md → `.xyz-harness/fix-ask-user-arrow-leak/retrospect.md`
- closeout-report.md → `.xyz-harness/fix-ask-user-arrow-leak/closeout-report.md`

## 核心决策沉淀

- **D-005**: 复用 SDK parseKey（不自建 parse-key.ts）
- **D-004**: handleInput 拆分为 handleOptionsInput + handleEditorInput + handleSubmitTabInput
- **D-008**: draftText 存 QuestionState（非 component 私有字段）
