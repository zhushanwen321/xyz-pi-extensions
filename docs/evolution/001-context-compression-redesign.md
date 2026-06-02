# 001 — 上下文压缩方案重新设计

> 状态：draft  
> 日期：2026-05-31  
> 前置调研：
> - `main/docs/research/infinite-context-survey.md` — 通用方案调研
> - `main/docs/research/infinite-context-research-report.md` — 学术论文调研
> - `main/docs/research/hermes-agent-research.md` — Hermes Agent 调研
> - `main/docs/research/openclaw-research.md` — OpenClaw 调研
> - `main/docs/research/coding-agents-context-research.md` — 5 个 Coding Agent 对比调研
> - `main/infinite-context/docs/compact-flow-analysis.md` — Pi 原生 compact 触发流程分析

---

## 1. 当前问题

之前实现的 tree-compact（infinite-context）存在 4 个核心问题：

1. **压缩后 tree-context 体积过小**（<1000 token，期望原始的 20%-50%）— 原生 compact 摘要质量不可控
2. **和 Pi 原生 compact 冲突** — 两者触发时机和执行逻辑冲突，有时只终止了原生 compact 但没触发 tree-compact
3. **无法验证压缩质量** — 没有压缩后评估机制
4. **"无限上下文"概念是否可行** — 单纯压缩不能实现无限上下文

**根因分析**：tree-compact 作为扩展试图拦截/替代原生 compact，但原生 compact 的流程由 Pi 核心控制，扩展只能在 `context` 和 `turn_end` 事件中做有限干预。这种"补丁式"设计本质上不稳定。

---

## 2. Pi 上下文要素分析

### 2.1 上下文全景图

Pi 运行时传给 LLM 的完整上下文由以下要素组成：

```
┌─────────────────────────────────────────────────────┐
│                  System Prompt                       │  ← 每次请求都发
├─────────────────────────────────────────────────────┤
│  1. 基础身份 + 工具列表 + Guidelines                  │  ~500-800 token
│  2. Pi 文档路径引用                                   │  ~100 token
│  3. appendSystemPrompt（扩展注入）                     │  ~200-2000 token
│  4. Context Files（CLAUDE.md 层级）                    │  ~2000-10000 token
│  5. Skills 描述                                       │  ~2000-20000 token
│  6. 日期 + 工作目录                                    │  ~20 token
├─────────────────────────────────────────────────────┤
│              Compaction Summary（如有）               │  ← 历史摘要
│  7. 结构化摘要（Goal/Constraints/Progress/...）        │  ~2000-16000 token
│  8. 文件操作追踪（read-files / modified-files）        │  ~100-500 token
│  9. Turn Prefix Summary（如有 split turn）            │  ~500-4000 token
├─────────────────────────────────────────────────────┤
│                 Message History                       │  ← 最近保留的消息
│  10. User 消息                                        │  变化极大
│  11. Assistant 消息（text + thinking + toolCall）      │  变化极大
│  12. Tool Result 消息                                 │  变化极大 ★
│  13. BashExecution 消息                               │  变化极大 ★
│  14. Custom Message（扩展注入）                        │  ~100-1000 token/条
│  15. Branch Summary（如有分支）                        │  ~500-2000 token
└─────────────────────────────────────────────────────┘
```

源码位置：
- System Prompt 构建：`pi-mono/packages/coding-agent/src/core/system-prompt.ts`
- Context Files 加载：`pi-mono/packages/coding-agent/src/core/resource-loader.ts`（`loadProjectContextFiles`）
- Skills 加载：`pi-mono/packages/coding-agent/src/core/skills.ts`
- 消息类型定义：`pi-mono/packages/coding-agent/src/core/messages.ts`
- Compaction 实现：`pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`
- Session 上下文构建：`pi-mono/packages/coding-agent/src/core/session-manager.ts`（`buildSessionContext`）

### 2.2 各要素 Token 特征

