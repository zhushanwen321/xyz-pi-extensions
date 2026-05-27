# 04 — 分期规划

> 五期路线图，从数据采集到闭环自动化的渐进式实施路径。
> 每期之间渐进叠加，但每期都有独立交付价值和退出点。

---

## 总体路线图

```
Phase 1 (1-2 wks)          Phase 2 (2-3 wks)         Phase 3 (1-2 wks)
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ 信号采集增强       │      │ Session 分析脚本  │      │ LLM Judge 集成    │
│                   │ ───► │                   │ ───► │                   │
│ 增强 usage-tracker│      │ Python 分析脚本   │      │ LLM 驱动的质量评判 │
│ 实时事件采集       │      │ 初次回顾性分析     │      │ 结构化建议生成     │
└──────────────────┘      └──────────────────┘      └──────────────────┘
         │                         │                         │
         ▼                         ▼                         ▼
  独立交付物：               独立交付物：               独立交付物：
  evolution-data/           分析报告 + 洞察           进化建议报告
  目录 + 实时采集            → 可指导手动优化          → 可人工审批

         │                         │                         │
         └─────────────────────────┴─────────────────────────┘
                                   │
                                   ▼
         Phase 4 (2-3 wks)                      Phase 5 (ongoing)
        ┌──────────────────────────┐      ┌──────────────────────────┐
        │ Evolution Engine 闭环     │      │ 高级特性                    │
        │                          │ ───► │                           │
        │ /evolve 命令             │      │ Skill A/B 测试             │
        │ 审批 + 应用流水线         │      │ 跨 Agent 技能迁移           │
        │ 安全回滚机制              │      │ 进化效果跟踪 dashboard      │
        └──────────────────────────┘      └──────────────────────────┘
                │
                ▼
          独立交付物：
          evolution-engine extension
          完整闭环可用
```

---

## Phase 1: 信号采集增强（1-2 周）

### 目标

在现有 usage-tracker extension 基础上，增加 5 类关键信号的实时采集，积累可用于分析的结构化数据。

### 为什么先做这个

- **零风险**：只采集数据，不做任何修改，不影响 agent 行为
- **基础设施**：后续所有 phase 都依赖这些信号数据
- **现有基础**：usage-tracker 已有事件监听框架，改动范围可控
- **立即可验证**：采集的数据是否有用，可以在 Phase 2 的分析中立即验证

### 交付物

#### D1.1: 增强版 usage-tracker

在现有 `~/.pi/agent/extensions/usage-tracker/` 基础上增加：

```typescript
// 新增监听事件 + 采集信号
pi.on("tool_execution_end", async (event) => {
  // 采集：工具名、成功/失败、耗时、错误信息
  recordToolExecution(event.toolName, event.success, event.duration, event.error);
});

pi.on("message_end", async (event) => {
  // 采集：本轮 token usage、turn 编号
  recordTurnStats(event.usage);
});

pi.on("session_start", async (event) => {
  // 采集：session 标识、cwd、reason
  recordSessionMeta(event);
});

pi.on("before_agent_start", async (event) => {
  // 采集：加载的 skills 列表、系统提示词变化
  recordAgentContext(event.systemPromptOptions);
});
```

#### D1.2: 每日汇总文件

每天写入一个汇总 JSON：

```
~/.pi/agent/evolution-data/
├── daily/
│   └── 2026-05-27.json
├── tool-stats.json         # 累积递增
├── skill-triggers.json     # 累积递增
└── session-manifest.json   # session 索引
```

`2026-05-27.json` 结构：

```json
{
  "date": "2026-05-27",
  "sessions": ["id1", "id2"],
  "toolCalls": {
    "total": 156,
    "byTool": { "read": 42, "bash": 38, "edit": 30, "write": 25, "subagent": 15 },
    "failures": { "bash": 5, "edit": 3 }
  },
  "tokenUsage": {
    "totalInput": 245000,
    "totalOutput": 89000
  },
  "skillTriggers": { "ts-taste-check": 2, "code-review-worktree": 1 },
  "errors": [
    { "tool": "edit", "message": "Could not find the exact text", "file": "src/x.ts" }
  ]
}
```

