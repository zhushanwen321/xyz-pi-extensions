# 02 — 信号源分析

> 盘点 pi 生态系统中可提取的各类信号，以及每种信号的提取方法、信号质量和可操作性。

---

## 1. 数据资产概览

### 1.1 Session JSONL 文件

| 属性 | 数值 |
|---|---|
| 文件数量 | 667 个 |
| 总大小 | 683 MB |
| 位置 | `~/.pi/agent/sessions/` |
| 格式 | 每行一条 JSON 记录（JSONL） |
| 涉及项目 | 约 30+ 个项目/分支 |
| 时间跨度 | 约 2026-04 至今（~2 个月） |

**事件类型统计（单个典型 session）**：

| 事件类型 | 占比 | 可提取的信号 |
|---|---|---|
| `message` | ~95% | 用户输入、AI 输出、tool call、token usage |
| `model_change` | ~2% | 模型选择模式 |
| `session_info` | ~1% | 会话名称 |
| `thinking_level_change` | ~1% | 推理深度偏好 |
| `session` | ~0.5% | cwd、时间戳 |

### 1.2 持久化统计文件

| 文件 | 路径 | 内容 |
|---|---|---|
| usage-stats.json | `~/.pi/agent/usage-stats.json` | Skill 加载次数、Agent 调用次数 |
| skill-memory-keeper records | `skill-memory-keeper/memory/{user\|project}/` | Skill 使用的问题记录和改进建议 |
| session JSONL 中的 CustomEntry | 各 extension 通过 `appendEntry()` 写入 | Goal 状态、Todo 状态等 |

### 1.3 Extension API 事件（实时可监听）

Pi Extension API 提供了完整的事件体系，可用于**实时信号采集**（无需事后分析 JSONL）：

```
agent_start → before_agent_start → agent_end
tool_call → tool_execution_start → tool_execution_end
session_start → session_shutdown
message_end（含完整 usage）
```

---

## 2. 可提取的七类信号

### Signal 1: 工具使用模式

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| 各类工具调用频次 | 计数 tool_call 的 toolName | session JSONL + 实时事件 | "read 占工具调用 40%，其中 15% 是重复读取同一文件" |
| 同一文件重复读取 | 按 path 去重同一 session 内 read 调用 | session JSONL | "某 session 中 read src/app.ts 6 次" |
| edit 重试率 | edit tool_call 后紧跟 read 同一文件的模式 | session JSONL | "edit 后 30% 概率 read 确认，说明对 edit 精度缺乏信心" |
| bash 命令类型分布 | 分类 bash 命令（git/ls/npm/test/...） | session JSONL | "git 命令占 25%，可考虑创建专用 git skill" |

**代码实现要点**：

```typescript
// session 中提取工具调用序列
function extractToolSequence(entries: Entry[]): ToolCall[] {
  return entries
    .filter(e => e.type === "message" && e.message.role === "assistant")
    .flatMap(e => e.message.content)
    .filter(c => c.type === "toolCall")
    .map(c => ({
      tool: c.name,
      args: JSON.parse(c.arguments),
      timestamp: e.timestamp,
    }));
}
```

### Signal 2: Token 消耗热点

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| 每轮对话 token 消耗 | 提取 message.usage.input/output | session JSONL | "处理 Vue 文件的轮次 token 消耗是纯 TypeScript 的 2.3 倍" |
| Skill 加载成本 | 关联 tool_call(read) + SKILL.md 文件大小 | session JSONL + 文件系统 | "chrome-automation skill 的 SKILL.md 12KB，但仅被触发 3 次" |
| 单轮对话 token 飙升 | 检测 outputTokens 异常增长 | session JSONL | "特定类型任务导致 token 爆炸" |
| 无效 token 消耗 | 检测 read 后未被引用的文件 | session JSONL | "读取的文件 25% 后续未被任何操作使用" |

### Signal 3: 错误与重试模式

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| bash 命令失败 | bash 输出中包含 error 关键词 | session JSONL | "npm install 类命令失败率 18%，多因网络问题" |
| edit 匹配失败 | edit tool_call 返回 "Could not find the exact text" | session JSONL | "whitespace-fixer skill 未被有效触发" |
| agent 自我纠正 | assistant 连续两轮 toolCall 的模式 | session JSONL | "读文件 → 发现不对 → 重新搜索 → 再次读取"的序列占比" |
| 工具参数错误 | tool_call 参数格式问题 | session JSONL | "subagent 的 agent 参数使用了不存在的 agent 名" |

### Signal 4: 用户重复指令

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| 跨 session 重复要求 | 对用户消息做相似度聚类 | session JSONL（user role） | "用户在不同 session 中 8 次要求'不要用 emoji'" |
| 否定式反馈 | 用户消息含"不对/不要/别/取消"等 | session JSONL | "聚类后识别高频否定模式" |
| 补充式指令 | 用户在同一个 turn 内追加消息 | session JSONL | "'还要加...'、'忘了说...' 的频次" |