| # | 要素 | 典型 Token 量 | 增长模式 | 可压缩性 |
|---|------|-------------|---------|---------|
| 1 | 基础身份+工具+Guidelines | 500-800 | 固定 | ❌ 不可压 |
| 2 | Pi 文档路径 | ~100 | 固定 | ❌ 不可压 |
| 3 | appendSystemPrompt | 200-2000 | 低增长 | ⚠️ 有限（扩展控制） |
| 4 | Context Files (CLAUDE.md) | 2000-10000 | 中增长 | ✅ 按项目需要选择层级 |
| 5 | Skills 描述 | 2000-20000 | 中增长 | ✅ **高度可压缩** |
| 6 | 日期+目录 | ~20 | 固定 | ❌ 不可压 |
| 7 | Compaction Summary | 2000-16000 | 压缩后固定 | ⚠️ 已是压缩结果 |
| 8 | 文件操作追踪 | 100-500 | 线性 | ✅ 保留最近 N 次 |
| 9 | Turn Prefix Summary | 500-4000 | 偶发 | ⚠️ 已是压缩 |
| 10 | User 消息 | 100-2000/条 | 线性 | ⚠️ 低（保留意图） |
| 11 | Assistant 消息 | 500-5000/条 | 线性 | ✅ **thinking 块大户** |
| 12 | Tool Result | 500-50000/条 | **爆炸增长 ★** | ✅ **最高压缩收益** |
| 13 | BashExecution | 500-30000/条 | **爆炸增长 ★** | ✅ **第二高压缩收益** |
| 14 | Custom Message | 100-1000/条 | 线性 | ⚠️ 有限 |
| 15 | Branch Summary | 500-2000 | 偶发 | ⚠️ 已是压缩 |

### 2.3 上下文膨胀的根因

**两个爆炸增长要素是上下文膨胀的主因：**

1. **Tool Result（#12）** — `read` 返回整个文件（几万 token）、`grep` 返回大量匹配、`edit` 的确认输出。一次 `read` 大文件就能吃掉 10000+ token
2. **BashExecution（#13）** — 编译输出、测试日志、`ls -la` 等，经常几千到几万 token

**三个"可压缩但当前没压"的要素：**

3. **Skills 描述（#5）** — 所有 skill 的描述每次全量注入 system prompt，20+ skill 时可达 20000 token
4. **Assistant thinking 块（#11）** — Qwen Code 的做法（5 分钟空闲后清理）值得借鉴
5. **Context Files（#4）** — 多层 CLAUDE.md 全量注入

### 2.4 原生 Compaction 已有的能力

Pi 原生 compaction（`compaction.ts`）已经相当完善：

- **结构化摘要模板**：7 段（Goal / Constraints / Progress / Decisions / Next Steps / Critical Context）
- **迭代更新摘要**：`UPDATE_SUMMARIZATION_PROMPT` — 合并新消息到已有摘要，而非重新生成
- **Tool Result 序列化截断**：`TOOL_RESULT_MAX_CHARS = 2000` — 摘要时 tool result 已截断
- **文件操作追踪**：`<read-files>` 和 `<modified-files>` XML 标签
- **Split turn 处理**：`generateTurnPrefixSummary` 处理切断中间 turn 的情况
- **保留最近消息**：`keepRecentTokens = 20000`（默认）
- **触发阈值**：`reserveTokens = 16384`（默认），即 context window - 16K 时触发

**关键发现：Pi 不缺 compaction，缺的是 compaction 前的预处理和 compaction 后的质量保障。**

---

## 3. 调研结论：各工具精华与糟粕

### 3.1 值得借鉴的精华

| 工具 | 精华设计 | 为什么好 |
|------|---------|---------|
| **Claude Code** | 五级渐进式压缩（MicroCompact → API 管理 → SessionMemory → Full Compact） | 从零成本操作开始逐级升级，避免一刀切 |
| **Claude Code** | 结构化 9 段摘要模板 | 确保 Primary Request、Files and Code Sections、Errors and fixes 等关键信息不丢 |
| **Claude Code** | Fork Agent 复用 prompt cache | 压缩时复用主线程 cache，避免 full cache miss |
| **Claude Code** | 连续失败熔断器（3 次） | 防止压缩本身变成问题 |
| **Aider** | PageRank RepoMap（tree-sitter AST → 图排序 → 二分截断） | 最优雅的代码上下文管理——图排序让 LLM 理解代码结构 |
| **Aider** | Architect/Editor 两阶段上下文隔离 | "理解代码"和"编辑代码"的上下文需求不同 |
| **Aider** | 后台异步摘要 + 弱模型优先 | 不阻塞主流程，用便宜模型做摘要 |
| **Hermes** | 五阶段压缩流水线 + 反抖动保护 | 先廉价 tool result 修剪，再昂贵 LLM 摘要；连续压缩节省 <10% 时停止 |
| **Hermes** | 13 段结构化摘要模板 | Active Task / Completed Actions / Active State 等字段，确保任务连续性 |
| **Hermes** | Bookend 式 FTS5 会话搜索 | 开头 3 条 + 匹配 ±5 条 + 结尾 3 条，一次搜索理解完整上下文 |
| **Hermes** | Skill 自学习闭环（Curator 生命周期） | active → stale(30天) → archived(90天)，pin 豁免 |
| **Hermes** | Tool Pair 清理（压缩后修复 orphan tool_call/result） | 处理压缩后的 API 消息格式合法性 |
| **OpenClaw** | Context Engine 可插拔接口 | bootstrap → ingest → assemble → compact → maintain 生命周期 |
| **OpenClaw** | Compaction 四级容错 | 完整摘要 → 排除超大消息 → 部分摘要 → 兜底文本 |
| **OpenClaw** | Prompt Cache stable/dynamic 分割 | stable prefix 跨 turn 不变命中 cache |
| **OpenClaw** | Identifier Preservation（摘要时保留所有标识符） | 防止压缩后 UUID/路径被改写 |
| **Qwen Code** | 结构化 XML `<state_snapshot>` 压缩 | 比自然语言摘要更结构化 |
| **Qwen Code** | 70% 触发阈值 | 给压缩留够执行空间 |
| **Qwen Code** | Thinking 块 5 分钟空闲清理 | 其他工具都没有的优化 |

