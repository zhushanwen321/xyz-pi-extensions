# 复盘 — fix-ask-user-arrow-leak

## 改动总结

| 文件 | 改动 | Wave |
|------|------|------|
| `component.ts` | handleEditorInput 加 parseKey 四态路由 + draftText 迁移 + handleInput 拆分 | W1+W2 |
| `types.ts` | QuestionState 加 draftText 字段 | W2 |
| `question-view.ts` | help 行扩展 + draftText 参数透传 | W2 |
| `fixtures.ts` | 新增 modifier 键序列常量 | W1 |
| `component-keymap.test.ts` | 新增 ~60 用例（C-ARROW/C-KEYMAP/C-KEYMAP-MOD） | W1 |
| `w2-draft-hint.test.ts` | 新增 ~20 用例（C-DRAFT/C-BC4C/C-BC4B/C-HINT） | W2 |
| `w3-regression.test.ts` | 新增 ~20 用例（C-REG-ALL + 全量复跑） | W3 |

## 检查清单

- [x] 核心 bug 修复：方向键不再泄漏为 `[C` 文本
- [x] parseKey 四态路由：escape/enter/backspace/space/单字符/special/multi-char
- [x] draftText 迁移：editorText 字段已移除，全部改用 state.draftText
- [x] handleInput 拆分：路由 ≤40 行，options/editor/submitTab 各自独立方法
- [x] 提示行：freeform + comment help 行含 "Backspace deletes"
- [x] 反模式检查：AC-1~AC-4 全过
- [x] 254 测试全绿（原 180 + 新增 ~74）
- [x] typecheck 零错误
- [x] CW dev gate 通过
- [x] CW test gate 通过

## 遗留项

- #6 bracketed paste 跨 chunk 拆分（P3，边角情况）
- #7 选项 label 含逗号多选歧义（P3）
- #8 handleSubmitTabInput Tab 消费运行验证（P3）
