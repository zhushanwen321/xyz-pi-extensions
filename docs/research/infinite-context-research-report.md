# LLM 无限上下文 / 长期记忆 方案搜索报告

> 搜索时间: 2026-05-28  
> 搜索工具: AnySearch (academic.search + 通用搜索)  
> 共执行 13 个查询，覆盖学术 + 技术 + 产品三个维度

---

## 一、方案分类总览

| 类别 | 核心思路 | 代表方案 |
|------|---------|---------|
| A. 模型架构层扩展 | 修改 attention 机制本身，使模型能处理超长序列 | Infini-attention, LongRoPE, Ring Attention, Mamba/SSM |
| B. 位置编码优化 | 不改架构，优化位置编码让预训练模型外推到更长上下文 | Position Interpolation, YaRN, LongRoPE, AdaGroPE |
| C. KV Cache 管理 | 推理阶段管理显存中的 KV cache，用 OS 式分页或驱逐策略 | PagedAttention/vLLM, H2O, StreamingLLM |
| D. 外部记忆系统 | 在模型上下文窗口外构建独立记忆层，按需检索注入 | MemGPT, Mem0, Zep, RAG |
| E. 上下文压缩/摘要 | 用 LLM 自身压缩或摘要历史对话，减小上下文占用 | Context Engineering Survey, Mem0 summarization |
| F. 上下文工程 (Context Engineering) | 系统化管理信息载荷的完整学科 | Context Engineering Survey (2025, 1411 citations) |

---

## 二、学术论文详细分析

### A1. Infini-attention: 无限上下文 Transformer

