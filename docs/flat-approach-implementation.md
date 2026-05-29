# 扁平方案(P0)—具体实施计划

> 基于 Pi 扩展系统 API 的能力边界，拆解四层方案中可以在纯扩展层面实施的部分。
> 核心约束：扩展无法替换/删除 LLM 上下文中的消息——只能观察、记录、索引、注入新消息。

---

## 0. 能力边界：能做什么、不能做什么

### 能做的（纯扩展）

| 能力 | Pi API | 用途 |
|------|--------|------|
| 监听工具调用 | `pi.on("turn_end")` + 读取 entries | 构建段索引，记录每轮工具调用 |
| 持久化状态 | `pi.appendEntry(type, data)` | 保存段索引、L1 压缩记录、锚节点 |
| 文件系统读写 | Node.js `fs` | 冷数据归档（segments/ JSON 文件） |
| 注册工具 | `pi.registerTool()` | `recall` 工具、`memory_save` 工具 |
| 注册命令 | `pi.registerCommand()` | `/context-status` 命令 |
| 注入消息 | `pi.sendUserMessage()` + `pi.on("before_agent_start")` 返回值 | Steering: 注入锚节点摘要、压缩摘要 |
| 上下文用量查询 | `ctx.getContextUsage()` → `{ contextWindow, tokens }` | 判断是否触发压缩警告 |
| 启动 subagent | `subagent` 工具（Pi 提供） | 异步 L2 摘要生成（后台 subagent） |
| TUI 渲染 | `ctx.ui.setWidget/Status/notify` | 上下文使用率可视化 |

### 不能做的（需要 Pi 核心改动）

| 缺失能力 | 影响 | 备选方案 |
|---------|------|---------|
| **无法修改/删除 messages 数组** | L1 压缩后的内容无法从 LLM 上下文中移除 | Steering 注入摘要; 依赖 Pi 原生 compact |
| **无法在 LLM 调用前拦截并改写 prompt** | 锚节点无法在每次 LLM 调用时自动前置 | 仅在 `before_agent_start` 时注入一次 |
| **无法获取精确 token 预算** | 只能拿到 context usage 百分比，无法做精确预算管理 | 用估算代替 |
| **无法触发 Pi 原生 compact** | 不能编程式调用 compact | 通过 steering 建议用户 `/compact` |

---

## 1. Phase 1 实施清单

### 1.1 整体结构

```
infinite-context/
├── index.ts                    # 入口: 注册所有 tool + command + 事件
├── package.json
├── src/
│   ├── state.ts                # 运行时状态 + 数据模型
│   ├── constants.ts            # 阈值配置、存储路径
│   │
│   ├── observers/
│   │   └── segment-builder.ts  # 段索引观察器: 监听事件, 构建段结构
│   │
│   ├── compression/
│   │   ├── l1-compressor.ts    # L1规则压缩: 工具输出→引用 (纯函数)
│   │   └── compression-trigger.ts # 压缩触发判断
│   │
│   ├── storage/
│   │   ├── cold-store.ts       # 冷数据: 段文件读写 + 索引
│   │   └── entry-store.ts      # session entry 读写 (通过 pi.appendEntry)
│   │
│   ├── tools/
│   │   ├── recall.ts           # recall tool: 关键词搜索冷数据
│   │   └── memory-status.ts    # /context-status 命令
│   │
│   ├── steering/
│   │   └── anchor-injector.ts  # 在 before_agent_start 时注入锚节点摘要
│   │
│   └── templates/
│       └── prompts.ts          # Steering prompt 模板
│
└── tsconfig.json
```

### 1.2 分步执行

---

#### P1.1 段索引观察器 (segment-builder)

**目标**: 监听每个 turn 的工具调用，构建段(Segment)结构。

**输入**: `turn_end` 事件 + `ctx.sessionManager.getEntries()` 中的工具调用记录

**输出**: 段索引存储在 session entry 中，冷数据段文件写入 `.pi/infinite-context/segments/`

**段划分策略**（简化版——Phase 1 用启发式规则，不用 LLM）：

```
段类型判定规则:
- task_segment: goal_manager create_tasks 调用 → 新段开始
- exploration_segment: 连续 3+ 次 read/grep/glob 无 edit → 探索段
- debugging_segment: bash/test 调用 + 紧随的 edit → 调试段
- conversation_segment: 纯对话，无工具调用 → 对话段

段边界:
- 用户新消息开始 = 新段开始
- 段内工具调用超过 15 个 = 强制分段
```

