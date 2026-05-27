---
verdict: fail
must_fix: 10
reviewer: independent-expert (spec review v1)
reviewed_at: 2026-05-26
spec_path: .xyz-harness/2026-05-25-ad-hoc-workflow-generation/spec.md
self_assessed_verdict: pass (overridden by reviewer)
---

# Spec Review: Ad-hoc Workflow Generation

## 1. 六元素完整性

| 元素 | 状态 | 说明 |
|------|------|------|
| Outcomes | ❌ 缺失 | 无明确的业务目标和用户价值陈述。Background 段只有一句话描述问题，没有 `Outcomes` 节声明「我们认为什么样的产出是可接受的」「用户将从什么指标衡量成功」 |
| Scope | ⚠️ 暗示 | 没有独立的 `Scope` 节。Constraints 中有部分 scope 约束（"改动限于 workflow/ 扩展"），但没有明确的 in-scope/out-of-scope 列表 |
| FRs | ✅ 完整 | 6 个 FR 覆盖核心路径，编号清晰，覆盖了智能路由、generate tool、save 命令、tmp 存储、list 增强、交互面板 6 个方面 |
| Constraints | ✅ 完整 | 6 条约束，具体可执行 |
| Decisions | ❌ 缺失 | 多处设计选择没有记录决策理由。如：为什么用 `api.sendUserMessage()` 做路由而非命令 handler 直接调用 AI？为什么临时文件不自动清理？为什么用 `new Function()` 而不是 import/require 校验？ |
| Verification | ❌ 缺失 | 无测试策略、测试范围、验收方法描述。AC 虽提供了 8 个验收条件，但缺乏整体验证方案（如是否需要集成测试、是否需要手动验证 AI 交互质量） |

**结论**：六元素缺失 3 个核心节（Outcomes / Decisions / Verification），Scope 不完整。这是 must_fix。

---

## 2. FR 之间是否矛盾

### 矛盾 1: FR2.2 自动重命名 vs FR3.3 拒绝覆盖 (must_fix)

- **FR2.2**: `workflow-generate` tool 校验 name 冲突时"自动追加 `-2` 后缀"。
- **FR3.3**: `/workflow save` 时"如果目标文件已存在，拒绝并提示冲突"。

**冲突点**：生成阶段用自动重命名策略（静默改名为 `name-2`），保存阶段用拒绝策略（显式报错）。两种场景的冲突解决策略不统一，且 spec 未解释为何不同。如果用户先 `/workflow run` 生成 `batch-review`，然后执行 `/workflow save batch-review`（此时 `.pi/workflows/batch-review.js` 已存在），`save` 会拒绝。但用户无法知道目标存在是因为 workflow-generate 没做覆盖检查？还是因为其他流程创建的？

**建议**：统一策略。要么两处都拒绝（生成时如果冲突直接报错让 AI 重试），要么两处都自动重命名（save 时自动 `-2`）。两处行为不一致会导致用户困惑。

### 矛盾 2: FR4.3 三目录扫描的优先级未定义 (must_fix)

- **FR4.3**: "config-loader 扫描时同时覆盖 `.pi/workflows/`、`~/.pi/agent/workflows/`、`.pi/workflows/.tmp/` 三个目录"。
- **FR4.4**: "扫描结果标记 `source: "saved" | "tmp"`"。

**冲突点**：`source` 枚举只有 `"saved"` 和 `"tmp"`，但扫描目录有 3 个（`.pi/workflows/`、`~/.pi/agent/workflows/`、`.tmp/`）。`.pi/workflows/` 和 `~/.pi/agent/workflows/` 都算 `"saved"`，但它们的优先级不同。现有代码（config-loader.ts）中项目级覆盖用户级。Spec 没有说明同名 workflow 扫描三目录时的优先级规则。如果同名 workflow 同时存在于 project-saved、user-saved、tmp 中，哪个优先？

**建议**：明确定义扫描优先级：`.pi/workflows/.tmp/` > `.pi/workflows/` > `~/.pi/agent/workflows/`，或说明 tmp 只参与匹配不参与去重。

---

## 3. AC 可测试性评估