### 3.2 不值得学的糟粕

| 工具 | 问题 | 原因 |
|------|------|------|
| **OpenCode** | 累加 token 统计 | `usage.input + output` 累加 ≠ 实际上下文 token 数 |
| **OpenCode** | 95% 才触发压缩 | 太晚了，agent loop 中间容易溢出 |
| **Hermes** | Session 分裂机制 | 压缩后分裂为父子 session，引入 lineage/rebind 等大量复杂度 |
| **Hermes/OpenClaw** | Token 估算用 chars/4 | 对中文/代码严重低估，应该用 tiktoken 或 API 精确计数 |
| **普遍** | LLM 摘要对代码细节损失 | read_file 的源码 → 摘要后只剩"读取了文件 X" |
| **Hermes** | MEMORY.md 纯文本无结构 | 没有 CRUD、过期、优先级，长期膨胀失控 |
| **Qwen Code** | 全量记忆每次发送 | 不按相关性过滤 |
| **OpenClaw** | System Prompt 构建 1300+ 行 | 维护成本极高 |

---

## 4. 概念澄清："无限上下文" vs "上下文管理"

这两个概念有本质区别但互补：

| 维度 | 无限上下文 | 上下文管理 |
|------|-----------|-----------|
| 核心问题 | "上下文窗口不够用怎么办" | "给 LLM 看什么信息" |
| 解决方向 | 压缩/摘要/截断，让有限窗口装下更多 | 精准选择和注入相关信息 |
| 类比 | 把大箱子压缩到小箱子 | 精心挑选放哪些东西进箱子 |
| 典型方案 | Compact、Summarization、Observation Masking | RAG、Memory、RepoMap |
| 关注点 | 信息保留度（压缩后还能记得多少） | 信息相关性（注入的是否有用） |

**关键洞察**：无限上下文只解决了"桶有多大"的问题，没解决"桶里装什么"的问题。真正的上下文工程需要同时解决两个问题。

**tree-compact 本质是压缩方案**，属于"无限上下文"范畴。但它：
1. 只做压缩，不做信息选择——压缩后仍然是"有什么塞什么"
2. 依赖原生 compact 能力——质量由模型决定，不可控
3. 没有记忆层——压缩后丢失的信息无法恢复

**建议将"无限上下文"重定义为"持久工作记忆"**——核心不是"窗口有多大"，而是"agent 能记住多少、找回多少"。

---

## 5. 压缩方案设计

### 5.1 渐进式压缩流水线

借鉴 Claude Code 的五级压缩和 Hermes 的反抖动保护，设计三级流水线：

```
触发检查（70% 阈值）
  │
  ├─ Level 0: 零成本清理（不调 LLM，不调 API）
  │   ├─ 清空 >30min 的旧 tool_result（保留摘要标记）
  │   ├─ 截断 bash 输出到首尾各 2K
  │   ├─ 清理 >5min 空闲的 thinking 块
  │   └─ 检查是否已降到安全水位 → 是则结束
  │
  ├─ Level 1: 轻量结构化压缩（用便宜模型）
  │   ├─ Tool Result 摘要化（大文件只保留"读取了 X，主要含 Y"）
  │   ├─ 对话历史结构化摘要（Pi 已有的 compaction）
  │   └─ 检查压缩比是否合理 → 否则触发反抖动停止
  │
  └─ Level 2: 紧急压缩（90%+ 阈值时）
      └─ 更激进的清理（只保留最近 3 轮完整）
```

### 5.2 各要素的具体压缩策略

#### Level 0 策略（零成本，不调 API）

| 策略 | 目标要素 | 预计节省 | 实现方式 |
|------|---------|---------|---------|
| **过期 Tool Result 清空** | #12 | 30-50% | 在 `context` 事件中，将 >30min 的 tool_result 内容替换为 `[Result for read("src/foo.ts") expired]` |
| **Bash 输出截断** | #13 | 20-40% | 保留首尾各 2K，中间标注 `[... N lines truncated]` |
| **Thinking 块空闲清理** | #11 thinking | 5-15% | 5 分钟无活动后清空 thinking 内容为 `[thinking expired]` |
| **文件操作去重** | #8 | 小 | 只保留每个文件的最终操作状态 |