**关键实现**:

```typescript
// src/observers/segment-builder.ts

interface SegmentIndex {
  segments: SegmentMeta[];
  currentSegment: SegmentMeta | null;
  totalTurns: number;
  totalToolCalls: number;
}

interface SegmentMeta {
  segmentId: string;
  type: 'task' | 'exploration' | 'debugging' | 'conversation';
  objective: string;             // 用户最后一条消息截取前100字
  turnRange: { start: number; end: number };
  toolCallCount: number;
  l1Compressed: CompressedTurn[]; // L1 压缩后的摘要列表
  archived: boolean;              // 是否已将原始数据归档到冷层
}

interface CompressedTurn {
  turnIndex: number;
  toolName: string;
  compressed: string;            // L1规则压缩结果
  rawEntryIndex: number;         // 指向原始 entry 的索引 (用于 recall)
}

// 段边界检测
function detectSegmentBoundary(
  prevTurns: TurnMeta[],
  currentTurn: TurnMeta,
): boolean {
  // 1. 用户显式新指令
  if (currentTurn.userMessage?.startsWith('/goal')) return true;
  if (currentTurn.userMessage?.length > 50) return true; // 长消息 = 新任务

  // 2. Goal 任务变更
  if (currentTurn.toolCalls?.some(c => c.name === 'goal_manager' && c.action === 'create_tasks')) return true;

  // 3. 连续无进展
  if (prevTurns.slice(-5).every(t => !t.hasEdit) && currentTurn.hasEdit) return true;

  // 4. 段过长（硬上限）
  if (prevTurns.length >= 15) return true;

  return false;
}
```

**存储位置**:
- 段索引: `pi.appendEntry("infinite-context-segment-index", indexData)`
- 冷数据文件: `.pi/infinite-context/segments/<sessionId>/<segmentId>.json`

---

#### P1.2 L1 规则压缩 (l1-compressor)

**目标**: 将工具调用结果替换为简洁的结构化引用，零 API 成本、零延迟。

**输入**: 工具调用记录（工具名 + 参数 + 返回摘要）

**输出**: CompressedTurn 对象

**压缩规则**（纯函数，无 LLM 调用）:

```typescript
// src/compression/l1-compressor.ts

function compressToolCall(toolCall: ToolCallRecord): string {
  switch (toolCall.name) {
    case 'read':
      // "读取了 src/auth/token.ts L1-210"
      return `读取了 ${shortPath(toolCall.params.path)} L${toolCall.params.offset || 1}-${toolCall.params.limit ? toolCall.params.offset + toolCall.params.limit : '全部'}`;

    case 'bash':
      // "npm test -- --grep auth: 3 pass, 1 fail (token refresh expired)"
      return compressBashOutput(toolCall);

    case 'edit':
      // "编辑了 src/auth/token.ts: 修改了 sanitize 函数"
      return `编辑了 ${shortPath(toolCall.params.path)}`;

    case 'write':
      // "创建了 src/auth/new.ts (245 行)"
      return `创建了 ${shortPath(toolCall.params.path)}`;

    case 'grep':
    case 'rg':
      // "grep 'function sanitize' → 3 个匹配 (auth/token.ts, ...)"
      return compressGrepOutput(toolCall);

    case 'glob':
    case 'ls':
      // "列出 src/auth/ → 12 个文件"
      return compressGlobOutput(toolCall);

    case 'subagent':
      // "subagent: 分析 auth 模块 → 成功 (1.2s)"
      return `subagent: ${toolCall.params.task?.slice(0, 50)}...`;

    default:
      return `${toolCall.name}: 完成`;
  }
}

function compressBashOutput(tc: ToolCallRecord): string {
  const cmd = tc.params.command;
  const output = tc.result?.output || '';
  const lines = output.split('\n').filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || '';

  // 测试结果特殊处理
  if (cmd.includes('test') || cmd.includes('jest') || cmd.includes('vitest')) {
    const passMatch = output.match(/(\d+)\s+pass/);
    const failMatch = output.match(/(\d+)\s+fail/);
    if (passMatch || failMatch) {
      return `测试: ${passMatch?.[1] || 0} pass, ${failMatch?.[1] || 0} fail`;
    }
  }

  // 通用: 截取最后一行（不含完整输出）
  if (lastLine.length > 100) {
    return `bash: ${cmd.slice(0, 50)}... → ${lastLine.slice(0, 80)}...`;
  }
  return `bash: ${cmd.slice(0, 50)}... → ${lastLine}`;
}

function shortPath(fullPath: string): string {
  // /Users/.../project/src/auth/token.ts → src/auth/token.ts
  const cwd = process.cwd();
  return fullPath.startsWith(cwd) ? fullPath.slice(cwd.length + 1) : fullPath;
}
```

