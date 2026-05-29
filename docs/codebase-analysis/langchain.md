# LangChain 记忆/上下文管理模块分析

> 分析日期: 2026-05-28
> 代码库: langchain-ai/langchain (monorepo)
> 源文件位置: `libs/langchain/langchain_classic/memory/`

---

## 1. 整体架构概览

LangChain 的 memory 模块是一个**已废弃但完整**的上下文管理系统，在 v0.3.x 标记为 deprecated，将在 v1.0.0 移除。它采用**分层继承 + 组合**的设计：

```
BaseMemory (langchain_core/Serializable, ABC)
  ├── BaseChatMemory (ABC，引入 chat_memory 字段)
  │     ├── ConversationBufferMemory         # 完整对话历史
  │     ├── ConversationStringBufferMemory   # 纯字符串版 buffer
  │     ├── ConversationBufferWindowMemory   # 滑动窗口（保持最后 k 轮）
  │     ├── ConversationSummaryMemory        # 持续摘要（每轮更新）
  │     ├── ConversationSummaryBufferMemory  # 摘要 + buffer 混合
  │     ├── ConversationTokenBufferMemory    # 基于 token 数修剪
  │     ├── ConversationEntityMemory         # 命名实体提取 + 摘要
  │     └── ConversationVectorStoreTokenBufferMemory  # token buffer + vectorstore
  ├── CombinedMemory         # 组合多个 memory 实例
  ├── SimpleMemory           # 静态键值对（不可变）
  ├── ReadOnlySharedMemory   # 只读包装器
  └── VectorStoreRetrieverMemory  # 基于向量检索（非 chat）
```

### 类继承图（ASCII）

```
Serializable + ABC
  |
BaseMemory                              "memory_variables", "load_memory_variables",
  |                                      "save_context", "clear" (+ async variants)
  |--- BaseChatMemory (ABC)             添加 chat_memory (BaseChatMessageHistory)
  |      |                               字段: output_key, input_key, return_messages
  |      |
  |      |--- ConversationBufferMemory       完整 buffer (string 或 messages)
  |      |--- ConversationBufferWindowMemory 滑动窗口 (k 轮)
  |      |--- ConversationSummaryMemory      持续 LLM 摘要
  |      |--- ConversationSummaryBufferMemory token 限 + 摘要混合
  |      |--- ConversationTokenBufferMemory   token 限修剪
  |      |--- ConversationEntityMemory       命名实体提取+摘要
  |      |--- ConversationVectorStoreTokenBufferMemory token+vectorstore
  |      |
  |      +--- SummarizerMixin (mixin, 非 subclass)  提供 predict_new_summary
  |            被 ConversationSummaryMemory 和
  |               ConversationSummaryBufferMemory 使用
  |
  |--- SimpleMemory               静态不可变键值对
  |--- CombinedMemory             组合多个 memory
  |--- ReadOnlySharedMemory       只读包装
  |--- VectorStoreRetrieverMemory 基于向量检索
```

---

## 2. 核心基类设计

### 2.1 `BaseMemory`（`libs/langchain/langchain_classic/base_memory.py`）

最顶层抽象，定义 4 个核心方法 + 对应的 async 变体：

| 方法 | 功能 |
|------|------|
| `memory_variables` (property) | 返回此 memory 会使用的所有变量名 |
| `load_memory_variables(inputs)` | 从 memory 加载变量 |
| `save_context(inputs, outputs)` | 保存一轮对话上下文 |
| `clear()` | 清空 memory |

**核心设计特点**：
- 每个 memory 实例使用**键值对机制**：通过 `memory_variables` 声明自己注入什么 key，通过 `load_memory_variables` 返回这些 key 的值
- async 变体（`a` 前缀）使用 `run_in_executor` 包装 sync 方法，不强制异步实现
- 继承自 `langchain_core.load.serializable.Serializable`，支持序列化

### 2.2 `BaseChatMemory`（`libs/langchain/langchain_classic/memory/chat_memory.py`）

专为聊天场景设计的中间层，核心添加：

```python
class BaseChatMemory(BaseMemory, ABC):
    chat_memory: BaseChatMessageHistory  # 消息存储后端
    output_key: str | None = None
    input_key: str | None = None
    return_messages: bool = False
```

**关键实现**：
- `save_context`: **将人类输入和 AI 输出作为 HumanMessage/AIMessage 存入 `chat_memory`**
- `_get_input_output`: 自动解析 inputs/outputs 字典中的正确 key（支持显式设置或自动推导）
- `clear`: 委托给 `chat_memory.clear()`

### 2.3 `BaseChatMessageHistory`（`libs/core/langchain_core/chat_history.py`）

消息存储的抽象接口：

