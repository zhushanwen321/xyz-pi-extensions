# Aider 上下文管理实现分析

> Aider 是一个 AI pair programming 工具，其上下文管理体系在 AI coding agent 领域具有参考价值。
> 分析基于 `main` 分支（2026-05-28 最新代码）。

---

## 一、架构总览

Aider 的上下文管理由以下几个核心模块协作完成：

| 模块 | 文件 | 职责 |
|------|------|------|
| **ChatChunks** | `aider/coders/chat_chunks.py` | 8 段式消息组装骨架 |
| **RepoMap** | `aider/repomap.py` | 仓库地图生成（PageRank + tree-sitter） |
| **ChatSummary** | `aider/history.py` | 对话历史摘要压缩 |
| **Model** | `aider/models.py` | Token 计数、预算分配 |
| **BaseCoder** | `aider/coders/base_coder.py` | 消息构建、缓存预热、上下文窗口检查 |
| **Special** | `aider/special.py` | 重要文件优先级标记 |

消息发送前被组装成一个**分层结构**，从上到下依次追加到 API call 中。

---

## 二、8 段式消息架构 (ChatChunks)

`ChatChunks` 将消息分为 8 个独立段，每段可独立启用/禁用/缓存：

```python
# aider/coders/chat_chunks.py
@dataclass
class ChatChunks:
    system: List      # 系统提示词
    examples: List    # 示例对话
    done: List        # 已完成的对话历史（已摘要或原始）
    repo: List        # repo-map + read-only 文件
    readonly_files: List  # 只读文件内容
    chat_files: List  # 聊天中的文件内容
    cur: List         # 当前轮次消息
    reminder: List    # 提醒提示词（system_reminder）
```

**组装顺序**（`all_messages()`）：

```
system → examples → readonly_files → repo → done → chat_files → cur → reminder
```

**关键设计点**：
- `readonly_files` 和 `repo` 共享一个缓存标记点（见后文缓存策略）
- `cur`（当前消息）位于末尾，确保最新上下文不被截断
- `reminder` 仅在 `max_input_tokens` 允许时追加

---

## 三、Repo-Map（仓库地图）机制

这是 Aider 最出名的上下文创新。核心思想：不要把所有文件都塞进上下文，而是用 PageRank 找到**当前任务最相关的代码符号**，仅呈现这些符号的摘要。

### 3.1 整体流程

```
用户输入 → 提取 mentions(fnames/idents)
        → 对仓库文件做 AST 解析 → 提取 tags(def/ref)
        → 构建符号引用图 → PageRank 排序
        → 按 token 预算裁剪 → 渲染为带行号的代码上下文
```

### 3.2 Tag 提取： tree-sitter + Pygments 双引擎

文件：`aider/repomap.py:get_tags_raw()`

```python
def get_tags_raw(self, fname, rel_fname):
    # 1. 用 tree-sitter 解析 AST
    lang = filename_to_lang(fname)
    language = get_language(lang)
    parser = get_parser(lang)
    
    # 2. 加载语言特定查询文件 (.scm)
    query_scm = get_scm_fname(lang)  # e.g. python-tags.scm
    tree = parser.parse(bytes(code, "utf-8"))
    
    # 3. 运行 Tags Query
    captures = self._run_captures(Query(language, query_scm), tree.root_node)
    
    # 4. 输出 Tag(name, kind='def'|'ref', line, fname)
```

输出的 Tag 包含四种信息：
- `name`：符号名（函数名、类名、变量名）
- `kind`：`def`（定义）或 `ref`（引用）
- `line`：所在行号
- `rel_fname`：相对路径

**双引擎回退**：某些语言（如 C++）的 tree-sitter 查询文件只提供 def 不提供 ref，此时用 Pygments 做 lexer 回退，提取所有 Token.Name 作为 ref。

### 3.3 PageRank 排序

文件：`aider/repomap.py:get_ranked_tags()`

```python
G = nx.MultiDiGraph()
for ident in idents:
    definers = defines[ident]
    for referencer, num_refs in Counter(references[ident]).items():
        for definer in definers:
            # 引用者→定义者 的有向边
            G.add_edge(referencer, definer, weight=use_mul * num_refs, ident=ident)

ranked = nx.pagerank(G, weight="weight", **pers_args)
```

**个性化权重（Personalization）**：