#### D1.3: 文件改动清单

| 文件 | 改动类型 | 改动量 |
|---|---|---|
| `usage-tracker/src/index.ts` | 修改（增加 3 个事件监听 + 持久化逻辑） | ~+200 行 |
| `usage-tracker/src/storage.ts` | 新增（文件 I/O + JSON 合并逻辑） | ~100 行 |
| `usage-tracker/src/types.ts` | 新增（类型定义） | ~60 行 |

### 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 性能影响（每次 turn 多写文件） | 低 | 低 | 内存缓冲 + 批量写入，每 10 次 turn 或 session 结束时 flush |
| 事件监听顺序问题 | 低 | 中 | Pi API 的事件顺序已文档化，按文档顺序处理 |
| 磁盘空间增长 | 低 | 低 | 每日汇总 ~10KB，年增长 ~4MB，可忽略 |

### 里程碑

- [ ] D1.1 完成：增强版 usage-tracker 可用，采集到第一批 signal 数据
- [ ] D1.2 完成：`evolution-data/daily/` 目录下出现每日汇总文件
- [ ] D1.3 验证：运行 1 天后检查数据质量（非空、格式正确、数值合理）

### 退出条件

> 如果 Phase 1 产出的数据在未来 1 周内没有被 Phase 2 有效使用，Phase 1 的价值依然独立存在——它提供了比现有 usage-stats.json 更丰富的使用统计，可用于手动分析。

---

## Phase 2: Session 分析脚本（2-3 周）

### 目标

编写独立的 session 分析脚本，读取 `~/.pi/agent/sessions/` 下的 JSONL 文件，提取 7 类信号，产出结构化分析报告。

### 为什么先做脚本而不是直接做 extension

- **迭代速度快**：Python 脚本改一行跑一次，vs Extension 需要启动 pi 进程
- **离线分析**：不需要 pi 运行，可以 cron 定时执行
- **验证假设**：验证"从 session 中能提取哪些有用信号"，为 Phase 3 的 LLM Judge 提供输入
- **回填历史**：一次性分析全部 667 个 session，而不是等新 session 积累

### 交付物

#### D2.1: `pi-session-analyzer` Python 脚本

```
~/.pi/agent/scripts/
└── pi-session-analyzer/
    ├── analyze.py           # 主入口
    ├── parser.py            # JSONL 解析器
    ├── extractors/
    │   ├── tools.py         # Signal 1: 工具使用模式
    │   ├── tokens.py        # Signal 2: Token 消耗热点
    │   ├── errors.py        # Signal 3: 错误与重试
    │   ├── users.py         # Signal 4: 用户重复指令
    │   ├── skills.py        # Signal 5: Skill 效果评估
    │   └── cross_project.py # Signal 6: 跨项目通用模式
    ├── miner.py             # 模式挖掘
    ├── reporter.py          # 报告生成（JSON + Markdown）
    └── config.py            # 配置文件
```

使用方式：

```bash
# 分析最近 7 天所有项目的 session
python3 pi-session-analyzer/analyze.py --since 7d

# 分析特定项目特定时间段
python3 pi-session-analyzer/analyze.py \
  --project "chat_project" \
  --since 2026-05-20 \
  --until 2026-05-27

# 输出到文件
python3 pi-session-analyzer/analyze.py --since 30d --output report.md
```

#### D2.2: 回顾性分析报告

对过去 2 个月 667 个 session 做一次完整分析，产出：

1. **全局统计报告**：工具使用排名、token 消耗趋势、错误率变化
2. **项目维度拆解**：各项目的工具使用特征、常见操作模式
3. **Top-N 问题清单**：最值得优化的 10 个问题（带数据支撑）
4. **Skill 健康度评分**：每个 skill 的使用率、成功率、触发准确性

#### D2.3: 周报自动化

设置 cron 定时任务（每周一早上）：

```bash
0 8 * * 1 cd ~/.pi/agent/scripts && python3 pi-session-analyzer/analyze.py --since 7d --output ~/.pi/agent/evolution-data/reports/weekly-$(date +%Y-%m-%d).md
```