- **论文**: "Leave No Context Behind: Efficient Infinite Context Transformers with Infini-attention"
- **作者**: Tsendsuren Munkhdalai, Manaal Faruqui, Siddharth Gopal (Google)
- **年份**: 2024
- **arXiv**: [2404.07143](https://arxiv.org/abs/2404.07143)
- **DOI**: 10.48550/arXiv.2404.07143

**核心思路**:
在标准 Transformer attention 块中集成一个**压缩记忆 (compressive memory)**，同时支持:
- masked local attention（处理当前窗口内的 token）
- long-term linear attention（从压缩记忆中检索历史信息）

每个 attention 层同时维护两种信息通道：短期（标准 attention）+ 长期（线性 attention + 压缩记忆）。长期记忆大小有界，不随序列增长。

**适用场景**:
- 超长文档分析（1M token passkey 检索、500K 书籍摘要）
- 需要流式处理的无限对话
- 固定显存预算下的长上下文推理

**优点**:
- 内存占用有界，不随上下文增长
- 最小化架构改动，可插入现有 Transformer
- 流式推理，无需一次性加载全部上下文
- 实测在 1B/8B 模型上验证有效

**缺点**:
- 压缩记忆会丢失信息，长期检索精度受限
- 线性 attention 的表达能力弱于标准 softmax attention
- 需要模型级改动，不是纯应用层方案
- 尚无大规模生产验证

---

### A2. MemGPT: LLM 作为操作系统

- **论文**: "MemGPT: Towards LLMs as Operating Systems"
- **作者**: Charles Packer, Sarah Wooders, Kevin Lin, Vivian Fang, Shishir G. Patil, Ion Stoica, Joseph E. Gonzalez (UC Berkeley)
- **年份**: 2023
- **arXiv**: [2310.08560](https://arxiv.org/abs/2310.08560)
- **DOI**: 10.48550/arXiv.2310.08560

**核心思路**:
借鉴 OS 的**分层内存管理**（主存 vs 磁盘），设计虚拟上下文管理 (Virtual Context Management):
- **主上下文 (Main Context)**: LLM 上下文窗口内的信息，高速但有限
- **外部存储 (External Storage)**: 上下文窗口外的持久化记忆，容量大但需要显式检索
- LLM 自主决定何时在两级存储之间移动数据（类似 OS 的页面调度）
- 通过**中断机制 (interrupts)** 管理控制流，允许 LLM 在用户交互中自主管理记忆

**适用场景**:
- 超长文档分析（文档远超上下文窗口）
- 多轮长期对话（需要记住、反思、演化）
- 编码助手的长期项目理解

**优点**:
- 应用层方案，不需要修改底层模型
- LLM 自主管理记忆，灵活性强
- 已有开源实现 (memgpt.ai)，后被重新命名为 Letta
- 架构类比清晰（OS 内存管理）

**缺点**:
- LLM 自主管理记忆的可靠性取决于模型能力
- 中断机制增加系统复杂度
- 两级存储间的数据移动有延迟
- 对编码助手场景的针对性设计不足

---

### A3. LongRoPE: 将上下文扩展到 200 万 token

- **论文**: "LongRoPE: Extending LLM Context Window Beyond 2 Million Tokens"
- **作者**: Yiran Ding et al. (Microsoft)
- **年份**: 2024
- **会议**: ICML 2024
- **链接**: [proceedings.mlr.press/v235/ding24i.html](https://proceedings.mlr.press/v235/ding24i.html)

**核心思路**:
发现 RoPE 位置编码中存在**两种非均匀性 (non-uniformities)**，利用这些非均匀性进行更高效的位置插值:
1. 通过高效搜索识别并利用非均匀性，提供更好的微调初始化
2. **渐进式扩展策略**: 先微调到 256K → 再进行第二次位置插值到 2048K
3. 在 8K 长度上重新调整，恢复短上下文性能

**适用场景**:
- 需要极长上下文但模型架构受限的场景
- 预训练模型的长上下文扩展

**优点**:
- 首次将上下文扩展到 2048K (2M) token
- 只需约 1000 步微调
- 保持短上下文性能
- 保留原始架构，可复用已有优化

**缺点**:
- 仍需微调，非零成本
- 2M 上下文的推理成本极高
- 扩展后的模型在中间长度可能有性能波动
- 不解决根本问题——只是推迟了上限

---

### A4. Position Interpolation (PI): 位置插值扩展上下文

- **论文**: "Extending Context Window of Large Language Models via Positional Interpolation"
- **作者**: Shouyuan Chen et al. (Meta)
- **年份**: 2023
- **arXiv**: [2306.15595](https://arxiv.org/abs/2306.15595)

**核心思路**:
对 RoPE 位置编码的输入位置索引进行**线性缩小 (linear down-scale)**，映射到原始训练的上下文窗口内，而非外推到训练范围之外。理论上，插值的注意力得分上界比外推小约 600 倍。

**适用场景**:
- 快速扩展预训练模型的上下文窗口
- LLaMA 系列模型的标准扩展方法

**优点**:
- 最少 1000 步微调即可扩展到 32K
- 理论分析完整
- 保留原架构，兼容现有优化

**缺点**:
- 线性插值在更远位置信息密度降低
- 扩展倍数有限（通常 8x-16x）
- 对位置敏感的任务（如代码）可能表现下降
- 被 LongRoPE/YaRN 等后续方案超越

---

### A5. PagedAttention / vLLM: OS 式 KV Cache 管理

- **论文**: "Efficient Memory Management for Large Language Model Serving with PagedAttention"
- **作者**: Woosuk Kwon et al. (UC Berkeley)
- **年份**: 2023
- **会议**: SOSP 2023
- **DOI**: 10.1145/3600006.3613165

**核心思路**:
将 OS 的**虚拟内存 + 分页**概念引入 KV cache 管理:
- KV cache 不再连续分配，而是分页存储
- 消除显存碎片和冗余复制
- 支持 KV cache 在请求内和跨请求的共享（如 beam search、parallel sampling）

**适用场景**:
- LLM 推理服务的高吞吐部署
- 需要同时处理大量请求的在线服务

**优点**:
- 接近零 KV cache 内存浪费
- 2-4x 吞吐提升
- 开源 (vllm-project/vllm)，已成为行业标准
- 支持灵活的 KV cache 共享

**缺点**:
- 解决的是推理服务效率问题，不是上下文长度问题
- 分页表管理有额外 CPU 开销
- 对单请求超长上下文帮助有限（仍受总显存限制）

---

### A6. H2O: Heavy-Hitter Oracle: KV Cache 驱逐策略

- **论文**: "H2O: Heavy-Hitter Oracle for Efficient Generative Inference of Large Language Models"
- **年份**: 2023
- **arXiv**: [2306.14048](https://arxiv.org/abs/2306.14048)

**核心思路**:
在生成过程中，KV cache 只保留**重要 token (heavy-hitters)**:
- 基于注意力得分识别重要 token
- 采用混合策略：位置衰减 + 重要性调制
- 最近 token + 重要历史 token 保留，其余驱逐

**适用场景**:
- 受 GPU 显存限制的长上下文推理
- 需要在固定显存预算内处理尽可能长上下文的场景

**优点**:
- 显著减少 GPU 内存占用
- 推理速度提升
- 质量损失可控

**缺点**:
- 驱逐是不可逆的，驱逐后无法恢复信息
- 重要性评估依赖启发式，可能遗漏关键信息
- 对需要精确回忆的场景（如 passkey 检索）有风险

---

### A7. Context Engineering Survey: 上下文工程全景

- **论文**: "A Survey of Context Engineering for Large Language Models"
- **作者**: Lingrui Mei, Jiayu Yao 等 (15 人)
- **年份**: 2025
- **arXiv**: [2507.13334](https://arxiv.org/abs/2507.13334)
- **DOI**: 10.48550/arXiv.2507.13334
- **规模**: 166 页, 1411 篇引用

**核心思路**:
将上下文管理上升为一门正式学科——**上下文工程 (Context Engineering)**，超越简单的 prompt 设计，系统化优化 LLM 的信息载荷。提出三层组件模型:
1. **上下文检索与生成 (Context Retrieval & Generation)**: prompt 生成 + 外部知识获取
2. **上下文处理 (Context Processing)**: 长序列处理、自精炼、结构化信息整合
3. **上下文管理 (Context Management)**: 记忆层级、压缩、优化

以及四种系统实现:
1. RAG（检索增强生成）
2. 记忆系统（持久交互）
3. 工具集成推理
4. 多 Agent 系统

**关键发现**:
> "当前模型在理解复杂上下文方面表现出色，但在生成同等复杂度的长文本输出方面存在明显局限。"

**适用场景**:
- 作为整个领域的路线图和参考框架
- 指导系统设计决策

**优点**:
- 最全面的上下文管理综述 (1411 citations)
- 统一框架覆盖所有主流方法
- 揭示了理解 vs 生成的不对称性这一关键研究空白

**缺点**:
- 综述性质，不提供新的技术方案
- 框架较为抽象，需要结合具体场景落地

---

### A8. Mamba / SSM: 状态空间模型替代 Transformer

- **论文**: "Transformers are SSMs: Generalized Models and Efficient Algorithms Through Structured State Space Duality"
- **作者**: Albert Gu, Tri Dao (Carnegie Mellon / Princeton)
- **年份**: 2024
- **arXiv**: [2405.21060](https://arxiv.org/abs/2405.21060)

**核心思路**:
揭示 Transformer attention 和状态空间模型 (SSM) 的**数学对偶性**:
- 通过结构化半可分矩阵 (semiseparable matrices) 的分解连接两类模型
- 设计 Mamba-2 架构，核心层比 Mamba 快 2-8x
- SSM 的计算复杂度与序列长度线性相关（而非 Transformer 的二次方）

**适用场景**:
- 超长序列建模
- 实时推理（线性复杂度）
- 替代 Transformer 的通用序列建模

**优点**:
- 线性计算复杂度，天然支持长序列
- 推理速度快
- 理论框架优雅

**缺点**:
- 在需要精确回忆特定 token 的任务上弱于 Transformer
- 生态系统不如 Transformer 成熟
- 与现有 Transformer 基础设施兼容性差

---

### A9. Long Context Extension 技术综述

- **论文**: "The What, Why, and How of Context Length Extension Techniques in Large Language Models -- A Detailed Survey"
- **年份**: 2024
- **arXiv**: [2401.07872](https://arxiv.org/abs/2401.07872)

**核心思路**:
全面综述上下文扩展技术，涵盖:
- 为什么需要扩展上下文
- 扩展的固有问题和挑战
- 现有策略分类: 架构修改、位置编码修改、注意力机制修改、微调策略
- 评估方法和不一致性

**关键分类**:
- **训练阶段扩展**: 修改训练过程
- **微调阶段扩展**: 在已有模型上进行适配
- **推理阶段扩展**: 不修改模型，在推理时处理

---

### A10. AdaGroPE: 无训练的上下文扩展

- **论文**: "Extending LLM Context Window with Adaptive Grouped Positional Encoding"
- **年份**: 2025
- **会议**: ACL 2025
- **链接**: [aclanthology.org/2025.acl-long.28.pdf](https://aclanthology.org/2025.acl-long.28.pdf)

**核心思路**:
提出 **Adaptive Grouped Positional Encoding (AdaGroPE)**:
- 无需训练 (training-free)
- 即插即用 (plug-and-play)
- 自适应分组位置编码

**适用场景**:
- 无法进行微调的场景
- 快速验证长上下文能力

**优点**:
- 零训练成本
- 即插即用

**缺点**:
- 扩展效果可能不如微调方案
- 适用于特定位置编码类型

---

### A11. CAP 原则: LLM 推理的三角权衡

- **论文**: "The CAP Principle for LLM Serving: A Survey of Long-Context Large Language Model Serving"
- **年份**: 2024
- **arXiv**: [2405.11299](https://arxiv.org/abs/2405.11299)

**核心思路**:
借鉴数据库的 CAP 定理，提出 LLM 推理服务的**三角权衡**:
- **C** (Context Length): 上下文长度
- **A** (Accuracy): 推理精度
- **P** (Performance): 推理性能

任何优化最多只能同时满足其中两个目标。这是一个指导性原则（非严格定理），帮助设计者理解固有权衡。

**适用场景**:
- 指导长上下文推理系统的设计决策
- 理解各方案的根本限制

---

## 三、产品/工程方案分析

### P1. Mem0: 生产级 AI Agent 长期记忆

- **论文**: "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"
- **作者**: Prateek Chhikara, Dev Khant, Saket Aryan, Taranjeet Singh, Deshraj Yadav
- **年份**: 2025
- **arXiv**: [2504.19413](https://arxiv.org/abs/2504.19413)

**核心思路**:
面向生产环境的记忆中心架构:
- **动态提取**: 从对话中自动提取关键信息
- **整合去重**: 将新信息与已有记忆合并，消除冲突
- **按需检索**: 根据当前对话检索相关记忆
- **图记忆变体**: 用图结构捕捉记忆间的复杂关系

**评估结果 (LOCOMO benchmark)**:
- 比 OpenAI 方案提升 26% (LLM-as-Judge)
- 图记忆变体额外提升 2%
- p95 延迟降低 91%
- Token 成本节省 >90%

**适用场景**:
- 多轮长期对话
- 个性化 AI 助手
- 编码助手的用户偏好和项目记忆

**优点**:
- 生产级性能和可靠性
- 显著降低延迟和成本
- 图记忆增强关系推理
- 开源可用

**缺点**:
- 提取质量取决于 LLM 能力
- 记忆冲突处理可能不完美
- 图记忆增加系统复杂度

---

### P2. Zep: AI Agent 记忆服务

- **类型**: 商业产品 + 开源
- **网站**: zep.ai

**核心思路**:
面向 AI Agent 的**即用型记忆服务**:
- 从对话历史中提取事实 (facts)
- 自动维护用户画像、实体关系
- 提供多种记忆类型：短期对话记忆、长期事实记忆、知识图谱

**适用场景**:
- 快速集成记忆能力到现有 Agent
- 不想自建记忆基础设施的团队

---

### P3. Letta (原 MemGPT)

- **类型**: 开源项目
- **网站**: letta.com (原 memgpt.ai)

**核心思路**:
MemGPT 论文的工程化实现:
- 将 LLM 作为操作系统内核
- 提供文件系统式的持久化记忆
- Agent 自主决定记忆的读写和整理
- 支持 multiple memory tiers

**适用场景**:
- 需要完全自主记忆管理的 Agent
- 长期对话型助手

---

### P4. Google Gemini 1.5 Pro: 原生 1M-2M token 上下文

- **类型**: 商业模型
- **架构特点**:
  - 原生支持 1M token 输入（实验性 2M）
  - 基于 MoE (Mixture of Experts) 架构
  - 高效 attention 实现（推测使用了 sparse attention + 优化 KV cache）

**适用场景**:
- 超长文档分析
- 大规模代码库理解
- 视频理解（1M token 可编码约 1 小时视频）

**优点**:
- 原生支持，无需额外工程
- 质量在全长范围内保持稳定
- 多模态支持

**缺点**:
- 商业 API，成本高
- 延迟随输入长度增加
- 并非真正的"无限"上下文

---

### P5. Supermemory / 语义压缩方案

- **类型**: 开源方案
- **网站**: supermemory.ai

**核心思路**:
两种互补方案:
1. **语义压缩 (Semantic Compression)**: 压缩单个超长文档，使其进入普通 LLM 窗口
2. **无限对话 (Infinite Chat)**: 每轮对话只检索最相关的历史，保持多小时对话的连贯性

**适用场景**:
- 多小时持续对话
- 超长文档问答

---

## 四、方案对比矩阵

| 方案 | 层级 | 无限上下文? | 需改模型? | 实现复杂度 | 信息保留度 | 适用: 编码助手 |
|------|------|-----------|----------|----------|----------|-------------|
| Infini-attention | 模型架构 | 理论上是 | 是 | 高 | 中(压缩有损) | 低 |
| MemGPT/Letta | 应用层 | 功能上是 | 否 | 中 | 高(显式管理) | 中 |
| Mem0 | 应用层 | 功能上是 | 否 | 中 | 高(提取+检索) | 高 |
| Zep | 应用层 | 功能上是 | 否 | 低(即用) | 中高 | 高 |
| LongRoPE | 模型微调 | 2M token | 是(微调) | 高 | 高(无损) | 低 |
| PI/YaRN | 模型微调 | 32K-128K | 是(微调) | 中 | 高(无损) | 低 |
| PagedAttention | 推理系统 | 否 | 否 | 中 | 高(无损) | 中 |
| H2O/StreamingLLM | 推理优化 | 否 | 否 | 低 | 低(有损驱逐) | 低 |
| Gemini 1.5 | 模型原生 | 1M-2M | N/A | 低(用API) | 高 | 中 |
| Mamba/SSM | 模型架构 | 理论上是 | 是 | 高 | 中 | 低 |
| Context Engineering | 方法论 | 按方案 | 按方案 | - | - | - |

---

## 五、对 Pi 无限上下文设计的关键启示

### 5.1 编码助手场景的特殊性

编码助手（如 Pi, Claude Code, Cursor）与其他对话 AI 不同:
1. **代码精确性要求**: 不能用压缩/摘要替代原始代码——变量名、行号必须精确
2. **上下文结构复杂**: 混合代码、AST、文件树、git diff、对话历史、系统提示
3. **动态变化**: 文件频繁修改，需要实时更新上下文
4. **工具调用频繁**: 读写文件、执行命令等操作本身占据大量上下文

### 5.2 最具参考价值的方案

**短期可实现（不改模型）**:
1. **MemGPT 的虚拟上下文管理** — 分层记忆 + LLM 自主管理，最符合编码助手的交互模式
2. **Mem0 的动态提取+检索** — 从对话中提取关键决策、文件变更摘要、用户偏好
3. **Context Engineering Survey 的三层框架** — 检索、处理、管理的系统化设计方法论

**中长期参考（模型层）**:
4. **Infini-attention 的压缩记忆思路** — 如果未来能控制模型，可考虑在架构层集成
5. **PagedAttention 的 OS 式管理** — KV cache 分页对推理效率有直接帮助

### 5.3 核心设计决策点

基于搜索结果，Pi 的无限上下文设计需要回答:

1. **记忆层级**: 几层？(工作记忆 / 会话记忆 / 跨会话记忆 / 项目知识库)
2. **数据移动策略**: 谁决定何时在层间移动？(LLM 自主 vs 规则驱动 vs 混合)
3. **检索方式**: 向量相似度 vs 关键词 vs 结构化查询 vs 混合
4. **压缩策略**: 哪些信息可以摘要？哪些必须保留原文？(代码 vs 注释 vs 对话)
5. **一致性保证**: 压缩后的信息如何保证不与实际代码冲突？

---

## 六、推荐阅读顺序

1. **Context Engineering Survey** (arXiv:2507.13334) — 建立全景认知
2. **MemGPT** (arXiv:2310.08560) — 理解 OS 式记忆管理
3. **Mem0** (arXiv:2504.19413) — 了解最新生产级记忆方案
4. **Infini-attention** (arXiv:2404.07143) — 理解模型架构层的无限上下文
5. **LongRoPE** (ICML 2024) — 了解位置编码扩展的极限
6. **PagedAttention/vLLM** (SOSP 2023) — 了解推理层的显存管理
7. **CAP 原则** (arXiv:2405.11299) — 理解系统设计的固有权衡

---

## 七、完整论文/产品索引

| # | 名称 | 类型 | 年份 | 链接/DOI |
|---|------|------|------|---------|
| 1 | Infini-attention | 论文 | 2024 | arXiv:2404.07143 |
| 2 | MemGPT | 论文+开源 | 2023 | arXiv:2310.08560 |
| 3 | LongRoPE | 论文 | 2024 | ICML 2024 / proceedings.mlr.press/v235/ding24i |
| 4 | Position Interpolation | 论文 | 2023 | arXiv:2306.15595 |
| 5 | PagedAttention/vLLM | 论文+开源 | 2023 | SOSP 2023 / DOI:10.1145/3600006.3613165 |
| 6 | H2O (Heavy-Hitter Oracle) | 论文 | 2023 | arXiv:2306.14048 |
| 7 | Context Engineering Survey | 综述 | 2025 | arXiv:2507.13334 |
| 8 | Mamba-2 / SSD | 论文 | 2024 | arXiv:2405.21060 |
| 9 | Context Length Extension Survey | 综述 | 2024 | arXiv:2401.07872 |
| 10 | Beyond the Limits Survey | 综述 | 2024 | arXiv:2402.02244 |
| 11 | AdaGroPE | 论文 | 2025 | ACL 2025 |
| 12 | CAP Principle for LLM Serving | 论文 | 2024 | arXiv:2405.11299 |
| 13 | BAMBOO Benchmark | 论文 | 2023 | arXiv:2309.13345 |
| 14 | Mem0 | 论文+开源 | 2025 | arXiv:2504.19413 |
| 15 | RAG Survey (Gao et al.) | 综述 | 2024 | arXiv:2312.10997 |
| 16 | RAG Survey (Zhao et al.) | 综述 | 2024 | arXiv:2407.13193 |
| 17 | Zep | 产品+开源 | 2024 | zep.ai |
| 18 | Letta (原 MemGPT) | 开源 | 2024 | letta.com |
| 19 | Gemini 1.5 Pro | 商业模型 | 2024 | Google AI |
| 20 | Supermemory | 开源 | 2024 | supermemory.ai |
| 21 | MemoryRepository for AI NPC | 论文 | 2024 | IEEE / DOI:10.1109/MCC.2024.3512548 |
