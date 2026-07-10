# 测试策略

> **always-current**。记录**测试策略**（金字塔 / 边界 / 门禁 / 约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；coding-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 测试金字塔与边界

- **单元测试**：纯格式化 / 计算逻辑从 `index.ts` 提取到独立模块（`format.ts` / `speed.ts`），不依赖 Pi 运行时
- **集成测试**：Pi 运行时类型通过 `PlainPallet` / `plainThemeFg` 等无 ANSI 替代品绕过
- **SDK 契约测试**：凡调用 `pi.on()` / `registerTool()` / 读 `ctx.*` 的代码须有契约测试（模板：`extensions/subagents/src/__tests__/sdk-contract.test.ts`）

## 覆盖率门禁

- 框架：vitest（`^4.1.8`），禁止 `node:test`
- 测试文件：`src/__tests__/*.test.ts`，每个有测试的包需 `vitest.config.ts`
- pre-commit 按需触发：仅 staged 文件涉及的包有 `src/__tests__/` 时运行

## Mock 与测试数据约定

- 测试只 import 被测模块的导出函数，不 import Pi SDK
- vitest.config.ts alias：`extensions/*` 映射 `@zhushanwen/pi-quota-providers`；`shared/*` 映射 `@mariozechner/*` types stub

## 不可回退基线（Regression Baseline）

> coding-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### RB-1 方向键/功能键不得泄漏为可见字符  [from: fix-ask-user-arrow-leak]

- **用例**：freeform/commment 模式发送任意 special key（方向键/F1-F12/ctrl+arrow/alt+arrow），draftText 不得包含 `[`、`C`、`[` 等转义序列残片
- **破坏后果**：用户输入区出现乱码（[D[D[C），破坏表单提交
- **测试文件**：`extensions/ask-user/src/__tests__/component-keymap.test.ts` + `w3-regression.test.ts`
- **相关约束**：NFR CS-1（parseKey 白名单）

### RB-2 草稿跨 tab 切换保持  [from: fix-ask-user-arrow-leak]

- **用例**：Q1 输入文本 → 切到 Q2 → 切回 Q1 → 草稿恢复
- **破坏后果**：用户输入丢失，体验倒退
- **测试文件**：`extensions/ask-user/src/__tests__/w2-draft-hint.test.ts`

### RB-3  [from: fix-ask-user-unknown-csi-leak]

- **断言**：handleEditorInput fallback 分支投递 ESC 开头的未识别控制序列（OSC-BEL/OSC-ST/DA1/DA2/DCS/APC/SS3/unknown CSI/连续序列），editorText 不含任何控制序列可见残渣
- **破坏即**：中（终端自发序列/OSC 响应/DA 响应在 ask_user 编辑器活跃时乱码渗入）
- **关联约束**：RISK-2（StdinBuffer 序列拆分假设）
- **测试文件**：`extensions/ask-user/src/__tests__/component-keymap.test.ts`（C-CSI-1~10 + C-CSI-R1~R7，17 条用例）

### {待沉淀 RB-N}  [from: {topic}]

- **用例来源**：⑥验收清单 {ID}
- **断言**：{一句话}
- **破坏即**：{事故级别}
- **关联约束**：NFR {S-N / C-N / ...}
