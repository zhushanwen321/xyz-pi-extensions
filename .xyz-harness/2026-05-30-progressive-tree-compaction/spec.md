---
verdict: pass
---

# Progressive Tree Compaction — 渐进式树压缩引擎

## Background

Infinite Context 扩展的 Tree Compactor 当前存在三个问题：

1. **压缩比不可控** — 一次性把所有非保留段发给 LLM，输出高度不确定（曾出现 67K tokens → 119 tokens 的极端压缩）
2. **无分层意识** — 每次压缩全量重写旧树，旧 group 摘要被抛弃，信息不积累
3. **保留窗口固定** — `maxSegments=2` 写死，无论上下文占用高低都保留 2 段，空间利用率低

目标是将 Tree Compactor 改造为**渐进式压缩引擎**：每次只压缩最老的一批段，按目标压缩比（20-50%）动态计算压缩范围，产出追加到现有树上，树深度不增长。

## Functional Requirements

### FR-1: 动态保留窗口

根据当前上下文占用比例，动态决定保留最近多少段不压缩。

| 上下文占用 | 保留段数 | 说明 |
|-----------|---------|------|
| < 50% | 所有段 | 不够宽松，不压缩 |
| 50-70% | 保留 8 段 | 轻度压缩 |
| 70-80% | 保留 4 段 | 常规压缩 |
| 80-90% | 保留 2 段 | 积极压缩 |
| > 90% | 保留 1 段 | 紧急压缩 |

- 上下文占用来自 `ctx.getContextUsage()` 的 `percent` 字段
- 保留窗口包含 **当前活跃段**（未完成的段） + 最近 N 个**已完成段**
- 段计数优先于 turn 计数（一个段可能覆盖 1-20 个 turn）

### FR-2: 动态压缩范围

从最旧的非保留段开始，按顺序逐个累加，直到预估压缩后总大小占当前上下文总大小的比例落在 20-50% 区间。

**预估公式（保守）：**

```
单段 leaf 摘要贡献: ~200 chars = 50 tokens（受提示词 150-400 chars 约束）
group 开销: ~100 chars / 4 段 = 25 tokens/段（每 4 段一个 group）
每段合计: ~63 tokens

旧树大小 = tree.totalTokens（chars/4 启发式，由 recomputeTreeTokens 计算）
保留段 digest 大小 = sum(len(seg.userMessage + assistant texts)) / 4

预估压缩输出 = 段数量 × 63 + 树根开销(10 tokens)
```

**比例判定：**

```
预估总大小 = 旧树大小(tokenCount) + 预估压缩输出 + 保留段 digest 大小 + 系统提示词
分母 = 当前上下文总大小（包含所有原始段 digest、旧树、保留段）
比例 = 预估总大小 / 分母

当比例落在 20-50%：停止累加，提交这批段给 LLM
当比例 < 20%：继续加段
当比例 > 50%：减一段，提交
```

- 预估只是近似值，LLM 实际输出可能偏离。偏离的后果是下次压缩触发时再调整
- 分母不使用原始 entry 的 tokens（seg_N.json 完整内容），而是使用**上下文中的摘要信息**的 tokens
- 当所有非保留段都累加完了比例仍 < 20%：提交所有段，接受小于 20%

### FR-3: 追加式树结构（无分层加深）

每次压缩产出的 LLM 结果为若干个 `group` 节点（每个包含 `nodeId`、`summary`、`children: [leaf_1, leaf_2, ...]`）。

- 旧树中已有的 group **原封不动保留**
- 新产出的 group **追加**到旧树的 `root.children` 末尾
- 树深度永远为 2（root → group → leaf）
- 不创建更高层的 supergroup，不重新分组旧树
- 树的宽度（group 数量）随时间增长，但每次压缩只增加 1-3 个新 group

**树结构示例（第 5 次压缩后）：**

```
root
├── group_A (seg_0 ~ seg_3)
├── group_B (seg_4 ~ seg_6)
├── group_C (seg_7 ~ seg_9)
├── group_D (seg_10 ~ seg_12)
└── group_E (seg_13 ~ seg_14)  ← 最新压缩追加
```

### FR-4: 上下文注入策略

整棵树的**所有节点摘要**都注入到上下文中（包括 leaf 摘要）。

- 每个 group 节点的摘要：~100 chars = ~25 tokens
- 每个 leaf 节点的摘要：~200 chars = ~50 tokens
- N 个 group + M 个 leaf 的总体积很小（5 个 group + 15 个 leaf ≈ 4250 chars ≈ 1063 tokens）
- 不排除 leaf 摘要（它们体积小，且让 LLM 看到所有 nodeId 可以一步完成 recall）
- 原始 entry 内容（seg_N.json 完整对话）不注入，通过 recall 按需访问

