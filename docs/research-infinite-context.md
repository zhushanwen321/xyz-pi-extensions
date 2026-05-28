# AI Agent 无限上下文对话方案调研报告

> 搜索时间: 2026-05-28 | 搜索查询: 10 轮 advanced 模式

---

## 一、方案分类总览

业界方案可分为 **5 大类**，从底层模型架构到上层 agent 工程都有覆盖：

| 类别 | 核心思路 | 代表项目 |
|------|---------|---------|
| 模型架构级扩展 | 修改 attention 机制实现无限输入 | Infini-attention, Mamba, RWKV |
| 上下文压缩 | 压缩 prompt/token 减少占用 | LLMLingua, 500xCompressor |
| 记忆系统 | 外部存储 + 检索，模拟长期记忆 | MemGPT/Letta, Mem0, MemoryOS |
| Agent 工程层 | 文件系统/compaction/subagent 隔离 | InfiAgent, Claude Code, Qwen Agent |
| 多 Agent 协作 | 切分长上下文到多个 agent 并行处理 | Chain of Agents, Google CoA |

---

## 二、重点方案详细分析

### 1. Infini-attention (Google Research, 2024)

- **来源**: 论文 "Leave No Context Behind: Efficient Infinite Context Transformers with Infini-attention"
- **核心思路**: 在标准 Transformer attention 层中嵌入 compressive memory。每个 segment 内做 local dot-product attention，同时将历史 segment 的 KV 压缩到固定大小的 memory state 中。新 segment 的 query 可从 compressive memory 中检索历史信息。
- **适用场景**: 长文档处理、书籍摘要、长对话历史
- **优缺点**:
  - 优点: 114x 内存压缩比，1B 模型可处理 1M token 序列；理论上真正的"无限上下文"
  - 缺点: 需要修改模型架构（非即插即用），compressive memory 有信息损失，尚未被主流闭源模型采纳
- **开源**: 有非官方 PyTorch 实现 (github.com/vmarinowski/infini-attention)
- **链接**: https://arxiv.org/abs/2404.07143

---

### 2. LLMLingua 系列 (Microsoft Research)

- **来源**: 微软研究院，包含 LLMLingua / LongLLMLingua / LLMLingua-2 三个迭代版本
- **核心思路**: 用小模型（GPT-2 级别）计算 token 的困惑度(perplexity)，移除"不重要"的 token，实现 prompt 压缩。LLMLingua-2 通过 GPT-4 数据蒸馏训练 BERT 级别分类器做 token 级压缩。
- **适用场景**: RAG 检索结果压缩、长对话历史压缩、在线会议 transcript 压缩
- **优缺点**:
  - 优点: 20x 压缩比仅 1.5% 性能损失；适用于黑盒 API（GPT-4/Claude/Mistral）；LLMLingua-2 比 v1 快 3-6x
  - 缺点: 额外的小模型推理开销；压缩后的 prompt 对人类不可读；高压缩率下代码任务易丢失关键 token
- **开源**: 是，微软官方 GitHub，集成 LangChain
- **链接**: https://www.llmlingua.com / https://github.com/microsoft/LLMLingua

---

### 3. MemGPT / Letta (UC Berkeley → 商业化)

- **来源**: 论文 "MemGPT: Towards LLMs as Operating Systems"，作者 Charles Packer & Sarah Wooders
- **核心思路**: 类比操作系统内存管理，将 LLM context window 视为受限的"内存"资源。设计四层记忆层级：
  - **Tier 1 (主存)**: Message Buffer（近期对话）+ Core Memory（可编辑的固定 context block，存储用户偏好/目标）
  - **Tier 2 (外存)**: Recall Memory（完整对话历史，可搜索）+ Archival Memory（外部知识库）
  - Agent 通过 function call 自主管理记忆——决定什么放入 core memory、什么存入 archival、什么时候搜索召回
- **适用场景**: 长期个性化助手、需要跨 session 记忆的 agent、coding agent
- **优缺点**:
  - 优点: Agent 自主管理记忆（非被动存储）；在 LoCoMo 基准上优于 Mem0 (74% vs 68.5%)；完整的 agent runtime 平台
  - 缺点: 每次记忆操作消耗推理 token（agent 要"思考"存什么）；记忆质量依赖模型判断力；Letta 作为完整 runtime 有较高 lock-in
- **开源**: 是，Letta Code CLI (npm: @letta-ai/letta-code)
- **链接**: https://github.com/letta-ai/letta / https://www.letta.com

---

### 4. InfiAgent (arXiv 2601.03204, 2026)