#### Level 1 策略（调用 LLM，用便宜模型）

| 策略 | 目标要素 | 预计节省 | 实现方式 |
|------|---------|---------|---------|
| **Tool Result 预摘要** | #12 | 40-60% | compact 前，将大 tool_result 用便宜模型摘要为 1-2 句话 |
| **对话历史 compact** | #10-15 | 60-80% | Pi 已有的原生 compaction（增强输入质量） |

#### Level 2 策略（紧急情况）

| 策略 | 目标要素 | 预计节省 | 实现方式 |
|------|---------|---------|---------|
| **激进截断** | 全部历史 | 80-90% | 只保留最近 3 轮 + 摘要 |
| **Skills 缩减** | #5 | 10-30% | 紧急时只保留 skill 名和触发词，去掉详细说明 |

### 5.3 System Prompt 侧的优化（非对话历史）

这部分不是"压缩"，而是"精简注入"——减少一开始塞入的内容：

| 策略 | 目标要素 | 预计节省 | 实现方式 |
|------|---------|---------|---------|
| **Skills 按需加载** | #5 | 10-30% | 只注入 skill 名+描述+触发词，匹配后读 SKILL.md 全文 |
| **CLAUDE.md 层级选择** | #4 | 5-20% | 根据当前任务类型选择注入哪些层级的 context file |

### 5.4 质量保障机制

借鉴各工具的保障设计：

| 机制 | 来源 | 实现方式 |
|------|------|---------|
| **反抖动保护** | Hermes | 连续压缩节省 <10% 时停止自动压缩 |
| **熔断器** | Claude Code | 连续 N 次压缩失败后停止尝试 |
| **压缩比验证** | 新增 | 压缩后检查摘要 token 量是否在预期范围（20-50% 原始），过低则告警 |
| **Identifier Preservation** | OpenClaw | 摘要 prompt 中明确要求保留所有文件路径、函数名、变量名 |

---

## 6. 架构方向选择

基于调研，有三个方向可选：

### 方向 A：增强原生 Compaction（推荐短期）

**思路**：不替代原生 compact，而是在 compact 前后做增强。

- compact 前：Level 0 零成本清理（tool result 过期、bash 截断、thinking 清理）
- compact 后：验证摘要质量、反抖动检查

**优势**：改动最小，不与原生 compact 冲突  
**劣势**：仍然依赖原生 compact 的摘要质量

### 方向 B：完全自建 Compaction（中期）

**思路**：实现自己的压缩流水线，绕过原生 compact。

- 参考 Hermes 的五阶段压缩
- 13 段结构化摘要模板
- 多级容错
- Tool pair 清理

**优势**：完全可控  
**劣势**：工作量大，需要处理 Pi API 的各种边界情况

### 方向 C：持久工作记忆架构（长期）

**思路**：将"无限上下文"升级为"持久工作记忆"。

- Level 0/1 压缩（方向 A）
- 跨会话记忆（MEMORY.md 结构化 + FTS5 搜索）
- Skill 自学习闭环
- 代码上下文管理（PageRank RepoMap 思路）

**优势**：解决根本问题  
**劣势**：需要较大的架构改动

---

## 7. 建议路线

```
Phase 1（2-3 天）：方向 A — 增强原生 Compaction
  ├─ 实现 Level 0 零成本清理（tool result 过期 + bash 截断 + thinking 清理）
  ├─ 放弃 tree-compact 的"替代原生 compact"思路
  └─ 验证：观察 compact 后摘要 token 是否仍在预期范围

Phase 2（1-2 天）：System Prompt 精简
  ├─ Skills 按需加载
  └─ 验证：测量 system prompt 优化后的 token 节省

Phase 3（评估后决定）：方向 B 或 C
  ├─ 如果 Phase 1/2 效果好 → 继续 Phase 3 增强
  └─ 如果效果不够 → 考虑方向 B（自建 compaction）
```

---

## 8. 开放问题

1. **Level 0 的 tool result 过期清理在哪个事件中实现？** `context` 事件中修改 messages？还是 compact 前的 hook？
2. **原生 compact 的摘要质量如何量化评估？** 需要设计评估指标和自动化测试
3. **Skills 按需加载的触发机制？** 是关键词匹配还是 LLM 判断？
4. **是否需要跨会话记忆？** 如果需要，MEMORY.md 的结构化格式如何设计？
5. **PageRank RepoMap 是否值得做？** Pi 作为 coding agent 的代码上下文管理是否有更好的方案？