```python
class BaseChatMessageHistory(ABC):
    messages: list[BaseMessage]    # 消息列表（需子类实现）
    add_message(message)           # 添加单条消息
    add_messages(messages)         # 批量添加（推荐）
    clear()                        # 清空
    + async variants
```

内置实现 `InMemoryChatMessageHistory`（`messages: list[BaseMessage]` 直接存内存列表）。

### 2.4 `BaseMessage`（`libs/core/langchain_core/messages/base.py`）

消息模型：

```python
class BaseMessage(Serializable):
    content: str | list[str | dict]  # 消息内容
    additional_kwargs: dict          # 额外信息（tool calls 等）
    response_metadata: dict          # 响应元数据
    type: str                        # 消息类型标识符
    name: str | None                 # 可选的名称
    id: str | None                   # 可选唯一 ID
```

子类: `HumanMessage`, `AIMessage`, `SystemMessage`, `ChatMessage`, `ToolMessage`, `FunctionMessage`

---

## 3. 五种主要 Memory 策略详解

### 3.1 `ConversationBufferMemory` — 完整缓存

**文件**: `buffer.py`

```python
class ConversationBufferMemory(BaseChatMemory):
    human_prefix: str = "Human"
    ai_prefix: str = "AI"
    memory_key: str = "history"
```

**策略**: 存储**全部**对话历史。通过 `buffer` property 暴露，支持两种格式：
- `return_messages=False`（默认）: 字符串格式（`Human: ...\nAI: ...`）
- `return_messages=True`: 返回 `list[BaseMessage]`

**本质是一个没有修剪的无限增长列表**。适用于短期或小规模对话，不适合无限上下文场景。

### 3.2 `ConversationBufferWindowMemory` — 滑动窗口

**文件**: `buffer_window.py`

```python
class ConversationBufferWindowMemory(BaseChatMemory):
    k: int = 5  # 保留的最后轮数
```

**策略**: 只保留**最后 k 轮**对话。内部实现：
```python
@property
def buffer_as_messages(self) -> list[BaseMessage]:
    return self.chat_memory.messages[-self.k * 2:] if self.k > 0 else []
```

- 从 `chat_memory.messages` 中切片取最后 `k * 2` 条（每轮 Human + AI = 2 条）
- 超过窗口的消息虽然在 `chat_memory` 中留存，但**不暴露给模型**
- **简单直接，但丢弃了所有早期上下文**

### 3.3 `ConversationTokenBufferMemory` — Token 限制修剪

**文件**: `token_buffer.py`

```python
class ConversationTokenBufferMemory(BaseChatMemory):
    llm: BaseLanguageModel       # 需要 LLM 实例来计 token
    max_token_limit: int = 2000
```

**策略**: 当 context 总 token 数超过 `max_token_limit` 时，**从最早的消息开始丢弃**：

```python
def save_context(self, inputs, outputs):
    super().save_context(inputs, outputs)
    buffer = self.chat_memory.messages
    curr_buffer_length = self.llm.get_num_tokens_from_messages(buffer)
    if curr_buffer_length > self.max_token_limit:
        pruned_memory = []
        while curr_buffer_length > self.max_token_limit:
            pruned_memory.append(buffer.pop(0))  # 丢弃最旧的消息
            curr_buffer_length = self.llm.get_num_tokens_from_messages(buffer)
```

**核心特点**：
- 使用 `llm.get_num_tokens_from_messages()` **真正按 token 计数**
- **FIFO 丢弃策略**（从最早开始丢），被丢弃的消息直接删除
- 需要 LLM 实例（因为不同模型 tokenizer 不同）

### 3.4 `ConversationSummaryMemory` — 持续 LLM 摘要

**文件**: `summary.py`

```python
class ConversationSummaryMemory(BaseChatMemory, SummarizerMixin):
    buffer: str = ""               # 当前累积摘要
    memory_key: str = "history"
```

**策略**: 每轮对话后，**用 LLM 将整个对话压缩为一段摘要**：

```python
def save_context(self, inputs, outputs):
    super().save_context(inputs, outputs)         # 先保存到 chat_memory
    self.buffer = self.predict_new_summary(
        self.chat_memory.messages[-2:],           # 仅使用最后 2 条消息增量更新
        self.buffer,                              # 已有的摘要
    )
```

**摘要 Prompt**（`prompt.py` 中定义 `SUMMARY_PROMPT`）：

```
Progressively summarize the lines of conversation provided,
adding onto the previous summary returning a new summary.

Current summary:
{summary}

New lines of conversation:
{new_lines}

New summary:
```