### FR-5: LLM 提示词

压缩 LLM 的提示词结构：

1. **工具调用双重防护** — 首尾禁止工具调用（已实现）
2. **交接文档视角** — "Context Checkpoint for another AI"（已实现）
3. **100-300 chars leaf 摘要，150-400 chars group 摘要**（已实现）
4. **分析→摘要两阶段输出**（已实现）
5. **输入结构**：所有压缩段的 digest（userMessage + assistant text + tool names）（已有）+ 旧树当前 group 列表（新增）

新增：提示词末尾添加旧树 group 列表：
```
Existing groups in the tree:
  group_A: <summary>(already compressed, do not modify)
  group_B: <summary>(already compressed, do not modify)
  
Append your new groups after the existing ones. Do NOT rewrite old groups.
```

### FR-6: 压缩触发时机

压缩触发流程：

```
turn_end 事件
    │
    ▼
计算上下文占用比例
    │
    ├── < 50% → 不触发
    │
    ├── ≥ 50% → 检查 needsCompressionRef.value
    │
    ├── 已有树? 且 isCompressing? → 跳过
    │
    └── 触发 FR-1 → FR-2 → FR-3 → 执行压缩
```

- 不主动等上下文膨胀到 70% 再触发（FR-1 的自己梯段已处理）
- 如果上次压缩后上下文仍在增长，`needsCompressionRef` 会在 context 事件中被置为 true

### FR-7: 压缩失败处理

- LLM 超时或退出码非零 → 重试 1 次（已有逻辑）
- 校验失败（JSON 解析错误、nodeId 重复、summary 长度不足）→ 重试 1 次（已有逻辑）
- 重试也失败 → ruleBasedFallback（已有逻辑，已增强 fallback 摘要质量）
- 如果 Pi 原生 compact 存在（`session_before_compact`），只在我们的树存在时才取消它（已修复）

## Acceptance Criteria

### AC-1: 保留窗口动态化
- 给定上下文占用 50-70%，保留 8 段
- 给定上下文占用 80-90%，保留 2 段
- 给定上下文占用 > 90%，保留 1 段
- 当前活跃段（未完成）始终在保留窗口中

### AC-2: 压缩范围动态化  
- 预估比例 < 20% 时，段继续累加
- 预估比例落到 20-50% 时，停止并提交
- 非保留段全部累加完仍未达标时，提交所有

### AC-3: 树只追加不重写
- 第 N 次压缩后，`root.children` 包含前 N-1 次产出的所有 group
- 旧 group 的 summary 未被修改
- 树深度保持 2

### AC-4: 上下文注入包含全部节点
- 注入后的 messages 中包含 recall 提示 + 所有 group 摘要 + 所有 leaf 摘要 + 保留段原文
- leaf 摘要数量 == 已压缩的段数量
- 不包含原始 seg_N.json 内容

### AC-5: 压缩比稳定
- 连续 3 次触发压缩，每次预估比例和实际比例的偏差不超过 ±20 个百分点
- 无单次压缩输出 < 200 tokens 的情况

### AC-6: 低占用不压缩
- 上下文占用 < 50% 时压缩不触发
- `needsCompressionRef.value` 在 context 事件中正确置位/复位

## Constraints

### C-1: 保持异步 fire-and-forget
- TreeCompactor.triggerCompression() 不阻塞主对话
- 压缩结果通过 onComplete 回调通知

### C-2: 30 秒超时
- LLM 压缩请求 30 秒超时（现有，不变）

### C-3: 向后兼容
- 旧版本的 entry 数据（tokenCount=0 的旧树）不会导致崩溃
- deserializeState 中的旧格式（缺少字段）容错

### C-4: 单段预估允许误差
- 预估算法不要求精确，使用保守的固定值（63 tokens/段）
- 实际输出偏差在后续压缩中自动修正

## 业务用例

> 纯技术性需求，无业务用例。

## Complexity Assessment

**Scope:** Single extension module (`infinite-context`), 4 source files modified:
- `tree-compactor.ts` — 新增动态保留窗口算法、动态压缩范围算法、旧树 group 列表传递
- `context-handler.ts` — 新增 removePriorEntryIds 过滤已压缩段的原文（不再传给 LLM）
- `types.ts` — 可能新增配置常量
- `segment-tracker.ts` — 新增 getTokenCounts() 方法暴露段 digest 大小估算

**Risk:** Medium. 压缩触发流程变动较大，但 fallback 机制完善。
**Test:** 通过真实 session 数据验证压缩比。