产出放到 `~/.pi/agent/evolution-data/reports/` 目录，用户可以手动查看或在 pi 中通过 `/evolve-stats` 引用。

### 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 666 个文件首次解析性能 | 低 | 中 | 增量模式（首次全量后只分析新文件）；并行读取（multiprocessing） |
| 跨 session 文本相似度误判 | 中 | 中 | 用多级匹配（先词频再语义），降低假阳性 |
| 信号噪音过多（太多 false positive） | 中 | 高 | 设置置信度阈值，只报告高置信度信号 |

### 里程碑

- [ ] D2.1 完成：脚本能正确解析 JSONL 并输出结构化 JSON
- [ ] D2.2 完成：回顾性分析报告产出，包含至少 3 个可操作的洞察
- [ ] D2.3 完成：周报 cron 正常运行 2 周

### 退出条件

> Phase 2 的产出（分析报告）即使不进入 Phase 3，也可以作为人工优化 CLAUDE.md 和 skill 库的参考。用户每周收到一份报告，据此决定手动优化哪些方面。

---

## Phase 3: LLM Judge 集成（1-2 周）

### 目标

用 pi 的 subagent 能力实现 LLM Judge，将 Phase 2 产出的结构化信号数据作为输入，生成有质量的进化建议。

### 核心挑战

这个 Phase 的关键不是"能不能调用 LLM"，而是 **LLM Judge 给出的建议质量是否足够高**。参考 GVU 的方差不等式——如果 Judge 噪声太大，不如不做。

### 交付物

#### D3.1: LLM Judge 的 Prompt 模板

三套模板，对应不同的评判场景：

```
templates/
├── session-quality.txt      # 评估 session 整体质量
├── skill-health.txt         # 评估 skill 健康度
├── prompt-optimize.txt      # 评估 CLAUDE.md 质量
└── merge-reviewer.txt       # 合并审查（检查建议是否有冲突）
```

每套模板包含：
- **角色定义**：你是谁，你的评判标准是什么
- **输入格式**：结构化信号数据的 schema 说明
- **评判维度**：打分的具体维度和权重
- **输出格式**：严格 JSON schema，包含 confidence 字段
- **反例示例**：什么样的建议是不合格的

#### D3.2: `evolution_report` 工具实现

作为 pi Extension tool 或独立脚本实现：

```
输入流程：
1. 读取 Phase 2 产出的 AggregatedSignal JSON
2. 读取目标文件的当前内容（CLAUDE.md 或 SKILL.md）
3. 根据 target 参数选择对应的 prompt 模板
4. 调用 subagent (model=glm-5.1, taskComplexity=high)
5. 解析返回的 JSON，验证 schema
6. 输出 EvolutionSuggestion[]
```

#### D3.3: 建议质量评估

在投入大量工程之前，先做小规模验证：

1. 取 Phase 2 回顾性分析中发现的 3 个典型问题
2. 用 LLM Judge 生成改进建议
3. **人工评判建议质量**（你作为 pi 的专家用户来评分）
4. 根据评分决定：
   - 如果建议质量高（≥7/10），继续推进 Phase 4
   - 如果建议质量中等（4-6/10），优化 prompt 模板后重新验证
   - 如果建议质量低（<4/10），需要重新思考 Judge 的设计方案

### 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| LLM Judge 产生幻觉建议 | 中 | 高 | D3.3 的先验验证是关键门控 |
| LLM Judge 的 token 成本高 | 中 | 中 | batch 模式，一次分析多个方面，减少调用次数 |
| 不同 target 的建议冲突 | 低 | 中 | merge-reviewer 模板专门处理冲突检测 |
| Judge 偏好过于保守 | 中 | 低 | 在 prompt 中鼓励"有建设性的批评" |

### 里程碑

- [ ] D3.1 完成：四套 prompt 模板编写完成
- [ ] D3.2 完成：evolution_report 工具能正确调用 subagent 并解析 JSON
- [ ] D3.3 完成：建议质量评估通过（≥7/10 得分），绿灯进入 Phase 4