**保存时机**: 在 `turn_end` 事件中，将本轮的工具调用做 L1 压缩后追加到当前段的 `l1Compressed` 数组。

---

#### P1.3 冷数据持久化 (cold-store)

**目标**: 将完整的工具调用输出、对话轮次归档到文件系统，建立索引供 recall 检索。

**存储布局**:

```
.pi/infinite-context/
├── index.json                     # 全局会话索引
├── segments/
│   └── <sessionId>/
│       ├── <segmentId>.json       # 段元数据 + L1压缩数组
│       └── ...
├── cold/
│   └── <sessionId>/
│       ├── <segmentId>/
│       │   ├── turns.json         # 该段的完整对话轮次
│       │   ├── tool-outputs/      # 工具输出的原始内容
│       │   │   ├── turn_12_bash.json
│       │   │   ├── turn_13_read.json
│       │   │   └── ...
│       │   └── segment-summary.md # 段的L2摘要(Phase 2)
│       └── ...
└── recall-index.json              # 全文搜索倒排索引
```

**关键实现**:

```typescript
// src/storage/cold-store.ts

interface ColdStore {
  archiveSegment(sessionId: string, segment: SegmentMeta, turns: TurnData[]): Promise<void>;
  archiveToolOutput(sessionId: string, segmentId: string, turnIndex: number, toolCall: ToolCallRecord): Promise<void>;
  searchIndex(query: string, scope: { sessionId?: string, segmentType?: string }): Promise<SearchResult[]>;
  getSegment(sessionId: string, segmentId: string): Promise<SegmentData | null>;
}

// 归档时机: 段结束时 (detectSegmentBoundary 返回 true)
async function archiveCurrentSegment(
  sessionId: string,
  segment: SegmentMeta,
  turns: TurnData[],
): Promise<void> {
  const segDir = `.pi/infinite-context/cold/${sessionId}/${segment.segmentId}`;
  await fs.mkdir(segDir, { recursive: true });

  // 1. 写入完整轮次 (原始对话 + 工具调用)
  await fs.writeFile(`${segDir}/turns.json`, JSON.stringify(turns, null, 2));

  // 2. 写入 L1 压缩版 (用于 recall 快速浏览)
  await fs.writeFile(
    `.pi/infinite-context/segments/${sessionId}/${segment.segmentId}.json`,
    JSON.stringify({
      ...segment,
      l1Compressed: segment.l1Compressed,
    }, null, 2),
  );

  // 3. 更新 recall 倒排索引
  await updateRecallIndex(segment);
}

// 倒排索引: 按关键词 → 段ID → 轮次 做映射
async function updateRecallIndex(segment: SegmentMeta): Promise<void> {
  // 从 objective + l1Compressed 中提取关键词
  // 写入 recall-index.json 的倒排表
}
```

---

#### P1.4 recall 工具

**目标**: 让 LLM 能通过关键词搜索冷数据中的历史内容。这是 Phase 1 唯一真正能让无限上下文"可用"的功能——当 LLM 发现缺少上下文时，主动检索。

**参数设计**:

```typescript
const RecallParams = Type.Object({
  query: Type.String({ description: "搜索关键词或自然语言查询" }),
  scope: Type.Optional(StringEnum(['all', 'current_session', 'segment'])),
  segmentId: Type.Optional(Type.String({ description: "指定段ID精确检索" })),
  maxResults: Type.Optional(Type.Number({ description: "最大返回结果数，默认 5" })),
});
```

**执行逻辑**:

