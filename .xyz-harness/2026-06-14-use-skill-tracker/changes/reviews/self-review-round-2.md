# Self-Review Round 2

> **审查者局限性声明：** 同 Round 1，主 agent 自审带确认偏误。

## 审查范围

- 验证 Round 1 的 4 个 MUST_FIX + 4 个 MINOR 修复是否落地
- 查修复是否引入新问题
- 查 Round 1 未覆盖的维度（逻辑一致性、向后兼容、taste-lint 合规）

## Round 1 修复验证

| Round 1 Gap | 状态 | 验证方式 |
|------------|------|---------|
| R1-01 行号错误 | ✅ 已修 | grep "原第.*行" = 0；8 处改为函数名/注释定位 |
| R1-02 Step 7 矛盾 | ✅ 已修 | 顺序明确：deserialize→turnCount→currentTurnIndex→abandoned→过滤 |
| R1-03 契约不一致 | ✅ 已修 | scanSkillNames/isValidSkillName 签名 Interface 与 Task 2 一致 |
| R1-04 placeholder | ✅ 已修 | 四个 steering 函数全有完整实现，dismissed 误报语义清除 |
| R1-05 Out-of-Scope | ✅ 已修 | spec 新增 Out-of-Scope 章节（5 条） |
| R1-06 缓存注释 | ✅ 已修 | isValidSkillName 注释改为"实时扫描（无缓存）" |
| R1-07 列名 | ✅ 已修 | "Interface Method" → "Interface / Handler" |
| R1-08 AC-4 Task 遗漏 | ✅ 已修 | AC-4 改为 Task 3, 4 |

**Round 1 全部修复落地。**

## 新发现

| ID | 级别 | 类别 | 位置 | 问题 |
|----|------|------|------|------|
| R2-01 | MUST_FIX | 向后不兼容 | plan Interface Contracts + Task 3 Step 2/4 | triggerMatch 签名从双参 (event, ctx) 改单参 (event)，丢失 A+D 修复引入的 ctx 能力 |
| R2-02 | MINOR | 设计取舍未记录 | plan Task 1 Step 2 | TrackerParams 条件必填（start 需 name，update 需 id+status）用全 Optional 表达，typebox schema 层不强制，需明确说明运行时校验在 handler |
| R2-03 | MINOR | 文档遗漏 | plan Task 3 | 未说明 A+D 修复的 isPathInCwd 随 triggerMatch 一起删除 |

## MUST_FIX 详情

### R2-01: triggerMatch 签名向后不兼容

**证据链：**
- 现有 `core.ts:313`：`const match = config.triggerMatch(event, ctx);`（双参，A+D 修复后）
- 现有 `skill-execution.ts:108`：`triggerMatch: (event: unknown, ctx: ExtensionContext) => {...}`（使用 ctx 做 cwd 排除）
- plan Interface Contracts：`triggerMatch?: (event: unknown) => {...} | null`（单参）
- plan Task 3 Step 4 有条件注册代码：`const match = config.triggerMatch!(event);`（单参调用）

**影响：** A+D 修复让 triggerMatch 能拿到 ctx（用于 cwd 排除等场景）。plan 把签名改回单参，虽然 skill-execution 不再用 triggerMatch（改 triggerTool），但框架层的 triggerMatch 定义应该保留 ctx 参数——否则未来其他 tracker 用被动模式时拿不到 ctx，A+D 能力丢失。

**修复方向：** Interface Contracts 和 Task 3 Step 2 的 triggerMatch 签名加 ctx 参数，Task 3 Step 4 调用处传 ctx。

## MINOR 详情

- **R2-02：** TrackerParams 的 name/id/status 全 Optional。start 时 name 必填、update 时 id+status 必填，靠运行时 handler 校验（Task 3 Step 5 已有 `if (!skillName)`）。typebox 无法表达条件必填（除非用 union type，复杂度不值）。建议在 Task 1 Step 2 加一句说明。
- **R2-03：** Task 4 "删除 triggerEvent/triggerMatch" 时，A+D 修复引入的 `isPathInCwd` 函数和 `extractSkillName` 一起成了孤儿（无人调用），应一并删除。Task 4 Step 1 只提了 extractSkillName。

## 结论

Round 1 全部修复落地，未引入回归。新发现 1 个 MUST_FIX（triggerMatch 签名）+ 2 个 MINOR。需修复后进入 Round 3 收敛判定。