### 退出条件

> 如果 D3.3 评判失败（LLM Judge 建议质量 < 4/10），则暂停 Phase 4，重新设计 Judge 方案。可能的方向：
> - 简化评判维度（从 5 个减少到 2-3 个核心维度）
> - 增加具体示例（few-shot prompting）
> - 使用更强的模型（ds-pro 替代 glm-5.1）
> - 缩小评判范围（只评判 CLAUDE.md，不评判 skill）

---

## Phase 4: Evolution Engine 闭环（2-3 周）

### 目标

将 Phase 1-3 的组件整合为完整的 `evolution-engine` Extension，实现从触发到应用的一键闭环。

### 交付物

#### D4.1: `evolution-engine` Extension

完整的 pi Extension，安装在 `~/.pi/agent/extensions/evolution-engine/`：

```
extension 功能清单:
├── 实时信号采集（Phase 1 的增强版，内联在 extension 中）
├── session 分析触发（调用 Phase 2 的 Python 脚本或 TS 重写）
├── LLM Judge 调用（Phase 3 的 subagent 封装）
├── 建议审批 UI（TUI 交互，逐条确认）
└── 修改应用（备份 + 写入 + git commit）
```

#### D4.2: 四个 Command

| Command | 功能 |
|---|---|
| `/evolve` | 一键触发完整进化周期（分析 → 建议 → 展示）|
| `/evolve-report [period]` | 生成特定时间范围的分析报告 |
| `/evolve-apply [ids]` | 应用已审批的进化建议 |
| `/evolve-stats` | 查看当前 signal 统计和进化历史 |

#### D4.3: 审批交互流程

```
用户输入: /evolve
    │
    ▼
┌─────────────────────────────────────────┐
│  Analyzing sessions (2026-05-20 ~ now) │
│  Found 42 sessions, 3 projects         │
│  Extracting signals...                  │
│  ████████████████████ 100%              │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  LLM Judge evaluating...                │
│  Generated 5 suggestions                │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  #1 [HIGH confidence] CLAUDE.md         │
│  Add rule: "处理 Vue 文件前先确认        │
│  组件库名称（避免用错 button 组件）"      │
│  Rationale: 8 sessions 中出现            │
│  组件库名称混淆导致的 edit 重试          │
│                                         │
│  Actions: [y]es  [n]o  [e]dit  [s]kip   │
└─────────────────────────────────────────┘
    │ 用户选 y
    ▼
┌─────────────────────────────────────────┐
│  Applied: CLAUDE.md updated             │
│  Backup: 2026-05-27_14-30-00/CLAUDE.md  │
│                                         │
│  #2 [MEDIUM confidence] skill:          │
│  whitespace-fixer                       │
│  Modify: 在 description 中增加           │
│  "在 edit 失败后自动触发"               │
│  ...                                    │
└─────────────────────────────────────────┘
```

#### D4.4: 安全机制

1. **修改前备份**：每次 apply 前自动备份原文件
2. **Git commit**：如果文件在 git 仓库中，自动 commit（带描述性 message）
3. **回滚命令**：`/evolve-rollback` 恢复到上一次进化前的状态
4. **进化历史**：所有修改记录持久化到 `evolution-data/history.jsonl`

### 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 修改导致 agent 行为退化 | 中 | 高 | 备份+git+回滚三重保障 |
| TUI 审批交互体验差 | 低 | 中 | Pi 的 ctx.ui 提供了 confirm/select 等交互组件 |
| Python 脚本调用在 extension 中不稳定 | 中 | 中 | Phase 4 可以将核心分析逻辑用 TS 重写 |
| 用户对自动修改缺乏信任 | 中 | 中 | 默认 manual 模式，autoApply 需要显式开启 |

### 里程碑

- [ ] D4.1 完成：evolution-engine extension 可用，能在 pi 中通过 `/evolve` 触发
- [ ] D4.2 完成：四个 command 全部可用
- [ ] D4.3 完成：一次完整的"触发→分析→建议→审批→应用"闭环验证通过
- [ ] D4.4 完成：回滚功能验证通过