```typescript
async function executeRecall(params, sessionState, ctx) {
  const { query, scope, segmentId, maxResults = 5 } = params;

  let results: SearchResult[];

  if (segmentId) {
    // 精确检索: 返回指定段的完整 L1 压缩摘要 + 原始数据引用
    const segment = await coldStore.getSegment(ctx.sessionId, segmentId);
    if (!segment) return { content: [{ type: 'text', text: `段 ${segmentId} 未找到` }] };
    return formatSegmentResult(segment);
  }

  // 关键词搜索
  const searchScope = scope === 'current_session' ? { sessionId: ctx.sessionId } : {};
  results = await coldStore.searchIndex(query, searchScope);
  const topResults = results.slice(0, maxResults);

  if (topResults.length === 0) {
    return {
      content: [{ type: 'text', text: `未找到与 "${query}" 相关的内容。` }],
      details: { results: [], query },
    };
  }

  return {
    content: [{
      type: 'text',
      text: formatSearchResults(topResults),
    }],
    details: { results: topResults, query },
  };
}

function formatSearchResults(results: SearchResult[]): string {
  return results.map((r, i) =>
    `[${i + 1}] 段: ${r.segmentId} (${r.segmentType})\n` +
    `    目标: ${r.objective}\n` +
    `    轮次: ${r.turnRange.start}-${r.turnRange.end}\n` +
    `    匹配: ${r.matchedText}\n` +
    `    相关工具调用:\n${r.l1Compressed.slice(0, 5).map(t => `      - [轮${t.turnIndex}] ${t.compressed}`).join('\n')}`
  ).join('\n\n');
}
```

**Steering prompt 引导**:

在 `before_agent_start` 注入的 steering 中加上：

```
注意: 之前的对话历史可能已被压缩。当你发现当前上下文缺少关键信息时，
使用 recall 工具检索历史内容:
  recall({ query: "sanitize 函数" })   // 搜索相关历史
  recall({ segmentId: "seg_003" })    // 查看特定段的摘要
```

---

#### P1.5 /context-status 命令

**目标**: 用户可查看当前上下文使用情况和内存/预算。

**实现**:

```typescript
pi.registerCommand("context-status", {
  description: "查看上下文使用状态和记忆体概况",
  handler: async (args, ctx) => {
    const usage = ctx.getContextUsage();
    const sessionState = getSessionState();

    const lines = [
      `━━━ 上下文状态 ━━━`,
      ``,
      `上下文使用: ${usage?.tokens ?? '?'} / ${usage?.contextWindow ?? '?'} tokens`,
      usage?.contextWindow ? `  使用率: ${((usage.tokens / usage.contextWindow) * 100).toFixed(1)}%` : null,
      ``,
      `━━━ 记忆体概况 ━━━`,
      `活动段: ${sessionState.currentSegment?.segmentId ?? '无'}`,
      `已归档段: ${sessionState.segmentIndex.segments.length}`,
      `L1 压缩记录: ${sessionState.segmentIndex.segments.reduce((s, seg) => s + seg.l1Compressed.length, 0)}`,
      `锚节点数: ${sessionState.anchors?.length ?? 0}`,
      ``,
      `━━━ 存储 ━━━`,
      `冷数据路径: .pi/infinite-context/cold/`,
      `段索引: .pi/infinite-context/segments/`,
    ].filter(Boolean);

    ctx.ui.notify(lines.join('\n'), 'info');
  },
});
```

---

#### P1.6 上下文用量监控 + Steering 注入

**目标**: 在 `before_agent_start` 时：
1. 注入锚节点摘要（如果有）
2. 注入当前段摘要（如果有）
3. 检查上下文用量，超过阈值时警告

**实现**:

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
  const usage = ctx.getContextUsage();
  const sessionState = getSessionState();

  const parts: string[] = [];

  // 1. 锚节点摘要 (Phase 2 再实现存储，Phase 1 用硬编码占位)
  if (sessionState.anchors && sessionState.anchors.length > 0) {
    parts.push(formatAnchorInjection(sessionState.anchors));
  }

  // 2. 最近完成的段摘要
  const recentCompleted = sessionState.segmentIndex.segments
    .filter(s => s.archived)
    .slice(-3);
  if (recentCompleted.length > 0) {
    parts.push(formatRecentSegments(recentCompleted));
  }

  // 3. Recall 使用提醒
  parts.push(
    `💡 历史内容已被压缩。如需查看之前的工作，使用 recall({ query: "关键词" }) 检索。`
  );

  // 4. 上下文用量警告
  if (usage && usage.contextWindow > 0) {
    const ratio = usage.tokens / usage.contextWindow;
    if (ratio > 0.8) {
      parts.push(`⚠️ 上下文已使用 ${(ratio * 100).toFixed(0)}%。建议执行 /compact 压缩。`);
    }
  }

  if (parts.length === 0) return;

  return {
    message: {
      customType: "infinite-context-steering",
      content: parts.join('\n\n'),
      display: false,
    },
  };
});
```

---

## 2. Phase 1 各步骤的执行顺序与依赖

```
P1.1 段索引观察器
  │  依赖: 无
  │  产出: SegmentMeta[] 存储在 session entry 中
  │
  ├──→ P1.2 L1 规则压缩
  │      依赖: P1.1 (段索引中有原始工具调用记录)
  │      产出: CompressedTurn[] 追加到段索引
  │
  ├──→ P1.3 冷数据持久化
  │      依赖: P1.1 + P1.2 (段完成时归档)
  │      产出: .pi/infinite-context/ 目录树
  │
  ├──→ P1.4 recall 工具
  │      依赖: P1.3 (搜索冷数据索引)
  │      产出: 可注册的 Tool
  │
  ├──→ P1.5 /context-status 命令
  │      依赖: P1.1 (读取段索引统计)
  │      产出: 可注册的 Command
  │
  └──→ P1.6 上下文用量监控 + Steering
         依赖: P1.1 (段摘要), 可独立实现
         产出: before_agent_start handler
