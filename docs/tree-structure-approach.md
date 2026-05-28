# 树结构上下文组织方案

> 将上下文建立成树结构，锚点是树的根节点。每个锚点下有多层节点，仅叶子节点存储原始信息。
> 系统提供工具阅读叶子节点原始信息。

---

## 一、方案描述

### 1.1 核心思路

上下文不再是一个扁平的 token 序列，而是一棵有层次的树：

```
锚点（根节点）
├── 子节点 A（摘要层）
│   ├── 孙节点 A1（摘要层）
│   │   └── 叶子 A1a（原始信息）
│   └── 孙节点 A2（摘要层）
│       └── 叶子 A2a（原始信息）
├── 子节点 B（摘要层）
│   └── 叶子 B1（原始信息）
└── ...
```

- **非叶子节点**：仅存储摘要信息（做了什么、调用了哪些工具、关键结果、总结性结论）
- **叶子节点**：存储原始信息（完整对话轮次、工具输出、文件内容）
- **上下文组装**：遍历所有非叶子节点的摘要，组成压缩后的上下文
- **按需深入**：提供 tool 让 LLM 展开叶子节点阅读原始信息

### 1.2 锚点的重新定位

在此方案中，锚点不再是独立的事实/约束，而是任务树的根节点：

```
树结构锚点:
  "修复登录 bug" → 任务过程树
  "升级 PG 到 15" → 任务过程树
  "讨论架构方案" → 对话过程树
```

对比扁平方案锚点：
```
扁平锚点:
  "数据库是 PG15" → 事实
  "不能改 auth.ts 接口" → 约束
  "回答用中文" → 偏好
```

### 1.3 节点模型

```typescript
interface ContextNode {
  id: string;
  parent_id: string | null;      // null = 锚点(根节点)
  
  // 内容
  type: 'task' | 'phase' | 'tool_call' | 'turn' | 'leaf';
  summary: string;               // 非叶子节点: 该节点下所有内容的摘要
  raw_content?: string;          // 仅叶子节点: 原始内容
  
  // 元数据
  tool_name?: string;            // tool_call 类型时
  file_path?: string;            // 涉及的文件
  turn_range?: [number, number]; // 覆盖的对话轮次范围
  
  // 统计
  children_count: number;
  depth: number;
  token_estimate: number;        // 摘要的 token 估算
  importance: number;            // 0-1, 用于上下文裁剪
  created_at: number;
}
```

### 1.4 上下文组装算法

```
function buildContext(rootAnchors: ContextNode[]): string {
  const context: string[] = [];
  
  for (const anchor of rootAnchors) {
    // 遍历锚点下所有非叶子节点
    context.push(traverseNonLeaf(anchor));
  }
  
  return context.join('\n\n');
}

function traverseNonLeaf(node: ContextNode): string {
  let result = '';
  
  // 锚点的第一层: 展示子节点摘要列表
  if (node.parent_id === null) {
    result += `## 任务: ${node.summary}\n\n`;
    for (const child of node.children()) {
      if (!child.isLeaf()) {
        result += formatSummary(child, 1);
      }
    }
  }
  
  return result;
}

function formatSummary(node: ContextNode, depth: number): string {
  const indent = '  '.repeat(depth);
  let result = `${indent}- ${node.summary}`;
  
  // 展开直接子节点（非叶子）的摘要
  for (const child of node.children()) {
    if (!child.isLeaf()) {
      result += '\n' + formatSummary(child, depth + 1);
    }
  }
  
  return result;
}
```

### 1.5 Drill-down 工具

```typescript
// 暴露给 LLM 的工具
const expandNodeTool = {
  name: "memory_expand",
  description: "展开树节点，获取其子节点的详细摘要或叶子节点的原始信息",
  parameters: {
    node_id: "string",        // 节点 ID
    depth: "number",          // 展开深度，默认 1
    include_leaves: "boolean", // 是否包含叶子节点原始信息
  },
};