**核心特点**：
- **增量式摘要**：只在已有摘要上添加新轮次的信息，不重新总结整个对话
- LLM 做压缩：借用模型的能力提取关键信息
- buffer 始终保持一个简短的字符串摘要
- 依赖 SummarizerMixin 中的 `predict_new_summary` 方法

### 3.5 `ConversationSummaryBufferMemory` — 摘要 + Buffer 混合（**最接近无限上下文方案**）

**文件**: `summary_buffer.py`

```python
class ConversationSummaryBufferMemory(BaseChatMemory, SummarizerMixin):
    max_token_limit: int = 2000       # token 阈值
    moving_summary_buffer: str = ""   # 累积摘要
    memory_key: str = "history"
```

**策略**: 结合前两种方案。当 token 超限时，将最早的消息**压缩为摘要**，保留最近的原始消息：

```python
def prune(self):
    buffer = self.chat_memory.messages
    curr_buffer_length = self.llm.get_num_tokens_from_messages(buffer)
    if curr_buffer_length > self.max_token_limit:
        pruned_memory = []
        while curr_buffer_length > self.max_token_limit:
            pruned_memory.append(buffer.pop(0))   # pop 最早的
            curr_buffer_length = self.llm.get_num_tokens_from_messages(buffer)
        self.moving_summary_buffer = self.predict_new_summary(
            pruned_memory,        # 被弹出的消息 -> 喂给摘要
            self.moving_summary_buffer,
        )
```

**加载时**，将摘要放在最近消息之前：

```python
def load_memory_variables(self, inputs):
    buffer = self.chat_memory.messages
    if self.moving_summary_buffer != "":
        first_messages = [
            self.summary_message_cls(content=self.moving_summary_buffer),
        ]
        buffer = first_messages + buffer   # 摘要 + 最近消息
    ...
    return {self.memory_key: final_buffer}
```

**这是 LangChain 中最接近"无限上下文"的方案**：
- ❌ 不是真正无限：摘要本身会不断增长，最终也可能超限
- ✅ 用摘要替代最早的消息，保留最近 detail
- ✅ 增量 LLM 摘要，质量随对话长度下降但可控

### 3.6 `ConversationVectorStoreTokenBufferMemory` — Token Buffer + Vectorstore

**文件**: `vectorstore_token_buffer_memory.py`

```python
class ConversationVectorStoreTokenBufferMemory(ConversationTokenBufferMemory):
    retriever: VectorStoreRetriever
    split_chunk_size: int = 1000
```

**策略**: 当 token buffer 超限时，将最早的消息对**持久化到向量数据库**，下次加载时通过**语义检索**召回相关的历史：

```python
def load_memory_variables(self, inputs):
    # 从 vectorstore 检索相关历史
    previous_history = self.memory_retriever.load_memory_variables(inputs)
    # + 当前 buffer 中的最近消息
    current_history = super().load_memory_variables(inputs)
    # 组合返回
```

**核心特点**：
- 最早的消息**不丢失**，而是存到 vectorstore
- 每次加载时根据当前**输入语义**检索相关历史
- 每条存储的消息带**时间戳**便于追溯
- 长 AI 消息会被**分块**存储

---

## 4. 辅助 Memory 类型

### 4.1 `ConversationEntityMemory` — 命名实体记忆

**文件**: `entity.py`

维护一个**实体-摘要**映射表。每轮对话：
1. 用 `ENTITY_EXTRACTION_PROMPT` 提取**命名实体**
2. 用 `ENTITY_SUMMARIZATION_PROMPT` 为每个实体生成/更新摘要
3. 存储在 `BaseEntityStore`（支持 `InMemoryEntityStore`, `RedisEntityStore`, `SQLiteEntityStore`, `UpstashRedisEntityStore`）

**返回两个变量**：`history`（最近对话）和 `entities`（实体字典）

### 4.2 `ConversationKGMemory` — 知识图谱记忆

位于 `libs/community`，提取**知识三元组** (subject, predicate, object)，输出格式如：

```
(Nevada, is a, state)<|>(Nevada, is in, US)
```

### 4.3 `CombinedMemory` — 组合器

```python
class CombinedMemory(BaseMemory):
    memories: list[BaseMemory]
```

组合多个 memory 实例，验证**变量名不冲突**，分别调用各自的 `load_memory_variables` 和 `save_context`。

### 4.4 `VectorStoreRetrieverMemory` — 向量检索记忆

**文件**: `vectorstore.py`

- 对话上下文直接存入 `VectorStoreRetriever`（通过 `add_documents`）
- 每次根据当前输入做**相似度搜索** `retriever.invoke(query)`
- 返回相关文档作为 context

### 4.5 `ReadOnlySharedMemory` & `SimpleMemory`

- **ReadOnlySharedMemory**: 包装另一个 memory 实例，`save_context` 和 `clear` 为空操作
- **SimpleMemory**: 静态 key-value 存储，不变