| 因素 | 权重乘数 |
|------|---------|
| 用户在输入中提到的符号 (`mentioned_idents`) | ×10 |
| 蛇形/驼峰/烤肉串命名且长度≥8 | ×10 |
| 以下划线开头 | ×0.1 |
| 定义数量 >5（太常见） | ×0.1 |
| 引用者在当前聊天文件内 | ×50 |
| 路径匹配用户输入中的 ident | +personalize |

### 3.4 Token 预算分配与自适应裁剪

```python
# 默认 map_tokens = max_input_tokens / 8，范围 1024~4096
map_tokens = max_inp_tokens / 8
map_tokens = min(map_tokens, 4096)
map_tokens = max(map_tokens, 1024)
```

**无文件模式放大**：当聊天中没有文件时（只有 repo-map），预算放大 8 倍：
```python
padding = 4096
target = min(int(max_map_tokens * self.map_mul_no_files), 
             self.max_context_window - padding)
```

**二分查找裁剪**：
```python
# 对排名结果从 0 到 num_tags 做二分搜索
while lower_bound <= upper_bound:
    tree = self.to_tree(ranked_tags[:middle], chat_rel_fnames)
    num_tokens = self.token_count(tree)
    # 15% 误差容忍
    if (num_tokens <= max_map_tokens and num_tokens > best_tree_tokens) \
       or pct_err < ok_err:
        best_tree = tree
        best_tree_tokens = num_tokens
    # 调整上下界
```

### 3.5 渲染输出格式

每文件输出其结构，包含关键定义行：
```
path/to/file.py:
class SomeClass
    def some_method
    another_function
```

每个文件只显示被 Tag 标记的行（lines of interest），周围附带有限上下文。每行截断到 100 字符以防止 minified 文件。

### 3.6 缓存系统

三层缓存：

1. **Tag 缓存**（diskcache SQLite）：`~/.aider.tags.cache.v4/`，按文件 mtime 失效
2. **Tree Context 缓存**：内存 dict，按 (rel_fname, sorted(lois), mtime) 键值
3. **Map 缓存**：`self.map_cache`，按 (chat_fnames, other_fnames, max_map_tokens, mentioned_fnames, mentioned_idents) 缓存

刷新策略三种模式：
- `auto`：上轮耗时 >1s 则启用手动缓存，否则实时重算
- `files`：始终缓存
- `manual`：仅当用户调用 `/read-only` 等命令时刷新

### 3.7 重要文件优先级

`special.py` 定义了一个包含 120+ 常见重要文件名的白名单（`.gitignore`、`pyproject.toml`、`Dockerfile`、`README.md` 等）。这些文件即使不在 PageRank 结果中，也会被**强制注入**到 repo-map 开头。

---

## 四、对话历史管理

### 4.1 ChatSummary 摘要机制

文件：`aider/history.py`

当 `done_messages` 超过 `max_chat_history_tokens`（默认 1024，最大 8192）时，触发摘要压缩。

**压缩策略**（`summarize_real`）：

```
1. 计算总 token，若 <= max_tokens 且 depth=0 → 直接返回
2. 若消息数 ≤4 或 depth>3 → 全部合并为一条摘要
3. 否则：
   a. 从尾部往前遍历，取后半段（tail）≈ max_tokens/2
   b. head 部分→ 用 summarizer model 整段压缩
   c. 若 head_summary + tail 仍然超限 → 递归（depth+1）
```

**摘要 prompt**（`prompts.summarize`）：
```
Briefly summarize this partial conversation about programming.
Include less detail about older parts and more detail about the most recent messages.
...
The summaries MUST NOT include ```...``` fenced code blocks!
Phrase the summary with the USER in first person.
Start the summary with "I asked you...".
```

摘要结果前面加上 `"I spoke to you previously about a number of things.\n"` 前缀。

**模型选择**：优先用 `weak_model`（更便宜），失败后回退到 `main_model`。

### 4.2 历史管理流程

```
用户输入新消息 →
  cur_messages += new_msg
  构建消息（format_messages）
  if token溢出 → 报错提示 /drop /clear
  发请求
  收到 response → cur_messages += response
  若 cur_messages 积累过多 → move_back_cur_messages()
    → done_messages += cur_messages
    → 启动 summarize_start() 后台线程
```

**move_back_cur_messages**：
```python
def move_back_cur_messages(self, message):
    self.done_messages += self.cur_messages
    self.summarize_start()
    self.cur_messages = []
```

### 4.3 后台摘要线程

