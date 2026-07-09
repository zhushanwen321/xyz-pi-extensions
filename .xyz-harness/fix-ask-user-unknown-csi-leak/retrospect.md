# 复盘 — fix-ask-user-unknown-csi-leak

## 改动总结

| 文件 | 改动 | Wave |
|------|------|------|
| `component.ts` | handleEditorInput fallback 分支入口加 ESC 开头硬守卫（排除 bracketed paste） | W1 |
| `fixtures.ts` | 新增 8 个控制序列常量（OSC_BEL/OSC_ST/DA1/DA2/DCS/APC/UNKNOWN_CSI/UNKNOWN_SS3） | W1 |
| `component-keymap.test.ts` | 新增 17 条测试（C-CSI-1~10 泄漏检测 + C-CSI-R1~R7 回归保护） | W1 |

## 检查清单

- [x] 核心 bug 修复：ESC 开头的未识别控制序列不再泄漏可见残渣到 editorText
- [x] 守卫逻辑：`data.startsWith("\x1b") && !data.includes("\x1b[200~") && !data.includes("\x1b[201~")` → return
- [x] bracketed paste 不退化（C-CSI-R4 通过）
- [x] 纯文本/emoji/中文不退化（C-CSI-R1~R3 通过）
- [x] 方向键/backspace/Esc 不退化（C-CSI-R5~R7 通过）
- [x] comment 编辑器同步覆盖（C-CSI-10 通过）
- [x] 9 类控制序列形态覆盖：OSC-BEL / OSC-ST / DA1 / DA2 / DCS / APC / SS3 / unknown CSI / 连续序列
- [x] 271 测试全绿（原 254 + 新增 17）
- [x] typecheck 零错误
- [x] pre-commit hook 全通过（tsc/eslint/vitest）
- [x] CW dev gate 通过
- [x] CW test gate 通过（E1/E2 mock + E3-r manual）

## 方法论复盘

- **同源盲区**：上一轮（fix-ask-user-arrow-leak，mid tier）的 redteam review 发现了 `alt+x` 泄漏 `x` 的特例，但把它窄化为"modifier 泄漏"用 18 个 modifier 测试覆盖，没有推广到一般性结论（任何 parseKey 不认识的含可见字符序列都会泄漏）。本轮通过 Pi 源码（stdin-buffer.ts / tui.ts / interactive-mode.ts）调研发现了更一般的泄漏路径（OSC/DA/DCS/APC），覆盖了 9 类形态而非仅 modifier 子集。
- **边界假设验证**：fallback 守卫的 `data.startsWith("\x1b")` 假设依赖 StdinBuffer 的序列拆分能力——`a\x1b]11;r\x07b` 不会作为一个 data chunk 到达。这个假设通过阅读 stdin-buffer.ts 源码确认（`extractCompleteSequences` 拆分为三个独立序列），非推测。
- **测试断言精度**：C-CSI-4 的 `not.toContain(">")` 初始断言误判了渲染层光标标记（`> 3. Other`）为控制序列残渣。渲染输出的语义分析比纯文本匹配复杂——选项列表的光标指示符 `>` 不是 editorText 的一部分，不应被当作泄漏检查目标。

## 遗留项

- E3-r（real 层）：[需集成环境] 需人工在真实终端验证 OSC11 注入行为。mock 层 10 条 C-CSI 已证伪 9 类控制序列的泄漏路径，real 层人工确认终端行为的边际收益低，可按需执行。