---

## 5. 关键设计模式总结

### 5.1 变量注入模式

所有 memory 都通过 `memory_variables` + `load_memory_variables` 向 chain 注入额外变量。Chain 在构造 prompt 时将这些变量与输入合并。

```python
# 调用时序
chain(inputs) -> load_memory_variables(inputs) -> 合并到 inputs -> prompt.format(**merged_inputs)
```

### 5.2 消息存储分离

```
Memory (策略层)           ← 决定"保留什么、扔掉什么"
  └── chat_memory (存储层)  ← 实际存储所有消息（不修剪）
```

许多 memory 虽然只有最近消息返回给模型，但 `chat_memory.messages` 保留**全部**历史。

### 5.3 同步/异步双模式

每个核心方法都有一个 `a` 前缀的异步变体，通过 `run_in_executor` 默认包装。

### 5.4 增量摘要机制（SummarizerMixin）

```python
class SummarizerMixin(BaseModel):
    llm: BaseLanguageModel
    prompt: BasePromptTemplate = SUMMARY_PROMPT

    def predict_new_summary(self, messages, existing_summary):
        new_lines = get_buffer_string(messages, ...)
        chain = LLMChain(llm=self.llm, prompt=self.prompt)
        return chain.predict(summary=existing_summary, new_lines=new_lines)
```

增量式：`new_summary = LLM(existing_summary + new_lines)`，而非 `LLM(all_messages)`。

---

## 6. 对无限上下文方案的启示

| 策略 | 优点 | 缺点 | 适合场景 |
|------|------|------|----------|
| **Buffer** | 最简单，零信息损失 | 无限增长 | 短对话 |
| **Window** | 固定 token 开销 | 丢失早期上下文 | 仅需要最近对话 |
| **Token Buffer** | 精确 token 控制 | FIFO 丢弃，无压缩 | 需严格控制窗口 |
| **Summary** | 压缩率高 | 随对话变长可能丢失细节；LLM 每次调用有成本 | 长对话，需全局摘要 |
| **Summary+Buffer** | 摘要+详情的折中 | 实现复杂，摘要会持续增长 | **最接近"无限上下文"方案** |
| **Vectorstore** | 可按语义召回 | 检索质量依赖 embedding；无法 100% 保证相关 | 长期持久化，需问答场景 |

**关键洞察**：
1. **成本与质量的平衡**：LLM 摘要提供最高质量的压缩，但每次调用有成本。Token buffer 是低成本但粗暴的 FIFO。
2. **摘要增长问题**：`ConversationSummaryBufferMemory` 的摘要本身也会随对话增长，变相消耗 token。真正无限需要**多级摘要**（对摘要再摘要）或**分层摘要**。
3. **向量检索不完美**：`ConversationVectorStoreTokenBufferMemory` 按语义检索，但无法保证召回 100% 与当前对话相关的历史信息。
4. **消息存储与上下文分离**：这是 LangChain 最强的抽象——`chat_memory` 可以持久化全部历史，而 memory 策略控制**哪些进入上下文窗口**。

---

## 7. 文件分布清单

| 文件 | 内容 |
|------|------|
| `base_memory.py` | `BaseMemory` 抽象基类 |
| `chat_memory.py` | `BaseChatMemory` 中间层 |
| `buffer.py` | `ConversationBufferMemory`, `ConversationStringBufferMemory` |
| `buffer_window.py` | `ConversationBufferWindowMemory` |
| `token_buffer.py` | `ConversationTokenBufferMemory` |
| `summary.py` | `ConversationSummaryMemory`, `SummarizerMixin` |
| `summary_buffer.py` | `ConversationSummaryBufferMemory` |
| `entity.py` | `ConversationEntityMemory`, 各种 `EntityStore` |
| `kg.py` | `ConversationKGMemory`（委托到 `community`） |
| `combined.py` | `CombinedMemory` |
| `simple.py` | `SimpleMemory` |
| `readonly.py` | `ReadOnlySharedMemory` |
| `vectorstore.py` | `VectorStoreRetrieverMemory` |
| `vectorstore_token_buffer_memory.py` | `ConversationVectorStoreTokenBufferMemory` |
| `prompt.py` | 各类模板（SUMMARY, ENTITY 等） |
| `utils.py` | `get_prompt_input_key` |
| `../schema/memory.py` | 向后兼容、重新导出 `BaseMemory` |

> **注**: LangChain v0.3+ 的 memory 模块已全部 deprecated，官方推荐迁移到 LangGraph 的 `add_memory` 模式。但该模块的设计封装了多种上下文管理策略，对 AI coding agent 的上下文窗口管理仍有重要参考价值。