摘要通过后台线程进行，避免阻塞交互：
```python
def summarize_start(self):
    if not self.summarizer.too_big(self.done_messages):
        return
    self.summarizer_thread = threading.Thread(target=self.summarize_worker)
    self.summarizer_thread.start()
```

```python
def summarize_worker(self):
    self.summarizing_messages = list(self.done_messages)
    self.summarized_done_messages = self.summarizer.summarize(self.summarizing_messages)
```

在 `format_chat_chunks()` 中调用 `summarize_end()` 等待线程完成。

### 4.4 Coder Switch 时的历史处理

当用户在对话中切换 edit format 或 model 时，旧格式的 assistant 消息会混淆新 LLM。Aider 的处理方式：
```python
if edit_format != from_coder.edit_format and done_messages and summarize_from_coder:
    done_messages = from_coder.summarizer.summarize_all(done_messages)
```
将旧格式的历史一次性摘要为新格式无关的通用摘要。

---

## 五、缓存策略

### 5.1 Prompt Caching 标记

文件：`aider/coders/chat_chunks.py:add_cache_control_headers()`

Aider 利用 Anthropic/OpenAI 的 prompt caching API，在消息的可缓存段尾部添加 `cache_control: ephemeral` 标记：

```python
def add_cache_control_headers(self):
    if self.examples:
        self.add_cache_control(self.examples)     # 标记 examples
    else:
        self.add_cache_control(self.system)        # 否则标记 system
    
    if self.repo:
        self.add_cache_control(self.repo)          # 标记 repo + readonly
    else:
        self.add_cache_control(self.readonly_files)
    
    self.add_cache_control(self.chat_files)        # 标记 chat_files
```

**缓存链**：API 调用中，所有在这个标记之前的消息都被缓存。由于标记加在每个段末尾且上游段不包含 `cache_control`，因此**整条链上的累积文本**都被缓存。

### 5.2 缓存预热

文件：`aider/coders/base_coder.py:warm_cache()`

```python
def warm_cache_worker(self):
    while self.ok_to_warm_cache:
        time.sleep(1)
        # 每 5 分钟（默认）发送一次 max_tokens=1 的请求
        # 覆盖所有 cacheable_messages()
        completion = litellm.completion(
            model=self.main_model.name,
            messages=self.cache_warming_chunks.cacheable_messages(),
            stream=False,
            max_tokens=1
        )
```

配置参数：
- `--cache-keepalive-pings N`：预热 ping 次数
- 默认间隔 5 分钟减去 5 秒
- 可通过 `AIDER_CACHE_KEEPALIVE_DELAY` 环境变量调整

### 5.3 Tag 文件缓存

RepoMap 的 tag 缓存使用 `diskcache.Cache`（底层 SQLite），按文件 mtime 做失效检测：
```python
CACHE_VERSION = 4  # tree-sitter 使用 v4，否则 v3
TAGS_CACHE_DIR = f".aider.tags.cache.v{CACHE_VERSION}"

val = self.TAGS_CACHE.get(cache_key)
if val is not None and val.get("mtime") == file_mtime:
    return val["data"]  # 命中
else:
    data = list(self.get_tags_raw(fname, rel_fname))
    self.TAGS_CACHE[cache_key] = {"mtime": file_mtime, "data": data}
```

**故障隔离**：遇到 SQLite 错误时自动回退到内存 dict。

---

## 六、Token 预算分配

### 6.1 各段预算

Aider 的 token 预算来源：

| 段 | 预算策略 | 代码位置 |
|----|---------|---------|
| **System prompt** | 固定大小，约数百 token | `fmt_system_prompt()` |
| **Example messages** | 固定大小 | `gpt_prompts.example_messages` |
| **Done messages（历史）** | `max_chat_history_tokens` = `max_input_tokens / 16`，范围 1024~8192 | `Model.__init__()` |
| **Repo-map** | `max_input_tokens / 8`，范围 1024~4096 | `Model.get_repo_map_tokens()` |
| **Chat files** | 所有添加的文件（不限制，但会检查总窗口） | `get_files_content()` |
| **Read-only files** | 所有添加的只读文件 | `get_read_only_files_content()` |
| **Current messages** | 当前轮次（不独立限制） | `cur_messages` |
| **Reminder** | 仅在总 token < max_input_tokens 时追加 | `format_chat_chunks()` |

### 6.2 溢出防护