- **来源**: 论文 "InfiAgent: An Infinite-Horizon Framework for General-Purpose Autonomous Agents"
- **核心思路**: 显式区分 **persistent task state**（持久任务状态）和 **bounded reasoning context**（有界推理上下文）。将长期状态外部化到文件系统中（file-centric representation），每步决策只从文件系统快照 + 固定窗口的近期操作重建推理上下文。context 大小严格有界，不受任务时长影响。
- **适用场景**: 长时间运行的自主 agent（跨小时/天的任务）
- **优缺点**:
  - 优点: 理论上真正的无限时间跨度；状态不依赖 LLM 的 context window
  - 缺点: 文件系统作为状态载体的读写开销；信息重建的完整性依赖 agent 的文件管理能力
- **开源**: 论文提及但未明确代码仓库
- **链接**: https://arxiv.org/abs/2601.03204

---

### 5. Mem0

- **来源**: 2025 年论文 + 商业产品
- **核心思路**: 通用记忆层（memory layer），通过被动提取（passive extraction）从对话中自动抽取事实/偏好，存储到 vector + graph 混合数据库。agent 框架无关——可接入任意 agent 框架。
- **适用场景**: 需要跨 session 记忆的对话系统、个性化推荐 agent
- **优缺点**:
  - 优点: 即插即用，不改变 agent 架构；混合 vector + graph 检索（0.7×向量相似度 + 0.3×图遍历置信度）
  - 缺点: 被动提取可能遗漏 nuanced 信息；LoCoMo 基准低于 Letta 的文件系统方案
- **开源**: 是
- **链接**: https://mem0.ai / https://github.com/mem0ai/mem0

---

### 6. MemoryOS (EMNLP 2025)

- **来源**: 北京邮电大学 + 腾讯 AI Lab, EMNLP 2025
- **核心思路**: 类比操作系统的段页式存储管理，设计三级存储架构：短期记忆 → 中期记忆 → 长期个人记忆。短期到中期采用对话链 FIFO 更新，中期到长期采用分段页面组织策略 + 热度驱动的淘汰（heat-driven eviction）。
- **适用场景**: 长对话 agent、个性化助手
- **优缺点**:
  - 优点: 明确的层级管理和淘汰策略；LoCoMo 基准上表现优秀
  - 缺点: 淘汰策略可能导致重要冷门信息丢失
- **开源**: 论文有代码
- **链接**: https://aclanthology.org/2025.emnlp-main.1318.pdf

---

### 7. Chain of Agents (Google Research)

- **来源**: Google Research Blog
- **核心思路**: 将长输入切分为 chunks，分配给多个 worker agent 顺序处理（interleaved read-process），每个 worker 将理解传递给下一个。将 O(n²) 复杂度降为 O(nk)（k 为 worker 数）。
- **适用场景**: 超长文档处理、多文档 QA
- **优缺点**:
  - 优点: 计算成本显著降低；不依赖超长 context window
  - 缺点: 顺序处理有延迟；信息在传递中可能衰减
- **开源**: 论文发布
- **链接**: https://research.google/blog/chain-of-agents-large-language-models-collaborating-on-long-context-tasks

---

### 8. Qwen Agent Context Management

- **来源**: 阿里巴巴 Qwen Agent 框架
- **核心思路**: 分级截断策略 (S1→S5)：先移除旧的非关键 tool-response → 折叠 tool-call 步骤 → 移除整轮对话 → 截断 system prompt → 最后截断用户 query。保持对话结构合理性，优先保留最新信息。
- **适用场景**: 通用 agent 框架中的 context 管理
- **优缺点**:
  - 优点: 简单实用，无需外部存储；支持"有效无限上下文"
  - 缺点: 纯截断/丢弃策略会丢失信息；记忆记录质量不佳（官方承认）
- **开源**: 是
- **链接**: https://qwenlm.github.io/Qwen-Agent/en/guide/core_moduls/context

---

### 9. Claude Code Compaction (Anthropic)

- **来源**: Anthropic 官方博客 + Martin Fowler 文章
- **核心思路**: 当 context 接近窗口上限时，用 LLM 自身对对话历史做摘要压缩（compaction）。保留架构决策、未解决 bug、实现细节，丢弃冗余 tool 输出。压缩后 agent 带着摘要 + 最近 5 个文件继续工作。
- **适用场景**: Coding agent 的长 session 管理
- **优缺点**:
  - 优点: 不依赖外部存储；保留关键信息的压缩质量较高
  - 缺点: 压缩本身消耗 token 和时间；信息损失不可避免
- **开源**: Claude Code 闭源，但 compaction 模式可参考
- **链接**: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

---

### 10. 其他值得关注的方案