**关键价值**：如果用户在不同 session 中多次提出同一要求，说明 CLAUDE.md 中对应的规则没有被有效执行（需强化措辞或提升优先级），或者规则缺失（需新增）。

### Signal 5: Skill 效果评估

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| Skill 触发频次 | usage-stats.json + session 中 read(SKILL.md) 事件 | usage-stats + session JSONL | 排名前 10 和后 10 的 skill |
| Skill 触发后任务完成率 | 触发 skill 的 session 中，后续消息是否有"完成/成功/fixed"等 | session JSONL | "触发 whitespace-fixer 后 edit 成功率从 72% 升至 95%" |
| Skill 未被触发但本该触发 | 检测操作序列匹配 skill 描述但未 read SKILL.md | session JSONL | "用户用了 vue 文件但没有触发 ts-taste-check" |
| Skill 描述与实际使用匹配度 | 对比 skill 的 description 和实际触发场景 | usage-stats + session JSONL | 某 skill 的 description 过于宽泛导致误触发 |

### Signal 6: 跨项目通用模式

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| 跨项目的重复操作序列 | 按 cwd 分组，检测相同的工具调用序列 | session JSONL（跨 session） | "在 5 个项目中都出现 '创建目录→初始化 tsconfig→安装依赖' 的三步" |
| 项目类型自动识别 | 按 cwd 的 package.json 检测项目类型 | session JSONL + 文件系统 | "Vue 项目 vs React 项目 vs 纯 TS 项目的操作差异" |
| Agent 选择的模式 | 按项目类型统计 agent 调用偏好 | usage-stats.json | "前端项目更频繁使用 subagent 做代码审查" |

### Signal 7: 用户满意度隐式信号

| 子信号 | 提取方法 | 数据源 | 示例洞察 |
|---|---|---|---|
| 单 round 完成率 | 用户任务是否在 1 个 turn 内完成（无后续追问） | session JSONL | "数据库迁移类任务 1-round 完成率仅 30%" |
| 用户追问/补充频次 | 同一任务跨多轮用户消息 | session JSONL | "部署类任务平均需要 4.3 轮用户补充" |
| session 异常终止 | session 在非正常状态结束 | session JSONL | "用户可能在结果不满意时直接关闭 session" |

---

## 3. 信号提取的技术路径

### 3.1 实时信号（增强 usage-tracker extension）

在现有 usage-tracker 的 `tool_call` 和 `tool_execution_start` 监听基础上，增加：

```
监听事件                → 采集信号
─────────────────────────────────────────
tool_execution_end      → 工具执行成功/失败、耗时、错误信息
message_end             → 本轮 token usage（已有）、turn 编号
session_start           → cwd、项目识别、session 标识
before_agent_start      → 加载了哪些 skill、系统提示词变化
```

### 3.2 批量信号（session 分析脚本）

```bash
# 独立脚本，可手动或定时触发
pi-session-analyzer \
  --since 2026-05-20 \
  --until 2026-05-27 \
  --project "chat_project" \
  --output-json analysis.json \
  --output-md report.md
```

**分析流程**：

1. 扫描 `~/.pi/agent/sessions/` 目录，按 `--project` 过滤
2. 读取每个 JSONL 文件，解析为结构化 Entry 数组
3. 按信号类别执行分析规则
4. 汇总统计 → 输出 JSON 结构化数据 + Markdown 可读报告

### 3.3 信号持久化格式

```
~/.pi/agent/evolution-data/
├── daily/
│   └── 2026-05-27.json        # 每日汇总（实时采集）
├── tool-stats.json             # 工具使用统计（实时累积）
├── skill-health.json           # Skill 健康度（批量分析产出）
├── patterns.json               # 发现的跨 session 模式（批量分析产出）
└── reports/
    └── 2026-05-27-weekly.md    # 周报（批量分析产出）
```

---

## 4. 信号质量评估矩阵

| 信号 | 数据可靠性 | 提取难度 | 可操作性 | 优先级 |
|---|---|---|---|---|
| 工具使用频次 | 高（直接计数） | 低 | 高（可直接指导 skill 优化） | P0 |
| Token 消耗热点 | 高（usage 字段精确） | 低 | 高（可直接指导提示词精简） | P0 |
| bash 命令失败 | 中（需语义分析错误消息） | 中 | 高（可生成防御规则） | P1 |
| 用户重复指令 | 中（跨 session 关联有噪声） | 高（需 NLP 相似度匹配） | 极高（直接输入 CLAUDE.md） | P1 |
| edit 重试模式 | 高（模式识别精确） | 低 | 高（可优化 skill 触发条件） | P1 |
| skill 效果评估 | 中（归因困难） | 中 | 中（可指导 skill 增删） | P2 |
| 跨项目通用模式 | 低（混杂大量噪音） | 高（需多 session 序列对齐） | 中 | P2 |
| 用户满意度 | 极低（隐式信号推断误差大） | 高 | 低（不敏感维度） | P3 |
