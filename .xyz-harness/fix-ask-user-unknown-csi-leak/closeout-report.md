# Closeout Report — fix-ask-user-unknown-csi-leak

## Topic Summary

修复 ask-user 编辑器 fallback 分支泄漏未知控制序列（OSC/DA/DCS/APC/unknown CSI/SS3）的 bug。parseKey 返回 undefined 时 ESC 开头的未识别序列可见残渣被当文本追加。修复：fallback 入口加 ESC 开头硬守卫（排除 bracketed paste 标记），整体丢弃。

## Deliverables

| 文档 | 路径 | 状态 |
|------|------|------|
| plan.md | `.xyz-harness/fix-ask-user-unknown-csi-leak/plan.md` | ✅ |
| plan.json | `.xyz-harness/fix-ask-user-unknown-csi-leak/plan.json` | ✅ |
| retrospect.md | `.xyz-harness/fix-ask-user-unknown-csi-leak/retrospect.md` | ✅ |

## Code Changes

| 文件 | 改动 |
|------|------|
| `extensions/ask-user/src/component.ts` | handleEditorInput fallback 入口加 ESC 开头硬守卫 |
| `extensions/ask-user/src/__tests__/fixtures.ts` | 新增 8 个控制序列常量 |
| `extensions/ask-user/src/__tests__/component-keymap.test.ts` | 新增 17 条 C-CSI 测试 |

## 沉淀记录

| 源 | 目标 | 内容 |
|------|------|------|
| plan.md 约束 | NFR.md CS-3 | StdinBuffer 序列拆分假设（fallback 守卫依赖 data 整体性） [from: fix-ask-user-unknown-csi-leak] |
| plan.md 测试设计 | TEST-STRATEGY.md RB-3 | OSC/DA/DCS/APC/SS3 控制序列不泄漏回归基线（9 类形态 × 17 条用例） [from: fix-ask-user-unknown-csi-leak] |
| retrospect.md 方法论 | ADR 同源盲区 | parseKey undefined 是三义信号（粘贴/未识别控制序列/终端自发响应），需独立守卫而非仅靠 parseKey 分类 |

## Quality Metrics

- **测试**: 271 全绿（原 254 + 新增 17）
- **Typecheck**: 零错误
- **Pre-commit**: tsc/eslint/vitest 全通过
- **CW gate**: plan ✅ dev ✅ test ✅ retrospect ✅

## Resolved Issues

- 未知控制序列（OSC/DA/DCS/APC/SS3/unknown CSI）泄漏到 editorText 的 bug
- C-CSI-1~10 覆盖 9 类泄漏形态 + C-CSI-R1~R7 覆盖 7 条回归路径

## Deferred

- E3-r：真实终端环境验证（[需集成环境]，mock 层已充分覆盖）
