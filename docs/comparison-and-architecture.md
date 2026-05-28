# 无限上下文方案 — 综合对比、吸收与架构整合

> 本文档基于对 6 个 AI agent 项目的源码分析 + 生命记忆体理论，
> 输出三部分：对比框架表格 → 可吸收点清单 → 粗略架构设计。

---

## 一、对比框架

### 1.1 Claude Code

| 维度 | 内容 |
|------|------|
| **整体思路** | 三层递进式压缩：微压缩(每次API调用前)→自动压缩(阈值触发)→全量压缩(PTL错误触发)。压缩不是删除而是标记边界，在消息流中插入 `CompactBoundaryMessage`。 |
| **亮点** | ①Microcompact 零成本清理：空闲>60min自动清除旧工具结果，不改变消息结构 ②Session Memory 实验性压缩：后台持续提取知识，压缩时零额外API调用 ③断路器：连续3次自动压缩失败后放弃，防止无限重试 ④Partial Compact：用户可指定保留哪一段历史 ⑤压缩后附件恢复：自动恢复最近5个文件(50K token预算) |
| **缺陷** | ①特性开关爆炸(REACTIVE_COMPACT/CONTEXT_COLLAPSE/CACHED_MICROCOMPACT 等大量互斥开关) ②循环依赖(compact.ts ↔ compactMessages.ts 被迫拆出 grouping.ts) ③多处手动 type assertion ④压缩本身成本高(全量压缩约20K output + 全部context input tokens) ⑤没有锚节点概念——压缩全凭LLM判断，无结构化保证 |
| **改进思路** | ①引入锚节点层，压缩时锚节点永远保留不被摘要 ②用规则压缩(L1)替代部分Microcompact场景，减少对API cache_edits的依赖 ③压缩后注入结构化摘要(而非纯文本)，确保关键信息不丢失 |

### 1.2 Aider

| 维度 | 内容 |
|------|------|
| **整体思路** | 8段式消息组装 + RepoMap(Pagerank on code symbols)。消息分为 system/examples/done/repo/readonly_files/chat_files/cur/reminder 八段，每段独立启用/缓存。RepoMap 用 tree-sitter 解析代码符号 + PageRank 排序，只注入与当前任务最相关的代码结构摘要。 |
| **亮点** | ①RepoMap 核心洞察：**不把文件内容放进上下文，只放符号结构**——这是 coding agent 上下文优化的最大杠杆 ②二分裁剪：用二分搜索替代贪心法精确控制 token 预算 ③个性化权重：用户在输入中提到的符号权重×10，聊天文件内的符号×50 ④后台摘要线程不阻塞交互 ⑤三层缓存(Tag缓存diskcache→Tree Context内存→Map缓存)+API prompt caching ⑥Token预算自适应：无文件时repo-map预算放大8倍 |
| **缺陷** | ①首次扫描大仓库慢(已用TQDM+后台线程优化，但仍有延迟) ②依赖tree-sitter language pack，部分语言仅返回 def 无 ref ③摘要 lossy，精确事实可能在摘要中丢失 ④无增量摘要，每次重算所有 done_messages ⑤摘要仅依赖 weak_model，质量有限 ⑥NFS 等文件系统上 mtime 检测有问题 |
| **改进思路** | ①RepoMap的思想可推广到 Pi：将 read 工具的返回结果不直接放入上下文，而是由扩展解析生成结构摘要+文件引用 ②用 LLM 补充 tree-sitter 的不足(动态语言/复杂模板) ③摘要持久化缓存避免重复计算 |

### 1.3 Codex CLI

