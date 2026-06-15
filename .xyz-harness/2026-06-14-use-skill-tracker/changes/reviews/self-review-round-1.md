# Self-Review Round 1 — spec.md + plan.md

> **审查者局限性声明：** 本审查由主 agent（plan 的作者）执行，带**确认偏误**——对自己写的 plan 倾向于"觉得对"。结论可信度低于独立 subagent 审查。仅作为豁免 gate 后的自检，不替代独立审查。

## 审查范围

- spec.md（verdict: pass）
- plan.md（verdict: pass, complexity: L1）
- spec-plan 一致性

## 发现汇总

| ID | 级别 | 类别 | 位置 | 问题 |
|----|------|------|------|------|
| R1-01 | MUST_FIX | 行号错误 | plan Task 1/3/4 | 行号大面积偏差，会误导实施者定位 |
| R1-02 | MUST_FIX | 指令矛盾 | plan Task 3 Step 7 | reconstructState 插入位置描述自相矛盾 |
| R1-03 | MUST_FIX | 契约不一致 | plan Interface Contracts | scanSkillNames 签名与 Task 2 实现不符 |
| R1-04 | MUST_FIX | placeholder | plan Task 4 Step 2 | 三个 steering + promptGuidelines 的 dismissed 改写只说"同样替换"，涉语义改写无完整内容 |
| R1-05 | MINOR | spec 缺漏 | spec.md | 无集中 Out-of-Scope 声明 |
| R1-06 | MINOR | 注释不一致 | plan Task 2 | isValidSkillName 注释说"缓存"，实现无缓存 |
| R1-07 | MINOR | 格式 | plan Coverage Matrix | "Interface Method" 列名对 AC-3/4/5/9/10 不准确（非 method） |
| R1-08 | MINOR | 覆盖不全 | plan Coverage Matrix | AC-4 只写 Task 4，遗漏 Task 3 的框架支持 |

## MUST_FIX 详情

### R1-01: 行号大面积错误

plan 大量"替换原第 X-Y 行"指令，实际行号偏差：

| 引用 | plan 说 | 实际 | 偏差 |
|------|--------|------|------|
| TRACKER_ENTRY_PREFIX 区 | 第 11-36 行 | 第 14-35 行 | +3 |
| TrackedItemStatus | 第 44-49 行 | 第 41 行起 | -3 |
| TrackerDetails | 第 82-88 行 | 第 77 行起 | -5 |
| TrackerParams | 第 89-104 行 | 第 88 行起 | -1 |
| deserializeState | 第 125-170 行 | 第 135 行起 | +10 |
| core.ts reconstructState | 第 140-179 行 | 第 236 行起 | **+96** |
| core.ts triggerEvent handler | 第 197-228 行 | 第 306 行起 | **+109** |
| core.ts turn_end | 第 230-264 行 | 第 349 行起 | **+119** |
| skill-execution.ts skillExecutionConfig | 第 64-137 行 | 第 88 行起 | +24 |

**根因：** 凭记忆写行号，未核对。core.ts 偏差最大（+96~119），types.ts/skill-execution.ts 偏差较小。

**缓解因素：** 大部分指令同时给了相对位置描述（如"persistState 之后"、"needsPersist 之后"），行号错时仍可定位。但"替换第 X-Y 行"这种绝对行号指令会误导。

**修复方向：** 删除所有"原第 X-Y 行"绝对行号，改为"函数名 + 相对位置"定位（如"reconstructState 函数内，deserializeState 调用之后"）。

### R1-02: reconstructState Step 7 指令矛盾

plan Task 3 Step 7 同一段内三处矛盾描述：
1. "deserializeState 之后、`// 过滤终态 item` 之前，插入" → 此时 currentTurnIndex 是旧值
2. "此检查在恢复 currentTurnIndex 之后执行" → 与 1 矛盾
3. "调整代码顺序：先 turnCount、currentTurnIndex，再 abandoned，最后过滤终态" → 与实际代码顺序（deserialize→过滤→turnCount）冲突

实际代码顺序（core.ts:270-280）：deserialize → 过滤终态 → 算 turnCount → 赋 currentTurnIndex。abandoned 检查需要 currentTurnIndex，必须在 turnCount 之后。

**修复方向：** 明确最终顺序为 deserialize → 算 turnCount → 赋 currentTurnIndex → abandoned 检查 → 过滤终态，删除矛盾的前置描述。

### R1-03: scanSkillNames 契约不一致

Interface Contracts 写 `scanSkillNames: () -> Set<string>`（无参），Task 2 实现是 `(systemPrompt?: string): Set<string>`。

**修复方向：** 统一为 `(systemPrompt?: string) -> Set<string>`。

### R1-04: Task 4 steering 改写是 placeholder

Task 4 Step 2 只给 `loadedSteeringPrompt` 完整替换，其余三个函数 + promptGuidelines 只说"同样替换 skill_state → use_skill"。

但 dismissed 引用涉及**语义改写**，不是机械替换：
- `skill-execution.ts:52`：status=dismissed（误报）→ 应改为 cancelled 语义
- `skill-execution.ts:60`："use status=dismissed if research" → 主动声明下无"误报"，整句要重写
- `skill-execution.ts:66`：errorForceRecordPrompt 的 dismissed 分支 → 主动声明下还需吗？
- `skill-execution.ts:102`：promptGuidelines [Dismiss] 条目 → 改为 [Abandon] cancelled？

"同样替换"不够，实施者需自行推断语义。

**修复方向：** 给出三个 steering 函数 + promptGuidelines 的完整重写内容。

## MINOR 详情（简述）

- **R1-05：** spec 无集中 Out-of-Scope。"不改 Pi 核心/不迁移历史数据/不改 detectors"散落正文，建议加章节。
- **R1-06：** Task 2 isValidSkillName 注释"先查缓存"与实现（每次 scanSkillNames）矛盾。改注释即可。
- **R1-07：** Coverage Matrix "Interface Method" 列对 AC-3/4/5/9/10 填的是 handler/动作，非 method。改列名为 "Interface / Handler"。
- **R1-08：** AC-4 实现需 Task 3（框架可选 triggerEvent）+ Task 4（不配 triggerEvent），Matrix 只写 Task 4。

## 结论

4 个 MUST_FIX + 4 个 MINOR。MUST_FIX 集中在"行号不准"和"指令矛盾/placeholder"——都是实施时会直接卡住的问题。需修复后进入 Round 2。