| AC | 可测试性 | 评估 |
|----|----------|------|
| AC1 | ⚠️ 部分可测 | "AI 判断后生成新 workflow 脚本" 依赖 AI 行为，匹配质量需要主观评估。但"展示路径"、"用户确认后执行"可自动化验证。 |
| AC2 | ⚠️ 部分可测 | 同上，"列出匹配项让用户选择" 的匹配质量依赖 AI 判断。 |
| AC3 | ✅ 可测 | 验证文件写入路径和 `/workflow list` 输出格式。 |
| AC4 | ✅ 可测 | 验证文件移动和目标分类变化。 |
| AC5 | ✅ 可测 | 验证重命名保存。 |
| AC6 | ❌ 模糊 | "必须展示脚本路径并等待用户确认"——没有定义确认机制。是通过 tool 返回值展示后 AI 自然停顿？还是通过 Pi 的 confirm API 做模态确认？确认后如何继续执行？ |
| AC7 | ✅ 可测 | 验证 `workflow-generate` 对不合法脚本的拒绝行为。 |
| AC8 | ✅ 可测 | 验证保存操作不影响运行中的 Worker。 |

**结论**：AC1/AC2 的 AI 匹配部分只能做人工验收。**AC6 是硬伤**——"确认"机制未定义，plan 阶段无法做正确的交互流程设计。

---

## 4. 模糊术语 (must_fix 部分)

### 4.1 "匹配" (FR1.2) — must_fix

> "如果 ≥1 个已有 workflow 与用户意图匹配"

Spec 没有定义匹配的标准。是语义匹配？关键词匹配？AI 自行判断？匹配阈值是多少？同一个名字算 100% 匹配，相似名字如何处理？不同实现方式会导致差异化极大的用户体验。

**建议**：至少定义匹配的优先级：先精确匹配 name → 再匹配 description 关键词 → 最后给 AI 自行判断。或明确这是 AI 的职责范围，但说明 AI 的决策边界。

### 4.2 "确认" (FR1.3, AC6) — must_fix

> "所有 workflow 执行前必须让用户确认"

Spec 多处提到"让用户确认"，但从未定义确认的具体交互机制：
- 是 tool 返回后 AI 自然停顿，用户发下一轮消息确认？
- 还是用 `ctx.ui.confirm()` 或 `ctx.ui.select()` 做模态确认？
- 还是通过 `api.sendUserMessage()` 将问题抛回给 AI？
- 这个过程是否消耗一个 AI turn？

**建议**：明确定义确认流程。如果走到 confirmation 步骤时不消耗额外 turn（通过 steering 机制），还是需要用户主动发消息。

### 4.3 "可用 workflow" 的范围 (FR1.1)

Spec 说"所有可用 workflow（saved + tmp）"，AC2 说"已有匹配的 batch-review workflow"——这里"已有"是指 saved 还是包括 tmp？如果是临时生成后未保存的 workflow，是否也算"已有"并被列入匹配？

**建议**：明确说明匹配范围包括 saved + tmp，或者分开处理。

### 4.4 `.pi/workflows/` 与用户级路径

CLAUDE.md 明确指出 workflow 存放在 `.pi/workflows/`（项目级）和 `~/.pi/agent/workflows/`（用户级）两个路径。Spec 的 FR4.3 提到了三个目录（含用户级），但 FR3、FR5、FR6 中仅提及 `.pi/workflows/`，未说明 save 命令如何处理用户级路径。用户级路径的 workflow 能否被 save 覆盖？

**建议**：统一 spec 中所有涉及文件路径的描述，明确项目级/用户级的交互规则。

---

## 5. 错误/失败场景覆盖

### 未覆盖的错误场景

| 场景 | 影响 | 严重度 |
|------|------|--------|
| workflow-generate 语法校验失败，未定义错误返回格式 | 无法展示有意义的错误信息 | 中 |
| IO 错误：磁盘满、权限不足、文件锁 | 静默失败或未处理的异常 | 高 |
| `/workflow list` 时 `.tmp/` 目录不存在（首次使用，尚未写入） | 可能抛出找不到目录的错误 | 中 |
| 删除正在运行的 workflow 脚本 | 可能导致 Worker 崩溃或悬挂 | 高 |
| Save 时源文件（`.tmp/{name}.js`）已被删除 | 未定义行为 | 中 |
| 同一 session 中并发 generate 同名 workflow（竞态） | `-2` 后缀链可能导致 `name-2-2-2` | 低 |

**建议**：至少覆盖 IO 错误（读/写失败）、临时目录不存在的场景、删除运行中脚本的防护。

---

## 6. 其他问题

### 6.1 Complexity Assessment 可信度

Spec 自评 L1（单扩展内功能增强），涉及"4 个文件改动 + 1 个新 tool"。基于对现有代码的审查：