| 维度 | 内容 |
|------|------|
| **整体思路** | 核心是 ContextManager(Vec<ResponseItem>) + Compaction作为消息类型一等公民 + AutoCompactWindow增量预算跟踪。工具输出在写入时即截断(保留头尾)，compaction用LLM生成摘要并替换历史。长期记忆通过独立的memories/read|write工具实现。 |
| **亮点** | ①Compaction 作为 ResponseItem 变体：压缩后的摘要是消息历史的一等公民，不是外部流程 ②AutoCompactWindow + BodyAfterPrefix：配合 prefix cache，只对缓存之外的增量部分做预算管理 ③工具输出写入即截断(保留头尾，用"…N tokens truncated…"标记) ④双层Token估算：API精确值+客户端bytes/4估算，LRU缓存优化 ⑤用户消息保留20K tokens上限，从最新往回取 ⑥JSONL持久化+文件锁+原子写入 ⑦PreCompact/PostCompact hooks ⑧长期记忆两阶段LLM提取(Phase1提取→Phase2合并去重) |
| **缺陷** | ①没有锚节点或结构化保证——摘要质量完全依赖LLM prompt ②用户消息保留策略粗暴(从头截断)，不区分重要性 ③compact触发在90%阈值，留给压缩操作的空间较小 ④长期记忆(memories)与主上下文管理(ContextManager)是两套独立系统，缺乏统一的生命周期管理 ⑤没有遗忘机制——所有记忆永久保留，raw_memories.md无限增长 |
| **改进思路** | ①加入锚节点层，compaction时锚节点单独保留不被摘要 ②用户消息按重要性评分保留而非简单FIFO ③memories加入价值驱动的淘汰机制 ④提前触发(70%而非90%)给压缩更多余地 |

### 1.4 LangChain Memory

| 维度 | 内容 |
|------|------|
| **整体思路** | 策略层(Memory)与存储层(ChatMessageHistory)分离。提供6种开箱即用的策略：Buffer/Window/TokenBuffer/Summary/SummaryBuffer/VectorStore。通过 memory_variables + load_memory_variables 向 chain 注入额外上下文变量。 |
| **亮点** | ①策略与存储分离是最强抽象——原始消息可以全量持久化，策略只控制哪些进入LLM ②ConversationSummaryBufferMemory 是当前最接近"无限上下文"的工程实现：摘要+最近K轮原文混合 ③增量摘要(SummarizerMixin)：new_summary = LLM(existing_summary + new_lines)，不是每次都重算全量 ④ConversationTokenBufferMemory 真正按 token 计数做修剪 ⑤ConversationVectorStoreTokenBufferMemory 结合语义检索召回历史 ⑥ConversationEntityMemory 维护实体-摘要映射表，结构化知识提取 |
| **缺陷** | ①模块已于 v0.3.x deprecated，官方推荐迁移到 LangGraph ②摘要本身会持续增长——没有对摘要再摘要的多级机制 ③VectorStore 语义检索无法保证100%召回 ④TokenBuffer 的 FIFO 丢弃策略粗暴，不区分消息重要性 ⑤所有策略都是外部触发(调用 save_context)，不支持 Agent 主动决策 |
| **改进思路** | ①在 ConversationSummaryBufferMemory 之上加入多级摘要(对摘要再摘要) ②引入锚节点，区分"永远保留"和"可丢弃"的事实 ③将策略从外部触发改为 Agent 可调用的 Tool(Letta/Codex CLI 模式) ④向量检索作为 fallback 而非主路径(Letta 实验数据：文件搜索74%优于向量68.5%) |

### 1.5 OpenCode

| 维度 | 内容 |
|------|------|
| **整体思路** | SQLite 全量持久化 + Summarization 作为唯一压缩手段 + TUI AutoCompact 自动触发。消息无限制累加到 msgHistory，唯一缩减方式是生成 summary 后设 Session.SummaryMessageID，下次加载时 summary 替代所有更早的消息。 |
| **亮点** | ①极简设计——无复杂的token预算分配/消息评分，全套上下文管理只靠3个核心机制 ②SQLite持久化+触发器自动维护消息计数，可靠且零维护 ③summary_message_id 指针设计：单字段即可追踪最新摘要位置 ④AutoCompact基于token用量百分比(95%)触发，用户透明 ⑤Anthropic prompt caching 正确标记了system/last 3 messages/tools |
| **缺陷** | ①**最简陋的上下文管理**——无token预算分配、无智能丢弃策略、无工具输出压缩 ②AutoCompact触发太晚(95%)，此时下一次请求可能已超窗口 ③Summarization期间阻塞(isCompacting锁) ④所有消息一视同仁，无重要性评分 ⑤无滑动窗口或分段压缩 ⑥tool result原样无限累加 ⑦没有跨session的上下文合并或引用 |
| **改进思路** | ①在Summarization基础上加入滑动窗口+分段压缩 ②降低AutoCompact阈值到70-80% ③加入工具输出自动截断(借鉴Codex CLI/Qwen Code) ④压缩异步化避免阻塞 ⑤利用session树(parent_session_id)实现跨session上下文共享 |

### 1.6 Qwen Code