```

---

## 3. Phase 1 不做什么

| 不做 | 原因 | 何时做 |
|------|------|:---:|
| **真正从 LLM 上下文中移除消息** | 缺少 Pi API | Phase 2 |
| **锚节点持久化存储和规则引擎** | 需要先验证核心循环 | Phase 2 |
| **L2 LLM 摘要生成** | 需要 subagent 异步协调 + Pi compact 配合 | Phase 2 |
| **温数据向量检索** | 工程量大，先用关键词 grep | Phase 3 |
| **遗忘机制(衰减/冲突/淘汰)** | 温数据层未建立前不需要 | Phase 3 |
| **跨 session 记忆迁移** | 需要锚节点和温数据先稳定 | Phase 3 |
| **树结构组织** | 扁平方案先跑通再升级 | Phase 3 |
| **与 Pi compact 集成** | 需要 Pi 核心 API | Phase 2 |

---

## 4. Phase 2 的前置条件（需要 Pi 核心改动）

Phase 2 的核心能力——锚节点自动注入、L2 摘要替换、真正的上下文缩减——依赖以下 Pi API：

```typescript
// 1. 上下文组装钩子 (P0)
// 允许扩展在 Pi 将 messages 发送给 LLM 之前修改 messages 数组
pi.on('before:context:assemble', (messages: Message[], metadata: ContextMetadata) => {
  // 扩展可以:
  // - 在 messages 开头插入锚节点
  // - 将旧的工具输出替换为 L1 压缩引用
  // - 将 L2 摘要插入到对应位置
  return modifiedMessages;
});

// 2. Token 预算精确查询 (P0)
pi.getTokenBudget(): {
  contextWindow: number;  // 模型上下文窗口总 token 数
  systemPromptTokens: number; // 系统提示词占用
  toolDeclarationTokens: number; // 工具声明占用
  messagesTokens: number;  // 对话消息占用
  available: number;       // 剩余可用
}

// 3. 段边界通知 (P1)
// Pi 在检测到任务切换/新 target 时通知扩展
pi.on('segment:boundary', (boundary: {
  type: 'new_task' | 'goal_created' | 'user_long_message' | 'turn_count_exceeded';
  metadata: Record<string, unknown>;
}) => {
  // 扩展可以据此结束当前段、开始新段
});
```

Pi 维护者需要评估这些 API 的可行性。如果 Phase 2 的 API 无法获得，无限上下文扩展的价值将局限在"冷数据归档 + recall 检索"——仍然有用，但无法实现自动化上下文管理。

---

## 5. 工作量估算

| 步骤 | 文件 | 预估工时 | 复杂度 |
|------|------|:---:|:---:|
| P1.1 段索引观察器 | `observers/segment-builder.ts` (~300L) | 2 天 | 中 |
| P1.2 L1 规则压缩 | `compression/l1-compressor.ts` (~200L) | 1 天 | 低 |
| P1.3 冷数据持久化 | `storage/cold-store.ts` (~250L) | 1.5 天 | 中 |
| P1.4 recall 工具 | `tools/recall.ts` (~200L) | 1 天 | 中 |
| P1.5 /context-status | `tools/memory-status.ts` (~100L) | 0.5 天 | 低 |
| P1.6 Steering 注入 | `steering/anchor-injector.ts` (~150L) | 1 天 | 低 |
| 入口 + 胶水代码 | `index.ts` + `state.ts` (~200L) | 1 天 | 低 |
| 测试 + 调试 | — | 2 天 | 中 |
| **总计** | ~1400L | **10 天** | — |