- **commands.ts**：需要新增 `/workflow save` 子命令、`/workflow <prompt>` 智能路由（含可用 workflow 列表传递），改动量**大于** L1 预期
- **config-loader.ts**：需要新增 `.tmp/` 目录扫描和 `source` 标记
- **widget.ts**：需要新增 `[tmp]/[saved]` 标签、增强交互面板的 action 选项
- **index.ts**：需要注册 `workflow-generate` tool

实际涉及文件数基本匹配，但智能路由需要的 `api.sendUserMessage()` 中传递可用 workflow 列表的逻辑比 spec 描述的复杂（需要序列化列表、拼接提示词），建议评估为 L2 或分两个 task。

### 6.2 现有代码的约束未考虑

现有 commands.ts 的 `default` handler 已经有一个 `api.sendUserMessage()` 实现，但只发送固定提示。FR1.1 要求传递"所有可用 workflow（saved + tmp）的 name + description"。这意味着需要在命令 handler 中调用 config-loader 获取 workflow 列表并序列化到消息中。Spec 未提及这个实现约束。

### 6.3 FR5.1 的展示格式与 FR5.2 矛盾

FR5.2 说"不显示完整提示词或脚本内容"，但 FR5.1 的示例格式只显示 name + description，两者一致。但 AC3 要求显示 `[tmp]` 标签，而 FR5.1 的格式示例通过"Saved:" / "Temporary:" 分区展示，没有用 `[tmp]`/`[saved]` 标签。不如统一为标签方式（如 FR6.1），避免两套标识方式。

---

## 7. Must-Fix 汇总

| # | 问题 | 所在位置 | 类型 |
|---|------|----------|------|
| 1 | 缺少 **Outcomes** 节 | 全局 | 结构缺失 |
| 2 | 缺少 **Decisions** 节（api.sendUserMessage、new Function、不自动清理等无决策记录） | 全局 | 结构缺失 |
| 3 | 缺少 **Verification** 节（测试策略/范围） | 全局 | 结构缺失 |
| 4 | **FR2.2 自动 `-2` 后缀** vs **FR3.3 拒绝覆盖** 冲突 | FR2.2 / FR3.3 | FR 矛盾 |
| 5 | **同名 saved/tmp workflow 优先级**未定义（FR4.3 扫描三目录，FR4.4 只有两种 source） | FR4.3 / FR4.4 | 设计缺陷 |
| 6 | **"确认"机制未定义**（AI 暂停？模态框？下轮对话？） | FR1.3 / AC6 | 术语模糊 |
| 7 | **"匹配"标准未定义**（语义/关键词/AI 自行判断） | FR1.2 | 术语模糊 |
| 8 | **用户级 workflow 路径被忽略**（FR3/FR5/FR6 只提 `.pi/workflows/`） | FR3 / FR5 / FR6 | 覆盖缺失 |
| 9 | **错误场景未覆盖**（IO 错误、语法校验失败返回格式、删除运行中脚本） | FR2.2 / 全局 | 覆盖缺失 |
| 10 | **交互面板 Save 操作底层逻辑未定义**（FR6.2 Save 是通过 save 命令实现还是直接 fs 操作） | FR6.2 | 设计缺陷 |

---

## 8. 总体评估

**Verdict: fail**

Spec 的核心功能路径（generate → confirm → run → save → list）清晰，FR 的 6 个方面覆盖了主要用户旅程，AC 中 5/8 可自动化验证。但存在以下硬伤使得其不适合直接进入 plan 阶段：

1. **FR 级矛盾**（-2 后缀 vs 拒绝覆盖）会导致 plan 阶段基于矛盾的需求做设计，实现时才发现冲突。
2. **六个关键术语未定义**（确认/匹配/可用范围等），plan 阶段无法做出正确的交互流程决策。
3. **缺少三个核心节**（Outcomes/Decisions/Verification），使得 spec 缺乏目标约束和验证锚点。

**建议修复方式**：
- 补充 Outcomes、Decisions、Verification 三节
- 统一 FR2.2 和 FR3.3 的冲突策略（推荐全部采用拒绝+显式错误）
- 定义"确认"交互机制（推荐 tool 返回后 AI 自然停顿，用户手动输入确认）
- 定义"匹配"的优先级规则
- 补充错误场景处理
- 统一标签方式（`[tmp]`/`[saved]`），废弃分区展示