| 维度 | 内容 |
|------|------|
| **整体思路** | 四层上下文防护：turn限制→自动压缩(LLM生成state_snapshot)→session token限制→工具输出截断→循环检测。压缩采用结构化XML输出(overall_goal/key_knowledge/file_system_state/recent_actions/current_plan)。所有消息以树结构(JSONL+uuid/parentUuid)持久化，支持checkpoint恢复。 |
| **亮点** | ①**结构化压缩输出是最大亮点**：LLM生成 state_snapshot XML而非自由文本，确保关键信息不被遗漏 ②三阈值精确控制(70%触发, 30%保留, 5%最小压缩量) ③Checkpoint式恢复：压缩checkpoint+后续增量→无需重新压缩即可恢复会话 ④输出token capped default(8K)+自动升级(64K)：99%场景节省slot ⑤Idle思考链清理：5分钟无交互自动strip reasoning tokens ⑥/appcontext命令的六大分类诊断UI ⑦循环检测(Tool Call+文本内容双重) ⑧save_memory tool实现global/project两级长期记忆 |
| **缺陷** | ①无滑动窗口——只有压缩或截断两种模式 ②压缩是简单的比例分割(70%/30%)，不按语义边界 ③无增量压缩，每次重算整个旧历史 ④无选择性保留——按位置而非重要性决定保留哪些消息 ⑤字符估算与真实token数有偏差 ⑥首次压缩失败后后续自动压缩全部跳过(hasFailedCompressionAttempt) |
| **改进思路** | ①用语义分段替代比例分割(借鉴本方案的任务段/探索段分类) ②加入增量摘要避免每次重算 ③失败后降级策略(而非完全放弃)：如先尝试滑动窗口再尝试压缩 ④压缩触发阈值降到60-70%(Qwen Code的70%对于大窗口仍偏晚) |

### 1.7 生命记忆体理论(本方案)

| 维度 | 内容 |
|------|------|
| **整体思路** | 上下文管理的未来不是找更好的压缩算法，而是构建"有生命的记忆体"。以**四层架构(热/锚/温/冷)+六阶段生命循环(写入→巩固→检索→遗忘→集成→进化)**为核心，锚节点层作为"不可妥协的脊椎"永远在场。 |
| **亮点** | ①**锚节点层是理论创新**：当前所有方案都缺失这一层——存储不可压缩的核心结论且永远在场 ②锚节点资格规则引擎：精确定义"什么有资格成为锚"(user_explicit_goal/critical_constraint/verified_fact_3+/irreversible_decision等) ③锚节点版本化追踪：每次变更都是认知升级的可追溯记录 ④主动探针(Probe)：检索从外部管道变为模型推理中的工具动作 ⑤三重遗忘机制(衰减+冲突+价值淘汰)缺一不可——遗忘和记忆同等重要 ⑥写入管道不信任原始对话(事实抽取+冗余消除+冲突检测) ⑦参数内化作为远期愿景(LoRA微调内化元知识) |
| **缺陷** | ①工程复杂度高——六阶段循环+四层架构的完整实现需要大量代码 ②锚节点规则引擎的设计和调优是开放问题(哪些规则？优先级如何？是否需要人工确认？) ③主动探针依赖模型自主调用工具的能力，弱模型可能不会主动使用 ④遗忘机制的价值评分函数需要大量实验标定 ⑤异步写入管道增加系统延迟，复杂度显著 ⑥尚未经过工程验证——当前仅为理论框架 |
| **改进思路** | ①分阶段实现——Phase 1先做骨架(冷热分层+L1压缩+recall)，Phase 2加锚节点+温数据，Phase 3完整循环 ②锚节点规则从保守起步(仅 user_explicit_goal + critical_constraint)，逐步扩展 ③probe工具设计为"可用但非强制"(steering prompt引导但模型可忽略) ④遗忘评分函数内置默认参数，允许用户调整 ⑤写入管道先做"同步简化版"(事实抽取用规则而非LLM)，逐步升级 |

---

## 二、可吸收点清单

从 6 个项目 + 理论框架中提取的 25 个可吸收到 Pi 无限上下文方案的具体设计点：

### A. 压缩策略 (6 项)

