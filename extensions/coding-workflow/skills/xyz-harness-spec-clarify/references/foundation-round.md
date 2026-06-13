# Round 1: Foundation

Round 1 只执行一轮，建立事实基础、评估复杂度、拆解需求、选定方案。产出喂给 Round 2+ 的收敛循环。

```
Step 1: Quick Overview            → 建立事实基础（项目结构、依赖、已有代码）
Step 2: complexity-assess         → 评估 L0/L1/L2，决定后续流程层级
Step 3: Requirement Decomposition → 按复杂度结果拆解需求/技术方面 + 优先级
Step 4: Clarifying Questions      → 按 Decomposition Map 分层提问（先骨架后血肉）
Step 5: Approach Selection        → 2-3 方案 + 用户选择
```

## Step 1: Quick Overview

快速浏览项目结构、依赖、README、相关已有代码，建立基本上下文。

**最低观察要求**（complexity-assess 和 Decomposition 依赖这些）：
- 技术栈（框架、存储、关键依赖）
- 需求涉及的模块/目录范围（初步定位）
- 是否有相关已有代码（类似功能、可复用模式）

[MANDATORY] 不可跳过——后续两步的评估和拆解质量直接取决于此。如果需求涉及的模块在 Quick Overview 中没看到，必须扩大浏览范围。

## Step 2: complexity-assess

[MANDATORY] 提问和拆解之前先评估复杂度。**复杂度决定拆解的层级**——L0 直接对整个需求拆解；L1/L2 先划分子系统（decompose），每个子系统再各自拆解。

评估维度（任一维度命中 L2 则整体 L2；任一 L1 则整体 L1。就高不就低）：

| 维度 | L0 | L1 | L2 |
|------|-----|-----|-----|
| 涉及模块数 | ≤ 1 | 2-5 | >5 或跨子系统 |
| 接口变更 | 无或简单 | 模块间接口 | 子系统间 + 外部 API |
| 数据模型 | 不变 | 局部新增/修改 | 新实体 + 数据迁移 |
| 非功能需求 | 无 | 1 项 | 2+ 项 |
| 已有约束 | 无 | 需兼容现有模式 | 需跨团队协调 |

**执行方式（方案 A：AI 评估 + tool 传入）：**

评估本身是语义判断，是 AI 的能力。但评估结果需要被 orchestrator 消费（决定后续 pipeline 走 L0 还是 L1/L2 路由），因此通过 tool 结构化写入 state。

- **第一步（AI 评估）**：AI 按 5 个维度分别评分（就高不就低），得出 level + reasoning。这是 AI 的思考过程，不需要调任何 tool
- **第二步（tool 传入）**：在 coding-workflow 中，AI 调用 `coding-workflow-run-op(action="complexity-assess", ...)`，传入第一步的评估结果（level + 各维度评分 + reasoning）。orchestrator 的 A9 操作接收参数，写入 `workflowState.complexity`。tool 本身不做评估，只是把 AI 的结果结构化写入 state 的通道
- **独立使用（不在 coding-workflow）**：跳过第二步，AI 将结果（level + 各维度评分 + reasoning）直接写入 `clarification.md` 的 Meta 章节

**为什么需要 tool**：orchestrator 要根据 complexity 决定后续 pipeline 分支（L0 直接收敛循环 vs L1/L2 先 decompose）。如果只在 markdown 里写评估结果，orchestrator 无法可靠读取。tool 保证结果以结构化形式进入 state，pipeline 路由逻辑才能消费。

**用户 override：** 评估是建议性的。用户可以说"这个涉及 3 个模块，按 L1 处理"——更新复杂度后按新级别走。

**L1/L2 的后续路径：** 评估为 L1/L2 后，Round 1 的 Step 3-5 在**系统级**执行（讨论大方向、识别子系统边界），收敛循环中触发 `decompose` 划分子系统，每个子系统再各自完整走 Round 1 → Round 2+。详见 phase spec FR-SC5。

## Step 3: Requirement Decomposition

[MANDATORY] 拆解前已知复杂度。按复杂度层级拆解：

- **L0**：直接对整个需求拆解成方面（需求/技术两大方向）
- **L1/L2**：见下文「L1/L2 的拆解层级」——两个「拆解」不能混淆

拆解方法、参考细分维度、优先级判定（Must-Now / Must-Now-Abstract / Defer-Ext）、澄清顺序详见 `references/requirement-decomposition.md`。

产出 Decomposition Map 写入 `clarification.md`。

**L1/L2 的拆解层级（区分两个「拆解」）：**

L1/L2 有两个时机相邻但性质不同的「拆解」，顺序如下：