| 方案 | 核心思路 | 链接 |
|------|---------|------|
| **A-MEM** | 基于 Zettelkasten 方法的 agentic memory，动态索引和链接形成知识网络 | https://openreview.net/forum?id=FiM0M8gcct |
| **Hindsight** | 从交互反馈中学习的 agent memory layer | https://github.com/vectorizeio/hindsight |
| **Graphiti (Zep)** | 时序知识图谱作为 agent memory | https://github.com/getzep/graphiti |
| **Cognee** | 混合 graph + vector 知识图谱的 memory engine | https://github.com/cognee-ai/cognee |
| **Neo4j + MCP** | 图数据库通过 MCP 为 agent 提供持久记忆 | https://dev.to/einarcesar/extending-ai-agents-by-adding-infinite-context-memory-3a7h |
| **500xCompressor** | 将长 prompt 压缩为单个特殊 token (6x-480x) | 论文发布 |
| **AgentCore Memory (AWS)** | 托管服务，多阶段 pipeline：提取→整合→检索 | https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive |

---

## 三、学术综述论文

### "Memory in the Age of AI Agents" (2025.12)

- **作者**: 复旦/清华/牛津等 46 人联合
- **贡献**: 最全面的 agent memory 综述。提出三维分类框架：
  - **Forms（存储形式）**: Token-level / Parametric / Latent
  - **Functions（功能）**: Factual / Experiential / Working memory
  - **Dynamics（动态）**: Formation → Evolution → Retrieval
- **链接**: https://arxiv.org/abs/2512.13564
- **配套**: GitHub paper list (github.com/Shichun-Liu/Agent-Memory-Paper-List) 收录 100+ 篇论文

### "A Survey of Techniques to Extend the Context Length in Large Language Models" (2024.02)

- 全面综述 context 扩展技术：位置编码扩展、滑动窗口、segment-level recurrence、structured prompting 等
- 链接: https://arxiv.org/abs/2402.02244

---

## 四、JetBrains 的实验发现

JetBrains Research (2025.12) 的实验对比了两种 context 管理策略：

| 策略 | 优点 | 缺点 |
|------|------|------|
| **LLM Summarization** | 理论上无限轮次；context 有界 | 摘要质量依赖模型；压缩损失 |
| **Observation Masking** | 简单；保留原始信息 | context 无界增长（可慢但无限） |

**关键发现**: 保留最近 10 轮对话的 observation masking 效果最好，但 context 仍会缓慢增长。LLM summarization 每 21 轮做一次摘要，可维持有界 context。

---

## 五、按 Coding Agent 场景的分类评估

对于 **coding agent** 这一具体场景，各方案的适用性：

| 方案 | 适用性 | 理由 |
|------|--------|------|
| Compaction/摘要 (Claude Code) | **最高** | 已在生产环境验证，coding 场景天然适合（文件系统已有持久状态） |
| 文件系统外部化 (InfiAgent) | **高** | Coding agent 的产物本身就是文件，file-centric 状态管理自然契合 |
| MemGPT/Letta 层级记忆 | **高** | Letta Code 已是 coding agent；Core Memory 存架构决策，Archival 存代码片段 |
| LLMLingua 压缩 | **中** | 代码 token 压缩风险高（函数名/参数不可丢）；适合 tool output 压缩 |
| Infini-attention | **低** | 需要修改底层模型，coding agent 无力控制模型架构 |
| 多 Agent 切分 (CoA) | **中** | 适合大规模代码库检索任务，不适合实时 coding |
| Qwen Agent 截断 | **中低** | 纯丢弃策略丢失关键信息，coding 场景对信息完整性要求高 |

---

## 六、关键趋势总结

1. **"Infinite context" = context engineering**：业界共识是无限上下文不是靠一个超大窗口实现的，而是靠系统化的 context 管理（Sarah Wooders: "Agent memory = Context engineering"）
2. **文件系统 > 专用 memory 工具**：Letta 实验表明简单文件搜索在 LoCoMo 基准上优于 Mem0 的 graph/vector 方案 (74% vs 68.5%)
3. **Compaction 是当前最实用的方案**：Claude Code、JetBrains、Anthropic 官方都推荐 LLM 自摘要
4. **Agent 自主管理 vs 被动存储的权衡**：Letta 让 agent 自己决定存什么（灵活但不可预测），Mem0 被动抽取（稳定但可能遗漏）
5. **开源生态爆发**：2025-2026 年涌现大量 agent memory 项目（MemOS, A-MEM, Hindsight, Cognee, Graphiti 等），但尚未出现明显赢家
6. **Anthropic 规划"无限上下文"**：2026 Code with Claude 大会宣布正在开发无限 context window，结合 multi-agent coordination 和 dreaming（离线记忆整理）

---

## 七、参考资源

- Agent Memory 论文列表: https://github.com/ShichunC3I/Awesome-Memory-for-Agents
- Agent Memory 另一列表: https://github.com/Shichun-Liu/Agent-Memory-Paper-List
- Memory 综述论文: https://arxiv.org/abs/2512.13564
- Context 扩展综述: https://arxiv.org/abs/2402.02244
- Anthropic context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Martin Fowler context engineering: https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html
- JetBrains context management 研究: https://blog.jetbrains.com/research/2025/12/efficient-context-management
- Arize agent harness context: https://arize.com/blog/context-management-in-agent-harnesses