| # | 吸收点 | 来源 | 优先级 | 说明 |
|---|--------|------|:---:|------|
| A1 | **三层递进压缩** | Claude Code | P0 | Microcompact(零成本)→AutoCompact(阈值触发)→Reactive(API错误触发)。从最轻量开始，只在必要时升级 |
| A2 | **L1 规则压缩(工具输出替换)** | Claude Code(Microcompact)+Codex CLI(写入截断) | P0 | 文件内容→文件引用、bash输出→最后N行+错误摘要。零延迟、零API成本，但释放30-50%空间 |
| A3 | **结构化压缩输出** | Qwen Code(state_snapshot XML) | P1 | 压缩不是自由文本而是结构化XML/JSON，确保关键信息维度不丢失 |
| A4 | **60%阈值提前触发** | Codex CLI(90%)的反面教训，本理论建议 | P1 | 不要等到90-95%才触发。60-70%是最佳区间，留足余量给压缩操作和执行后续任务 |
| A5 | **断路器+降级链** | Claude Code(3次失败放弃)+Qwen Code的改进方向 | P1 | 压缩失败后不要完全放弃(Qwen Code的缺陷)，而是降级到更轻量的策略(滑动窗口→摘要→截断) |
| A6 | **后台异步压缩** | Aider(后台线程)+Claude Code(Session Memory) | P1 | 压缩和摘要生成用独立subagent进程异步执行，不阻塞主交互 |

### B. 消息模型 (5 项)

| # | 吸收点 | 来源 | 优先级 | 说明 |
|---|--------|------|:---:|------|
| B1 | **压缩边界标记** | Claude Code(SystemCompactBoundaryMessage) | P0 | 在消息流中插入标记而非删除消息。后续通过 getMessagesAfterCompactBoundary() 取有效片段 |
| B2 | **Compaction 作为消息类型一等公民** | Codex CLI(ResponseItem::Compaction) | P0 | 压缩后的摘要是消息历史中的一种消息类型，而非外部流程。与其他消息统一管理 |
| B3 | **8段式消息架构** | Aider(ChatChunks) | P1 | 消息按来源分段(system/done/repo/files/cur/reminder)，每段独立控制启用/禁用/缓存 |
| B4 | **策略与存储分离** | LangChain(BaseMemory vs ChatMessageHistory) | P0 | 原始消息可全量持久化到文件/SQLite，策略只控制哪些进入LLM |
| B5 | **Checkpoint 恢复** | Qwen Code(compression checkpoint+后续增量) | P1 | 压缩后用checkpoint+增量消息重建上下文，无需重新压缩 |

### C. 上下文组装 (5 项)

| # | 吸收点 | 来源 | 优先级 | 说明 |
|---|--------|------|:---:|------|
| C1 | **文件内容零保留** | Aider(RepoMap：只放符号结构不放文件内容) | P0 | read 工具结果不直接进入上下文。扩展解析后生成结构摘要+文件引用。仅此一项释放30-50%空间 |
| C2 | **锚节点层(永远在场)** | 生命记忆体理论 | P0 | 每次LLM调用前自动注入锚节点，大小仅500-2000 tokens，包含不可压缩的核心结论 |
| C3 | **主动探针(Probe)** | 生命记忆体理论+Letta(MemGPT) | P1 | 模型可主动调用 memory_probe 工具检索被压缩的内容，将检索变为自身的推理动作 |
| C4 | **语义分段替代固定窗口** | 生命记忆体理论 | P1 | 按 task_segment/exploration_segment/debugging_segment 划分而非固定轮数，每段有独立生命周期 |
| C5 | **Token预算诊断UI** | Qwen Code(/context命令)+Aider(/tokens命令) | P2 | 可视化上下文使用情况：系统提示/工具声明/记忆/对话历史各占多少 |

### D. 生命周期 (5 项)

| # | 吸收点 | 来源 | 优先级 | 说明 |
|---|--------|------|:---:|------|
| D1 | **三重遗忘机制** | 生命记忆体理论 | P1 | 衰减(时间因子)+冲突(新事实覆盖旧事实)+价值淘汰(引用频率×新奇度×锚点关联度) |
| D2 | **锚节点资格规则引擎** | 生命记忆体理论 | P1 | 精确定义"什么有资格成为锚"：user_explicit_goal/critical_constraint/verified_fact_3+/irreversible_decision |
| D3 | **锚节点版本化追踪** | 生命记忆体理论 | P2 | 锚节点变更 = 认知升级，每条变更有完整日志，支持回溯 |
| D4 | **写入管道(不信任原始对话)** | 生命记忆体理论 | P2 | 事实抽取→语义聚类→冗余消除→冲突检测→入库。异步执行不阻塞交互 |
| D5 | **长期记忆独立工具** | Codex CLI(memories/read|write)+Qwen Code(MemoryTool) | P1 | Agent可主动调用记忆工具读写长期记忆，跨session持久化 |