```
Step 2: complexity-assess = L1/L2
  ↓
Step 3（系统级）: Requirement Decomposition
  → 产出「系统级 Decomposition Map」（拆大方向：有哪些子系统候选、各自大致范围）
  → 用户确认子系统划分
  ↓
（在系统级收敛循环触发）decompose 操作（A10）
  → 按 Decomposition Map 的子系统候选，产出 manifest.yaml + children/ + api-contracts.md 骨架
  → 这是「机械拆解」：落实目录结构、声明依赖关系
  ↓
（每个子系统各自）Requirement Decomposition
  → 产出「子系统级 Decomposition Map」（只拆该子系统范围内的方面）
```

| | Requirement Decomposition（Step 3） | decompose 操作（A10） |
|---|---|---|
| **产出** | Decomposition Map（方面 + 清晰度 + 优先级） | manifest + children + api-contracts |
| **时机** | Round 1 Step 3 | 系统级收敛循环中，Decomposition Map 确认后 |
| **粒度** | 识别有哪些方面要澄清 | 落实子系统目录结构和依赖 |
| **关系** | decompose 的输入——子系统候选来自 Decomposition Map | Decomposition Map 的落地实现 |

关键：**Requirement Decomposition 先识别子系统候选，decompose 再把它们落实为目录结构**。不是反过来。详见 `requirement-decomposition.md` 的「复杂度决定拆解层级」章节。

**展示给用户确认：** Decomposition Map 一次性展示给用户看全部拆解 + 优先级标注，让用户确认拆解方向和"哪些现在澄清、哪些延后"的判定。用户可推翻优先级判定。这与"一次一个问题"不冲突——Map 是整体展示，之后 Step 4 的提问仍逐个进行。

## Step 4: Clarifying Questions

[MANDATORY] 按 Decomposition Map 的优先级分层提问：

- **Pass 1（架构骨架）**：Must-Now 的技术选型/架构划分 — 决定后续走向的
- **Pass 2（核心行为）**：Must-Now 的核心 User Story / 验收标准
- **Pass 3（补充约束）**：Must-Now 的业务规则 / 接口契约 / 技术细节
- **Deferred**：Defer-Ext 项不追问，标记 `[DEFERRED-EXT]` 留给 plan 阶段

规则：
- 一次问一个问题（One question at a time 不变）
- 每个 Pass 内"先问大的、再问小的"
- 用 Step 1 的发现跳过基础问题（"项目已用 Pinia，复用同模式吗？"）
- 用户回答涉及具体模块时，dispatch on-demand scan
- 用 `ask_user` tool 做结构化提问（多选项优于开放问题）

**何时停止提问：** Decomposition Map 中所有 Must-Now 项都转为 clear；你能用具体步骤描述完整方案而无需猜测。Defer-Ext 项不阻塞停止。

## Step 5: Approach Selection

基于 Step 2-4 的理解，提出 2-3 个方案：

1. **给出推荐方案 + 推荐理由**
2. 每个方案列出 trade-off（不是优缺点列表，是具体的取舍：选 A 意味着放弃 B）
3. 方案差异应该在**架构层面**，不是命名或格式层面

用户选择后，记录：
- 选定方案 + 推理过程
- 被排除方案 + 排除理由
- 方案中的开放问题（将作为 Round 2+ 的种子 gap）

---

## 独立使用（不通过 coding-workflow）

如果不在 coding-workflow 中使用本 skill：

1. 用户描述需求 → AI 加载本 skill
2. 按 Round 1（Step 1-5）→ Round 2+（见 `convergence-loop.md`）→ Spec Generation 执行
3. **complexity-assess**：AI 自行评估，无需调用 tool，结果写入 clarification.md Meta
4. **Gate 步骤**（原 Step 12）改为自检：
   - 重新读 `clarification.md`，检查每个视角是否覆盖了所有核心操作
   - 检查 Gap Tracker 中是否有 P0/P1 open gap
   - 如果有 → 继续解决；如果无 → 完成
5. 产出 `spec.md`

**复杂度限制：独立使用模式仅支持 L0。**

L1/L2 需要多子系统协同（manifest + children + api-contracts + 跨子系统依赖检查 + 子系统级 gate 聚合），这些机制依赖 coding-workflow 的 orchestrator 管理：
- `decompose`（A10）产出 manifest/children 目录结构
- `contract-define` / `contract-check`（A11/A12）维护跨子系统合约
- `dependency-check`（A13）验证子系统依赖拓扑
- 子系统串行执行 + 每个子系统完成后 commit + compact（见 phase spec FR-SC5）

如果独立使用时 AI 评估出 L1/L2：
- **建议用户启动 coding-workflow**（`/coding-workflow <需求>`）以获得多子系统支持
- 如果用户坚持独立完成，AI 需明确告知：只能手工管理子系统划分和合约，质量保障仅靠 AI 自律，无 gate 复核

L0 在独立模式下无限制——单 topicDir、单 clarification.md、单 spec.md，不涉及多子系统协同。
