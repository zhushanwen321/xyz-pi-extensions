# AI Agent 无限上下文方案调研报告

> 调研时间：2025-05-28
> 调研范围：学术论文、开源项目、商业产品、技术博客
> 目标场景：为 Pi coding agent 设计无限上下文对话能力

---

## 目录

1. [方案分类总览](#1-方案分类总览)
2. [方案详解](#2-方案详解)
   - [A. 模型层：扩展上下文窗口](#a-模型层扩展上下文窗口)
   - [B. 架构层：分层内存管理（OS 隐喻）](#b-架构层分层内存管理os-隐喻)
   - [C. 压缩层：上下文压缩技术](#c-压缩层上下文压缩技术)
   - [D. 检索层：RAG 与知识图谱](#d-检索层rag-与知识图谱)
   - [E. Agent 层：状态外化与多 Agent 协作](#e-agent-层状态外化与多-agent-协作)
   - [F. 产品级方案](#f-产品级方案)
3. [Coding Agent 场景特别分析](#3-coding-agent-场景特别分析)
4. [方案对比矩阵](#4-方案对比矩阵)
5. [对 Pi 的启示与建议方向](#5-对-pi-的启示与建议方向)

---

## 1. 方案分类总览

业界解决无限上下文问题的方案可以分为 6 个层级：

```
┌─────────────────────────────────────────────┐
│  F. 产品级方案（Anthropic Dreaming 等）        │
├─────────────────────────────────────────────┤
│  E. 状态外化 + 多 Agent 协作                   │
├─────────────────────────────────────────────┤
│  D. RAG + 知识图谱（检索增强）                  │
├─────────────────────────────────────────────┤
│  C. 上下文压缩（LLMLingua、Summarization）     │
├─────────────────────────────────────────────┤
│  B. 分层内存管理（MemGPT/Letta）               │
├─────────────────────────────────────────────┤
│  A. 模型层扩展（Infini-Attention、长窗口模型）   │
└─────────────────────────────────────────────┘
```

实际系统中通常组合使用多个层级。

---

## 2. 方案详解

### A. 模型层：扩展上下文窗口

#### A1. Infini-Attention（Google Research, 2024）

| 项目 | 内容 |
|------|------|
| **来源** | Google Research, "Leave No Context Behind: Efficient Infinite Context Transformers with Infini-attention" (arXiv, 2024) |
| **核心思路** | 在标准 Transformer 注意力机制旁边增加一个**压缩记忆**（compressive memory），用固定大小的表示存储无限历史。结合两种注意力：局部注意力（当前 segment）+ 全局压缩注意力（历史 segment）|
| **工作原理** | 1. 输入分割为固定大小 segment（如 2048 token）<br>2. Segment 内用标准 Dot-Product Attention<br>3. Segment 间通过压缩记忆传递信息<br>4. 压缩记忆固定大小，不随输入增长 |
| **适用场景** | 超长文档分析、无限对话流 |
| **优点** | 从模型架构层面解决，不需要外部存储或检索；理论上真正无限 |
| **缺点** | 需要修改模型架构和训练流程；压缩过程会丢失细节信息；目前没有大规模商用落地 |
| **开源** | 论文公开，但无主流 LLM 直接实现 |
| **链接** | https://arxiv.org/abs/2404.07143 |

#### A2. 大窗口模型（Gemini 2M、Claude 200K 等）

| 项目 | 内容 |
|------|------|
| **来源** | Google Gemini、Anthropic Claude、Meta Llama 等 |
| **核心思路** | 直接扩展上下文窗口到 128K-2M token |
| **局限** | 二次复杂度（O(n^2)）导致计算成本爆炸；"lost in the middle" 问题——模型在长上下文中间位置的检索准确率显著下降；更大的窗口 ≠ 更好的利用 |
| **结论** | 大窗口是基础设施，但单独依赖它无法实现真正的无限上下文 |

---

### B. 架构层：分层内存管理（OS 隐喻）

#### B1. MemGPT / Letta（UC Berkeley → Letta Inc., 2023-2025）

| 项目 | 内容 |
|------|------|
| **来源** | Charles Packer, Sarah Wooders 等, "MemGPT: Towards LLMs as Operating Systems" (arXiv:2310.08560, 2023) |
| **核心思路** | **虚拟上下文管理**——借用操作系统的内存分页概念，将 LLM 上下文窗口视为受限的物理内存，通过分层存储提供"虚拟内存"的错觉。Agent 通过 function call 主动管理自己的内存 |
| **内存层级** | **Tier 1（常驻上下文）**：<br>  - 消息缓冲区（Message Buffer）：最近对话<br>  - 核心记忆（Core Memory）：可编辑的内存块，固定在上下文中，存储用户偏好、当前目标<br>**Tier 2（外部存储）**：<br>  - 回忆记忆（Recall Memory）：完整对话历史，可搜索<br>  - 归档记忆（Archival Memory）：外部知识库，支持语义检索 |
| **关键创新** | Agent 自主决定何时加载/卸载信息到上下文窗口，而非被动接受注入 |
| **Sleep-Time Compute** | Letta 2025 年新增：异步"睡眠"Agent 在空闲时整理和优化记忆，不阻塞对话 |
| **Memory Blocks** | 将上下文分割为离散的功能单元，每个 block 有独立 ID，可跨 Agent 共享 |
| **适用场景** | 长期对话 Agent、需要跨 session 记忆的助手 |
| **优点** | 理论优雅，Agent 自主管理；开源生态成熟；DeepLearning.AI 有配套课程 |
| **缺点** | 依赖 Agent 正确使用内存管理 function call（prompt engineering 依赖重）；额外 token 消耗在内存操作上；调试困难 |
| **开源** | 是（https://github.com/letta-ai/letta） |
| **链接** | https://research.memgpt.ai / https://www.letta.com |

#### B2. InfiAgent（2025）

| 项目 | 内容 |
|------|------|
| **来源** | "InfiAgent: An Infinite-Horizon Framework for General-Purpose Autonomous Agents" (arXiv:2601.03204, 2025) |
| **核心思路** | **显式分离持久任务状态和有界推理上下文**。将长期状态外部化为**文件系统**，每一步决策只从外部状态快照 + 固定大小的最近动作窗口重建推理上下文 |
| **关键区别** | 不依赖 LLM 上下文存储状态，文件系统是唯一的权威记录 |
| **优点** | 上下文大小严格有界，不受任务时长影响；状态持久化天然可靠 |
| **缺点** | 文件系统抽象可能不适合所有任务类型；需要设计良好的文件 schema |
| **开源** | 论文公开 |

---

### C. 压缩层：上下文压缩技术

#### C1. LLMLingua 系列（Microsoft Research, 2023-2024）

| 项目 | 内容 |
|------|------|
| **来源** | Microsoft Research, EMNLP 2023 + ACL 2024 |
| **核心思路** | 用小型语言模型（如 GPT-2、LLaMA-7B）计算 token 级别的信息量（perplexity），删除低信息量 token，实现 prompt 压缩 |
| **版本演进** | **LLMLingua**：基于困惑度的 token 级过滤，最高 20x 压缩<br>**LongLLMLingua**：query-aware 压缩，4x 压缩下性能提升 17.1%<br>**LLMLingua-2**：通过 GPT-4 数据蒸馏训练 BERT 级分类器，任务无关压缩，3-6x 更快 |
| **适用场景** | RAG 场景中压缩检索到的文档；长 prompt 的 token 成本优化 |
| **优点** | 无需修改 LLM 本身；与 LangChain 集成方便；开源成熟 |
| **缺点** | token 级压缩可能破坏句子连贯性；需要额外的压缩模型开销；对于代码等结构化文本效果存疑 |
| **开源** | 是（https://github.com/microsoft/LLMLingua） |
| **链接** | https://www.llmlingua.com |

#### C2. LLM Summarization（JetBrains Research, 2025）

| 项目 | 内容 |
|------|------|
| **来源** | JetBrains Research, "Cutting Through the Noise: Smarter Context Management for LLM-Powered Agents" (2025) |
| **核心思路** | 定期用 LLM 对历史对话进行摘要，用摘要替代原始历史 |
| **实验结论** | 在 250 轮对话测试中，每次摘要 21 轮、保留最近 10 轮效果最好 |
| **优点** | 理论上允许无限轮次扩展；实现简单 |
| **缺点** | 摘要过程本身消耗 token；信息逐步有损；对细节敏感的任务可能丢失关键信息 |

#### C3. 500xCompressor

| 项目 | 内容 |
|------|------|
| **核心思路** | 将大量自然语言上下文压缩为**单个特殊 token**，压缩比 6x-480x |
| **适用场景** | 极端 token 节省需求 |
| **缺点** | 压缩后的 token 难以解释和调试；信息损失大 |

---

### D. 检索层：RAG 与知识图谱

#### D1. 标准 RAG

| 项目 | 内容 |
|------|------|
| **核心思路** | 文档分块 → 向量化 → 查询时检索相关 chunk → 注入上下文 |
| **优点** | 实现简单，生态成熟 |
| **缺点** | 检索准确率有限（可能遗漏关键信息）；无时间感知；无关系推理能力 |

#### D2. 知识图谱记忆（Zep Graphiti、Neo4j + MCP）

| 项目 | 内容 |
|------|------|
| **来源** | Zep Graphiti (开源)、Neo4j + MCP、Mem0g |
| **核心思路** | 将记忆存储为实体-关系图，支持多跳推理、时间感知、冲突检测 |
| **Graphiti 特性** | 1. 混合检索（向量搜索 + BM25 + 子图遍历）<br>2. 时间感知（自动设置 invalid_at 时间戳）<br>3. 冲突检测（新事实自动覆盖旧事实）<br>4. 领域建模（自定义实体和边类型） |
| **适用场景** | 需要跨 session 关系推理的 Agent（如记住用户 A 的工作、项目、偏好之间的关联） |
| **优点** | 多跳推理能力强；可解释；时间维度自然支持 |
| **缺点** | 构建和维护图的复杂度高；需要 NER 和关系抽取；冷启动成本高 |
| **开源** | Graphiti 开源（https://github.com/getzep/graphiti） |

#### D3. Mem0（开源记忆服务）

| 项目 | 内容 |
|------|------|
| **来源** | "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (arXiv:2504.19413, 2025) |
| **核心思路** | 分离短期记忆（会话摘要）和长期记忆（observation = 从对话中提取的事实陈述），用向量 + 图混合检索 |
| **架构** | 向量数据库做语义检索 + 知识图谱做关系推理（Mem0g 变体）|
| **适用场景** | 个性化 AI 助手、需要记住用户偏好的应用 |
| **优点** | 开箱即用；API 设计简洁；有商业和开源版本 |
| **缺点** | 记忆质量高度依赖 LLM 提取质量；向量检索的天花板仍在 |
| **开源** | 是（https://github.com/mem0ai/mem0） |
| **链接** | https://mem0.ai |

---

### E. Agent 层：状态外化与多 Agent 协作

#### E1. Chain of Agents（Google Research, 2025）

| 项目 | 内容 |
|------|------|
| **来源** | Google Research, "Chain of Agents: Large Language Models Collaborating on Long-Context Tasks" |
| **核心思路** | 将长输入分块，多个 Agent 顺序处理每个 chunk，每个 Agent 将理解传递给下一个，像流水线一样累积理解 |
| **关键优势** | 时间复杂度从 O(n^2) 降为 O(nk)，k 为 Agent 数量 |
| **适用场景** | 超长文档理解、跨文档分析 |

#### E2. 上下文隔离（多 Agent 分工）

| 项目 | 内容 |
|------|------|
| **来源** | ByteByteGo "A Guide to Context Engineering for LLMs"、Anthropic 多 Agent 研究 |
| **核心思路** | 不让一个 Agent 处理所有信息，而是拆分为专门化 Agent，每个 Agent 有独立、干净的上下文。例如：研究员 Agent 处理搜索和文档，程序员 Agent 处理代码实现 |
| **优点** | 避免注意力稀释和上下文污染；每个 Agent 的上下文小而精 |
| **缺点** | Agent 间通信需要额外设计；整体系统复杂度增加 |

#### E3. Coding Agent 作为长上下文处理器（2025 论文）

| 项目 | 内容 |
|------|------|
| **来源** | "Coding Agents are Effective Long-Context Processors" (arXiv:2603.20432, 2025) |
| **核心思路** | Coding Agent 不是被动接收长上下文，而是主动**写脚本**来处理长输入——分段搜索、正则匹配、迭代优化脚本 |
| **关键发现** | Coding Agent 通过编程能力弥补了 LLM 注意力窗口的限制，在超长文本任务上表现优于单纯的长窗口模型 |
| **对 Pi 的启示** | Pi 本身就是 coding agent，天然具备这种能力——让 agent 用工具（grep、脚本等）处理信息，而非全部塞入上下文 |

---

### F. 产品级方案

#### F1. Anthropic：Dreaming + /mnt/memory/ + Infinite Context

| 项目 | 内容 |
|------|------|
| **来源** | Anthropic Code with Claude 开发者大会 (2025) |
| **核心思路** | 1. **Infinite Context Window**：下一代 Claude 模型计划支持无限上下文<br>2. **Dreaming**：Agent 在空闲时异步回顾过去的 session 和经验，将学习写入纯文本笔记和结构化"playbooks"供未来 session 引用<br>3. **/mnt/memory/**：文件系统挂载的持久记忆，Agent 通过 bash/code-execution 工具读写<br>4. **Memory Bank**：身份范围的数据库记忆 |
| **Dreaming 特点** | 异步运行（分钟到数十分钟）；每步可观测可审计；产出物是纯文本笔记和 playbooks |
| **对 Pi 的启示** | "Dreaming" 概念非常适合 coding agent——让 agent 在空闲时回顾代码变更历史、总结学习、更新项目知识库 |

#### F2. Amazon Bedrock AgentCore Memory

| 项目 | 内容 |
|------|------|
| **来源** | AWS Machine Learning Blog (2025) |
| **核心思路** | 多阶段记忆管线：<br>1. 异步提取（从对话中提取有意义的记忆记录）<br>2. 三种内置策略：事实记忆、语义记忆、交互摘要<br>3. 不可变存储 + 合并去重 |
| **适用场景** | 企业级个性化 Agent |

#### F3. Claude Code 的上下文压缩

| 项目 | 内容 |
|------|------|
| **来源** | Anthropic Engineering Blog, "Effective Context Engineering for AI Agents" |
| **核心思路** | 将消息历史传递给模型进行摘要压缩，保留架构决策、未解决 bug、实现细节，丢弃冗余工具输出。压缩后 + 最近 5 个访问文件继续 |
| **适用场景** | coding agent 长时间会话 |

#### F4. Qwen Agent Context Management

| 项目 | 内容 |
|------|------|
| **来源** | Qwen Agent 框架 |
| **核心思路** | 优先丢弃旧记忆和环境信息，逐步减少上下文长度，实现"有效无限上下文" |
| **链接** | https://qwenlm.github.io/Qwen-Agent/en/guide/core_moduls/context |

#### F5. Augment Code Context Engine

| 项目 | 内容 |
|------|------|
| **来源** | Augment Code |
| **核心思路** | 语义索引和映射代码关系，支持 400,000+ 文件的代码库。使用语义依赖图分析，而非依赖 session 级检索。多 Agent（coordinator/implementor/verifier）共享同一 Context Engine |

---

## 3. Coding Agent 场景特别分析

### Coding Agent 的独特需求

1. **代码上下文精确性**：变量名、类型签名、API 调用不能有损压缩，与一般对话不同
2. **工具天然可用**：coding agent 可以用 grep、AST 分析、脚本等工具处理信息，不需要全部塞入上下文
3. **项目级持久化**：CLAUDE.md、架构文档、决策记录等是天然的"长期记忆"载体
4. **文件系统即状态**：InfiAgent 论文证明了文件系统可以作为 Agent 的权威状态存储

### Coding Agent 现有做法

| 工具 | 上下文策略 |
|------|-----------|
| **Claude Code** | Summarization 压缩 + 最近 5 个文件 + hooks 注入 + compact 命令 |
| **Cursor** | 代码库索引 + 检索注入 |
| **Augment Code** | 语义依赖图 + 跨 Agent 共享 Context Engine |
| **OpenDev** | 自适应上下文压缩（逐步减少旧观察）+ 自动记忆系统 + 事件驱动系统提醒 |
| **Aider** | 仓库 map + 按需读取文件 |

### 关键洞察

> "Infinite context windows won't save you... The challenge shifts from 'what to include' to 'how to keep it consistent, current, and trustworthy.' From curation to governance. That might be harder, not easier."
> — Tessl, "The Context Development Lifecycle"

> "Agent memory isn't a storage problem, it's a context engineering problem. What your agent 'remembers' is fundamentally what exists in its context window at any given moment."
> — Sarah Wooders, Letta co-founder

> "Coding agents are effective long-context processors" — coding agent 可以通过编程能力弥补注意力窗口的限制
> — arXiv:2603.20432

---

## 4. 方案对比矩阵

| 方案 | 原理 | 无限性 | 信息损失 | 实现复杂度 | 对 Coding Agent 适用性 | 开源 |
|------|------|--------|---------|-----------|----------------------|------|
| **Infini-Attention** | 模型架构级压缩记忆 | 真正无限 | 有损（压缩） | 极高（需改模型） | 低（不可控） | 论文公开 |
| **大窗口模型** | 暴力扩展 | 有上限 | 无（但利用率低） | 低（API 调用） | 中 | N/A |
| **MemGPT/Letta** | OS 式分层内存 | 实际无限 | Agent 自控 | 中-高 | 高 | 是 |
| **InfiAgent** | 文件系统状态外化 | 实际无限 | 低 | 中 | 很高 | 论文公开 |
| **LLMLingua** | Token 级压缩 | N/A（辅助工具） | 有损 | 低 | 中（代码压缩风险） | 是 |
| **Summarization** | LLM 摘要 | 实际无限 | 有损（逐步） | 低 | 高 | 通用技术 |
| **RAG + 向量库** | 检索注入 | 取决于外部存储 | 无（但可能遗漏） | 中 | 中 | 是 |
| **知识图谱** | 实体关系图 | 取决于图规模 | 低 | 高 | 中-高 | 是（Graphiti 等） |
| **多 Agent 隔离** | 上下文分割 | 取决于设计 | 低 | 中-高 | 高 | 通用架构 |
| **Dreaming** | 异步回顾+笔记 | 实际无限 | 低 | 中 | 很高 | Anthropic 专有 |
| **Chain of Agents** | 流水线顺序传递 | 实际无限 | 有损（传递损失） | 中 | 中 | 论文公开 |

---

## 5. 对 Pi 的启示与建议方向

### 5.1 Pi 已有的基础

Pi 已经具备以下无限上下文相关的机制：
- **文件系统状态外化**：goal/todo/subagent 的状态通过 `sessionManager` 持久化
- **多 Agent 协作**：subagent 支持 single/parallel/chain/background 模式
- **CLAUDE.md / Skills**：类似 Augment Code 的 Context Engine，按需加载专门化知识
- **工具使用**：agent 可以用 grep、read、bash 等工具处理信息

### 5.2 建议的组合方案

基于调研结果，建议 Pi 采用 **多层组合策略**，而非依赖单一方案：

```
┌──────────────────────────────────────────────────┐
│ Layer 5: Dreaming / 异步知识整理                    │  ← 新增
│  （空闲时回顾 session 历史，更新项目知识库）           │
├──────────────────────────────────────────────────┤
│ Layer 4: 多 Agent 上下文隔离                        │  ← 已有（subagent）
│  （专门化 agent 各自精简上下文）                      │
├──────────────────────────────────────────────────┤
│ Layer 3: 智能上下文压缩                             │  ← 增强
│  （Summarization + 观察遮蔽 + 重要信息保留）          │
├──────────────────────────────────────────────────┤
│ Layer 2: 分层记忆（MemGPT 式）                      │  ← 新增
│  （核心记忆 / 回忆记忆 / 归档记忆 三层）              │
├──────────────────────────────────────────────────┤
│ Layer 1: 文件系统状态外化                            │  ← 已有
│  （sessionManager + entries 持久化）                │
└──────────────────────────────────────────────────┘
```

### 5.3 优先级排序

| 优先级 | 方向 | 依据 |
|--------|------|------|
| P0 | **智能上下文压缩（Summarization + Observation Masking）** | Claude Code 已验证有效，JetBrains 研究有实验数据支撑，实现成本最低 |
| P0 | **文件系统状态外化强化** | InfiAgent 论文证明文件作为权威状态存储可行；Pi 已有基础 |
| P1 | **分层记忆管理（MemGPT 式核心记忆 + 回忆记忆）** | Agent 自主管理上下文，理论优雅；Letta 已有成熟实现可参考 |
| P1 | **Coding Agent 式程序化处理**（让 agent 用脚本/工具处理信息而非塞入上下文） | 论文证明 coding agent 天然适合这种模式；Pi 本身具备工具能力 |
| P2 | **Dreaming / 异步知识整理** | Anthropic 已展示效果（Harvey 报告 6x 任务完成提升），但实现复杂度较高 |
| P2 | **知识图谱记忆** | 多跳推理能力强，但对 coding agent 场景可能 over-engineering |

### 5.4 不建议的方向

| 方向 | 原因 |
|------|------|
| 纯 LLMLingua 式 token 级压缩 | 对代码文本有破坏风险；coding agent 对变量名、API 签名等敏感 |
| 单纯依赖更大窗口 | 成本高；利用率低；不解决根本问题 |
| 纯 RAG 方案 | 检索准确率天花板低；缺乏关系推理 |

---

## 附录：关键论文/项目索引

| # | 名称 | 类型 | 年份 | 链接 |
|---|------|------|------|------|
| 1 | MemGPT: Towards LLMs as Operating Systems | 论文 | 2023 | https://arxiv.org/abs/2310.08560 |
| 2 | InfiAgent: Infinite-Horizon Framework for Agents | 论文 | 2025 | https://arxiv.org/abs/2601.03204 |
| 3 | Infini-Attention (Google) | 论文 | 2024 | https://arxiv.org/abs/2404.07143 |
| 4 | LLMLingua (Microsoft) | 开源项目 | 2023-2024 | https://github.com/microsoft/LLMLingua |
| 5 | Mem0: Production-Ready AI Agents with Long-Term Memory | 论文+开源 | 2025 | https://arxiv.org/abs/2504.19413 |
| 6 | Chain of Agents (Google) | 论文 | 2025 | https://research.google/blog/chain-of-agents |
| 7 | Coding Agents are Effective Long-Context Processors | 论文 | 2025 | https://arxiv.org/abs/2603.20432 |
| 8 | OpenDev: Terminal AI Agent | 论文 | 2025 | https://arxiv.org/abs/2603.05344 |
| 9 | A Survey of Techniques to Extend Context Length | 综述 | 2024 | https://arxiv.org/abs/2402.02244 |
| 10 | JetBrains Efficient Context Management | 研究博客 | 2025 | https://blog.jetbrains.com/research/2025/12/efficient-context-management |
| 11 | Letta (MemGPT 商业化) | 开源+商业 | 2024-2025 | https://github.com/letta-ai/letta |
| 12 | Zep Graphiti | 开源 | 2025 | https://github.com/getzep/graphiti |
| 13 | Anthropic Context Engineering | 技术博客 | 2025 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| 14 | Martin Fowler: Context Engineering for Coding Agents | 技术文章 | 2025 | https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html |
| 15 | Graphs Meet AI Agents: Taxonomy | 综述 | 2025 | https://arxiv.org/abs/2506.18019 |