### E. 工程实践 (4 项)

| # | 吸收点 | 来源 | 优先级 | 说明 |
|---|--------|------|:---:|------|
| E1 | **写入时截断工具输出** | Codex CLI(process_item截断) | P0 | 工具输出在进入历史前即截断(保留头尾)，而非等上下文满了再处理 |
| E2 | **两阶段Token估算** | Codex CLI(API精确+client byte/4) | P1 | 服务端精确值+客户端近似值，平衡准确性和实时性 |
| E3 | **压缩后上下文重建** | Claude Code(恢复文件缓存+工具注册) | P1 | 压缩后必须重建模型的工作上下文：文件缓存、工具注册、指令、hooks |
| E4 | **SQLite持久化消息** | OpenCode | P1 | 替代方案：JSONL+index或SQLite。SQLite查询灵活但需cgo/原生模块 |

---

## 三、粗略架构设计

### 3.1 核心定位

**不是一个"更好的压缩工具"，而是一个 "Pi 上下文记忆引擎"。**

它内嵌在 Pi 扩展系统中，作为 Pi 发给 LLM 的 prompt 的最后一道组装工序，负责：
- 决定什么进入上下文(注入)
- 决定什么离开上下文(压缩/遗忘)
- 决定什么永远在场(锚节点)
- 让模型能主动检索被移出的内容(探针)

### 3.2 模块划分

```
infinite-context 扩展
│
├── src/
│   ├── index.ts                    # 注册 tool + command + 事件监听
│   ├── state.ts                    # 数据模型 + 压缩状态机
│   │
│   ├── layers/
│   │   ├── hot-layer.ts            # 热层: 最近K轮原文管理
│   │   ├── anchor-layer.ts         # 锚节点层: DSL定义、读写、注入
│   │   ├── warm-layer.ts           # 温层: 片段存储、摘要管理
│   │   └── cold-layer.ts           # 冷层: 段归档、索引、recall
│   │
│   ├── compression/
│   │   ├── l1-rule-compressor.ts   # L1规则压缩: 工具输出→引用
│   │   ├── l2-summarizer.ts        # L2结构化摘要: subagent调用
│   │   ├── l3-segment-merger.ts    # L3段合并摘要
│   │   └── compression-trigger.ts  # 压缩触发判断(多阈值)
│   │
│   ├── lifecycle/
│   │   ├── write-pipeline.ts       # 异步写入管道
│   │   ├── forget-engine.ts        # 遗忘机制(衰减+冲突+淘汰)
│   │   └── anchor-rules.ts         # 锚节点资格规则引擎
│   │
│   ├── tools/
│   │   ├── memory-probe.ts         # recall/probe 工具
│   │   ├── memory-save.ts          # 手动保存记忆
│   │   ├── memory-forget.ts        # 手动遗忘
│   │   └── memory-status.ts        # 上下文诊断
│   │
│   ├── storage/
│   │   ├── segment-store.ts        # 段文件读写
│   │   ├── summary-store.ts        # 摘要文件读写
│   │   └── anchor-store.ts         # 锚节点文件读写+版本管理
│   │
│   └── templates/
│       ├── anchor-dsl.ts           # 锚节点 JSON schema
│       ├── summary-prompt.ts       # 摘要生成 prompt
│       └── compaction-prompt.ts    # 压缩 prompt
│
└── package.json
```

### 3.3 核心数据流

```
每次 LLM 调用前:

    Pi 核心组装 prompt 之前
         │
         ├──→ 1. 注入锚节点层(永远在场, 500-2000 tokens)
         │        source: ~/.pi/memory/anchors/current.json
         │
         ├──→ 2. 注入高权重温数据片段(top-3)
         │        source: ~/.pi/memory/warm/*.json (按重要性排序)
         │
         ├──→ 3. 保留最近K轮原文(默认K=8)
         │        source: session 当前消息列表
         │
         ├──→ 4. 检查上下文用量
         │        if used > contextWindow * 0.6:
         │          → 触发 L2 压缩(后台 subagent, 不阻塞本次调用)
         │        if used > contextWindow * 0.8:
         │          → 触发 L1 规则压缩(同步，零延迟)
         │          → 降级: K 减少到 4
         │
         └──→ 5. 输出最终 prompt messages
```

### 3.4 数据结构草案