// 示例使用:
// memory_expand({ node_id: "task_login_fix", depth: 1 })
//   → 返回该任务下所有直接子节点的摘要
//
// memory_expand({ node_id: "leaf_auth_ts_read", include_leaves: true })
//   → 返回读取 auth.ts 的完整内容
```

---

## 二、优势

### 2.1 层次化组织天然匹配任务分解

Goal 模式下，用户设定目标 → 拆解为子任务 → 每个子任务是一段对话 → 每段对话有工具调用 → 每个工具有输入输出。这个嵌套结构天然是树状的。

### 2.2 上下文大小与任务数量相关，与对话长度无关

一个任务无论执行了 50 轮还是 500 轮，最终只产生一个摘要节点（锚点）和若干子节点。真正爆炸的叶子节点不进入上下文。

### 2.3 导航式检索优于全文搜索

`memory_expand(node_id)` 的精确度是 100%——LLM 知道自己在看什么节点的内容。对比 `recall("sanitize 函数")` 的全文搜索，后者可能返回无关内容或遗漏相关内容。

### 2.4 天然支持跨锚点的层次关系

```
锚点: 重构 auth 模块
├── 锚点引用: 修复登录 bug (子任务的一部分)
├── 锚点引用: 升级 PG 到 15 (auth 模块依赖 PG)
└── 阶段1: 设计新接口
```

树结构允许锚点之间相互引用，描述任务依赖关系。

---

## 三、致命问题

### 3.1 热层缺失（最严重）

**LLM 看不到原始对话。** 它看到的是摘要树。以下问题无法解决：

- 无法理解当前对话的细微意图和语气
- 不知道上一轮用户具体说了什么
- 如果摘要丢失了关键信息，LLM 不会主动发现并 drill down——它不知道自己缺了什么
- 每做一件事都要先 `memory_expand` 检查上下文，增加 1-2 次 tool call 延迟

**所有现有 agent（Claude Code、Aider、Codex CLI、Qwen Code）都保留了最近 N 轮原文。这不是偶然，是工程验证的结论。**

### 3.2 树的构建者是谁？

- 谁来划分"阶段"？谁来定义节点粒度？
- 如果每轮对话创建一个节点 → 树太深
- 如果按任务阶段分组 → 需要判断"阶段边界"，这个判断本身需要 LLM 推理
- 如果固定窗口分组 → 跟扁平压缩没有本质区别

### 3.3 上下文大小不可控

随着 session 进行，锚点下的非叶子节点数量会无限增长。深度 3 层、每层 10 个节点、每个节点 150 tokens → 4500 tokens 仅摘要。如果 session 很长，可能积累几百个非叶子节点，上下文反而比扁平方案更大。

### 3.4 跨锚点交叉引用模糊

"修复 auth bug"改了 token.ts，"升级依赖"也改了 token.ts。这个文件属于哪个锚点？两个锚点都要引用？如果引用链接，LLM 能否正确理解不完整的信息？

### 3.5 与 Pi 现有 compact 的根本矛盾

Pi 的 compact 会把整个历史替换为一篇摘要。树方案的节点式摘要与 Pi 的"一块摘要"模式不兼容，需要 Pi 核心改动才能支持"结构化摘要块"的概念。

---

## 四、与扁平方案的对比

| 维度 | 扁平方案 | 树方案 |
|------|---------|--------|
| **锚点定义** | 原子事实/约束 ("DB是PG15") | 任务根节点 ("修复登录bug") |
| **上下文组成** | 锚点事实 + 温数据片段 + 最近K轮原文 | 遍历所有非叶子节点的摘要 |
| **热层** | 有(最近K轮原文) | 无(只有摘要) |
| **信息检索** | recall全文搜索 | memory_expand树导航 |
| **上下文可控性** | 可控(固定K + 固定top-N片段) | 不可控(树随session增长) |
| **构建复杂度** | 中 | 高 |
| **匹配 goal 模式** | 一般 | 天然匹配 |
| **需要 Pi 改动** | 少量(1-2个hook) | 大量(消息结构变更) |

---

## 五、建议的混合路径

**树的优势是摘要组织方式，不是上下文入口方式。**

```
最终上下文组装 = 热层原文 + 扁平锚点事实 + 树组织摘要 + drill-down工具
```

- **热层原文**：LLM 知道当前发生了什么（树方案缺失的）
- **扁平锚点事实**：LLM 记住不可变约束（树方案缺失的）
- **树组织摘要**：LLM 可以高效导航历史（树方案的优势）
- **drill-down 工具**：LLM 可以深入任何节点的原始信息（树方案的优势）

树方案在 Phase 3 引入——当温数据片段积累到一定量、扁平 recall 的噪音开始显著时，用树结构重新组织已有的温数据，提供更好的导航体验。

---

## 六、树结构的 Pi 实现路径

### 6.1 节点存储

```
~/.pi/memory/context-tree/
├── session_001/
│   ├── tree.json          # 整棵树的 JSON 结构
│   ├── nodes/
│   │   ├── n001.json      # 锚点: "修复登录bug"
│   │   ├── n002.json      # 阶段1: "定位问题"
│   │   ├── n003.json      # 阶段2: "实施修复"
│   │   ├── n004.json      # 叶子: read auth.ts
│   │   └── ...
│   └── index.json         # 节点ID → 文件映射
└── ...
```

### 6.2 构建时机

- **新任务开始时**：创建锚点节点
- **段边界检测到时**：创建阶段子节点
- **工具调用时**：创建叶子节点（仅索引，不存原始内容——原始内容已在冷层）
- **段压缩触发时**：对该段下的子节点生成摘要，更新父节点
- **任务完成时**：对锚点下所有子节点合并为最终摘要

### 6.3 需要 Pi 核心支持的功能

- **多块摘要支持**：Pi compact 需要支持"结构化摘要块列表"而非"单篇摘要文本"
- **上下文分层渲染**：infinite-context 扩展生成的上下文需要被 Pi 识别为"可展开/可折叠"的结构，而非线性文本
- **节点导航 UI**：TUI/GUI 需要展示可交互的树结构

---

## 七、实施优先级

| 优先级 | 内容 | 理由 |
|:---:|------|------|
| **P0** | 扁平方案：热层 + L1压缩 + 冷层 + recall | 验证上下文管理核心循环 |
| **P1** | 扁平锚点事实层 | 保证关键信息不丢失 |
| **P2** | 温数据片段存储 + 主动探针 | 提供跨 session 记忆 |
| **P3** | 树结构组织温数据 | 在温数据积累到一定量后引入 |
| **不再做** | 纯树方案(无热层) | 已被工程实践证明不可行 |

**树方案在 Phase 3 作为温数据的组织升级引入，而不是替代热层和锚点事实层。**
