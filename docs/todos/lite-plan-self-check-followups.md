# lite-plan 自检清单执行率改进

> 来源：`.xyz-harness/workflow-discovery-manifest/retrospect.md` 改进项 5、6

## 症状

本次 topic 的 plan machine check 反复 fail 3 轮：
1. 第 1-2 轮：E2E 表无「测试层」列（2 条未标 mock/real）
2. 第 3 轮：缺 real 层用例

lite-plan SKILL.md 行 261、443 已明确要求 "每条标测试层，mock+real 各≥1"，但 AI 写 plan 时跳过了自检。

同时 E3（real 层 + manual executor）的 `requiresScreenshot=true` 与 manual 验证方式矛盾——real 层若用 vitest 跑（如本次 E3 fixture），不需要 screenshot；manual 验证也不一定有截图。

## 根因

- **自检跳过**：lite-plan 自检清单长（~15 项），AI 选择性遵守，machine check 失败后才补救
- **一致性缺失**：requiresScreenshot 与 executor 无交叉校验（real + manual 可 false，real + vitest 应 false，real + browser 应 true）

## 改进方向

### 短期（改 lite-plan SKILL.md）

1. **machine check 前置预检**：在 Step 5（定稿）自检清单中，将 machine check 会拦截的项标 `[BLOCK]`（测试层标注、real 层用例），AI 必须逐条确认
2. **requiresScreenshot 一致性校验**：自检加一条 "real + manual/vitest → requiresScreenshot=false；real + browser → true"

### 长期（改 cw plan gate）

3. **plan gate 报错定位到行**：machine check 失败时，不只说 "E2E 表无测试层列"，而是指出具体哪条 E* 未标（如 "E2 缺测试层标注"），减少 AI 试错

## 追踪

- 归属：`extensions/coding-workflow/skills/lite-plan/SKILL.md`
- 状态：待办（下次改 lite-plan skill 时一并处理）