```typescript
// 锚节点
interface AnchorStore {
  version: number;
  entries: AnchorEntry[];
}

interface AnchorEntry {
  id: string;
  type: 'user_explicit_goal' | 'critical_constraint'
      | 'verified_fact' | 'irreversible_decision'
      | 'project_environment' | 'user_preference'
      | 'open_blocker';
  content: string;
  confidence: 'verified' | 'inferred' | 'pending_review';
  source_session: string;
  confirmed_count: number;
  last_confirmed_at: number;
  status: 'active' | 'decaying' | 'retired';
}

// 温数据片段
interface WarmFragment {
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  summary: string;
  key_findings: string[];
  files_touched: string[];
  related_entities: string[];
  importance: number;        // 0-1
  access_count: number;
  last_accessed: number;
  created_at: number;
}

// 段(冷数据)
interface Segment {
  segment_id: string;
  type: 'task' | 'exploration' | 'debugging' | 'conversation';
  objective: string;
  turn_range: [number, number];
  l1_compressed_turns: CompressedTurn[];
  warm_extracted: string[];  // → warm fragment IDs
}

interface CompressedTurn {
  turn: number;
  tool: string;
  compressed: string;        // L1规则压缩结果: "读取了 auth.ts 1-150行"
}
```

### 3.5 实现路线图

```
Phase 1 — 骨架 (纯扩展, 不改 Pi)
  ├── P1.1 段索引观察器
  ├── P1.2 L1 规则压缩(工具输出→引用)
  ├── P1.3 冷数据持久化(.pi/infinite-context/segments/)
  ├── P1.4 recall tool(关键词搜索冷数据)
  └── P1.5 /context-status 命令

Phase 2 — 锚节点 + 温数据 (纯扩展)
  ├── P2.1 锚节点DSL + 存储
  ├── P2.2 锚节点资格规则引擎
  ├── P2.3 被动注入(依赖 Pi onBeforeContextAssembled hook)
  ├── P2.4 memory_probe tool
  └── P2.5 温数据片段存储

Phase 3 — 完整循环 (需 Pi 核心配合)
  ├── P3.1 异步写入管道(事实抽取+去重+冲突检测)
  ├── P3.2 三重遗忘引擎
  ├── P3.3 锚节点版本化追踪
  ├── P3.4 自动压缩触发(替代 Pi 原生 compact)
  └── P3.5 跨 session 记忆迁移
```

### 3.6 核心依赖 Pi 改动

**Phase 1-2(纯扩展)需要的 Pi API:**

```typescript
// P0: 上下文组装钩子
pi.on('before:context:assemble', (messages, context) => {
  // 扩展可修改 messages 数组
  // 注入锚节点、温数据片段
  return modifiedMessages;
});

// P0: Token 预算查询
pi.getTokenBudget(): {
  contextWindow: number;
  used: number;
  available: number;
}

// P1: 段边界事件
pi.on('turn:boundary', (segmentType, metadata) => {
  // 当检测到用户新指令、任务切换等时触发
});
```

**不需要改 Pi 的部分:**
- 文件系统读写(已有)
- subagent 异步执行(已有)
- session 事件钩子 `pi.on()`(已有)
- 闭包状态隔离(已在 goal/todo 扩展验证)

---

## 四、与其他方案的差异化定位

| 维度 | 本方案 | Claude Code | Aider | Codex CLI | Qwen Code |
|------|:---:|:---:|:---:|:---:|:---:|
| **锚节点** | 核心 | 无 | 无 | 部分(memories) | 部分(state_snapshot) |
| **压缩触发** | 60% | 167K/~83% | 1024 tok abs | 90% | 70% |
| **压缩方式** | 三级(L1规则+L2 LLM+L3合并) | 单层LLM摘要 | 单层weak-model | 单层LLM摘要 | 单层LLM state_snapshot |
| **工具输出** | 写入时替换+截断 | 写入后清理 | 不截断 | 写入时head/tail截断 | 写入时head/tail截断 |
| **遗忘机制** | 三重(衰减+冲突+淘汰) | 无 | 窗口丢弃 | 无 | 无 |
| **检索模式** | 被动注入+主动探针 | 仅被动 | 仅被动 | 被动+主动(memories) | 被动 |
| **coding针对性** | 专门设计 | 通用 | RepoMap专门 | 通用 | 通用 |
| **跨session记忆** | 温数据+锚节点 | Session Memory(实验) | 无 | raw_memories.md | QWEN.md |