发送前调用 `check_tokens()`：
```python
if max_input_tokens and input_tokens >= max_input_tokens:
    # 显示详细的溢出报告和建议（/drop, /clear）
    if not self.io.confirm_ask("Try to proceed anyway?"):
        return False
```

### 6.3 Token 计数

支持两种计数方式：
1. **litellm.token_counter**：对 messages list 统一计数
2. **litellm.encode**：对单个字符串分词后取 len

对于大段文本，采用**采样估算**：
```python
def token_count(self, text):
    if len_text < 200:
        return self.main_model.token_count(text)
    # 采样 1/100 行，按比例估算
    step = num_lines // 100 or 1
    lines = lines[::step]
    sample_tokens = self.main_model.token_count(sample_text)
    return sample_tokens / len(sample_text) * len_text
```

### 6.4 /tokens 命令

用户可通过 `/tokens` 命令查看完整的 token 使用明细：
```
$0.0000    1,234 system messages
$0.0000    5,678 chat history         use /clear to clear
$0.0000    2,048 repository map       use --map-tokens to resize
$0.0000      789 src/main.py          /drop to remove
==========================================
$0.0000    9,749 tokens total
           90,251 tokens remaining
          100,000 tokens max context window size
```

---

## 七、各机制的优缺点总结

### Repo-Map
| 优点 | 缺点 |
|------|------|
| 用 PageRank 替代全量文件，大幅降低 token 消耗 | 首次扫描大仓库较慢（异步优化已做：TQDM + 后台线程） |
| tree-sitter 精确定位定义/引用位置 | 依赖 language pack，部分语言不支持或只返回 def |
| 个性化权重使相关文件排名更高 | 复杂重构场景可能遗漏跨模块依赖 |
| 无文件时自动放大预算到 8 倍 | mtime 检测在 NFS 等文件系统上有问题 |

### ChatSummary
| 优点 | 缺点 |
|------|------|
| 后台线程异步摘要，不阻塞用户交互 | 摘要 lossy，精确事实可能在摘要中丢失 |
| 递归二分策略保留最新消息的完整性 | 只依赖弱模型摘要，质量有限 |
| depth ≤ 3 防止无限递归 | 无增量摘要，每次重算所有 done_messages |

### Prompt Caching
| 优点 | 缺点 |
|------|------|
| 利用 API 级缓存，相同前缀不重复计费 | 仅 Anthropic 和部分 OpenAI 模型支持 |
| 预热线程保持缓存活跃 | 预热会额外消耗 token (max_tokens=1) |
| 自动标记不常变动的段（repo, readonly） | 缓存边界不够精细（repo 和 readonly 共用一个标记点） |

---

## 八、值得借鉴的设计

1. **分层消息组装**：8 段式架构清晰隔离了不同来源的上下文，每段可独立启用/缓存/摘要
2. **符号级上下文选择**：PageRank on code symbols 比简单文件列表更精准
3. **二分裁剪**：用二分搜索替代贪心法，精确控制 token 预算
4. **后台摘要线程**：异步处理不阻塞主交互
5. **多级缓存**：diskcache → memory → API-level (prompt caching)，三层联合
6. **Token 预算自适应**：根据模型 max_input_tokens 动态分配各段预算，用户无文件时自动放大
7. **双缓存标记策略**：利用 API 的 cache_control 头，将不变内容标记为可缓存

---

## 九、关键代码文件索引

| 文件 | 代码行数 | 核心函数 |
|------|---------|---------|
| `aider/repomap.py` | 867 | `get_ranked_tags()`, `get_ranked_tags_map_uncached()`, `get_tags_raw()` |
| `aider/history.py` | 143 | `ChatSummary.summarize_real()`, `ChatSummary.summarize_all()` |
| `aider/coders/chat_chunks.py` | 51 | `ChatChunks.all_messages()`, `add_cache_control_headers()` |
| `aider/coders/base_coder.py` | 2486 | `format_chat_chunks()`, `send_message()`, `warm_cache()`, `summarize_start()` |
| `aider/models.py` | 1323 | `Model.token_count()`, `Model.get_repo_map_tokens()`, `Model.send_completion()` |
| `aider/special.py` | 129 | `filter_important_files()`, `is_important()` |
| `aider/commands.py` | 1712 | `cmd_tokens()`, `cmd_copy_context()`, `cmd_clear()` |
| `aider/prompts.py` | 113 | `summarize`（摘要 prompt） |