---

## Phase 5: 高级特性（持续迭代）

Phase 5 不是固定周期的交付，而是在 Phase 4 闭环稳定运行后持续叠加的特性。

### 候选特性（按优先级）

#### P5.1: Skill A/B 测试框架

借鉴 DSPy 的"并行评估 → 选择最优"思想，但简化为 pi 可用的形式：

- 对同一 skill 维护两个变体（A 和 B）
- 在 subagent 中 A/B 测试（相同 task、不同 skill 版本、对比成功率）
- 基于统计显著性选择最优变体

#### P5.2: 进化仪表盘（Dashboard）

- Web UI 展示进化统计：signal 趋势图、skill 健康度排名、token 效率变化
- 可以与 xyz-agent GUI 集成（利用其 Vue 前端）
- 或独立的 HTML 静态页面（利用 Phase 2 产出的 JSON 数据）

#### P5.3: 跨 Agent 技能迁移

参考 SkillX 的可迁移性实验：

- 将 pi 的技能库导出为通用格式
- 在其他 agent 系统（如 Claude Code 的 skill 格式）中测试迁移效果
- 建立技能格式的转换映射

#### P5.4: 进化策略的进化

让 LLM Judge 不仅评判 Agent 的行为质量，也评判"进化策略本身"的效果：

- 追踪每次修改后的效果指标变化
- 分析哪些类型的修改最有效
- 自动调整评判维度的权重

#### P5.5: 自动触发规则

在特定条件下自动触发进化检查，无需用户手动输入 `/evolve`：

- Token 效率连续下降 3 天 → 自动分析
- 某 skill 使用率连续 30 天为零 → 建议淘汰
- 某类错误率突然上升 → 自动诊断

---

## 依赖关系图

```
Phase 1 ──────► Phase 2 ──────► Phase 3 ──────► Phase 4 ──────► Phase 5
  │                │                │                │                │
  │                │                │                │                │
  ▼                ▼                ▼                ▼                ▼
evolution-data   分析脚本          LLM Judge       evolution-      高级特性
  /daily/         + 报告           prompt          engine          持续迭代
                                   templates       extension
                    │                │                │
                    └────────────────┴────────────────┘
                                     │
                              Phase 3 的 D3.3
                              是关键门控节点
                              通过 → 继续
                              失败 → 重新设计
```

---

## 资源估算

| Phase | 周期 | 工作量 | 新增代码量 | 修改代码量 |
|---|---|---|---|---|
| Phase 1 | 1-2 周 | 1 人 | ~360 行 TS | ~200 行 TS（usage-tracker） |
| Phase 2 | 2-3 周 | 1 人 | ~1500 行 Python | 无 |
| Phase 3 | 1-2 周 | 1 人 | ~500 行 TS + 4 个 prompt 模板 | 无 |
| Phase 4 | 2-3 周 | 1 人 | ~2000 行 TS | ~400 行 TS（合并 Phase 1 代码） |
| Phase 5 | 持续 | 1 人 | 按需 | 按需 |
| **总计** | **8-10 周** | | **~4400 行** | **~600 行** |

---

## 关键决策点

### 决策点 1 (Phase 3 结束)

> LLM Judge 的建议质量是否通过 D3.3 验证？

- 通过 → 进入 Phase 4 闭环
- 不通过 → 回到 Phase 3 优化 prompt，或重新设计 Judge 方案

### 决策点 2 (Phase 4 完成)

> 闭环系统的自动化程度是否足够？

- 如果 `/evolve` 命令体验流畅、建议质量稳定 → 自动触发规则（Phase 5.5）
- 如果审批负担重、建议质量波动大 → 保持在手工触发模式

### 决策点 3 (Phase 5 中期)

> 进化系统是否产生了可测量的正向效果？

评估指标：
1. Agent 任务完成率的变化趋势
2. 每轮对话平均 token 消耗的变化趋势
3. Skill 使用率和健康度的变化趋势
4. 用户干预（追问/否定）频次的变化趋势

如果连续 4 周以上无正向变化，需要重新审视进化策略本身。
