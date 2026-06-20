# Clarification — ask-user extension

> 需求澄清记录。主 agent 交互提问 + 独立 subagent 追踪的 gap 在此汇总。

## 已澄清决策（Step 2 交互）

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D1 | 与 pi-ask-user 关系 | 替换（卸载 pi-ask-user） | 用户指定 |
| D2 | 工具名 | `ask_user`（沿用） | 4 个 skill 硬编码引用，零修改兼容 |
| D3 | 代码起点 | 全新自研 | 符合本项目规范，避免 as any / scope 不一致 |
| D4 | 交互模型 | 自适应（单问无 Tab，多问 1-4 有 Tab+Submit） | 兼顾两种场景 |
| D5 | 渲染模式 | 纯 inline | 用户指定 |
| D6 | 选项数 | 2-4 严格（schema minItems:2, maxItems:4） | LLM 易构造，选项精炼 |
| D7 | 搜索过滤 | 去掉 | 2-4 选项时价值极低（决策张力解决） |
| D8 | 分屏预览 | 保留（宽终端左选项+右 Markdown） | pi-ask-user 杀手锏，决策质量高 |
| D9 | 可选评论 | 保留（question 级 allowComment） | "选 A 但补充说明"场景 |
| D10 | 内联编辑器 | 保留（自由文本就地展开 Editor） | 不切模式，心智简单 |
| D11 | 自由文本 | 始终可自由输入（自动附加 Other 选项） | 用户总能自定义 |
| D12 | 多选粒度 | question 级 multiSelect | 单次调用可混合单选/多选 |
| D13 | Headless | 最简：无 UI 返回 isError + 禁用工具 | 用户"无视"，取最简防重试方案 |
| D14 | Timeout | 支持（自动超时返回 null） | goal 自动循环防卡死 |
| D15 | Skill | 不内嵌 | 精简，靠 description+promptSnippet |
| D16 | 事件 | 不发（ask:answered/cancelled） | YAGNI，当前无扩展监听（已验证） |
| D17 | 架构 | 分层组件（5 文件） | 每文件 <300 行，可独立单测 |

## 事实验证（F 类，已用代码确认）

| 事实 | 验证方式 | 结论 |
|------|---------|------|
| 项目内扩展是否监听 ask:answered/ask:cancelled | `grep -rn "ask:answered\|ask:cancelled" extensions/ shared/ skills/` | **无监听者**。事件契约可自由设计，决定不发 |
| 哪些 skill 硬编码引用 ask_user 工具名 | `grep -rn "ask_user" skills/ extensions/*/src/` | spec-clarify、coding-workflow/brainstorming、plan/command.ts 共 4 处，均为 "if available" 描述。沿用工具名 = 零修改 |
| ctx.ui.custom 签名 | `shared/types/mariozechner/index.d.ts:30` | `custom<T>(factory: (tui, theme, kb, done) => any, options?): Promise<T>` |
| execute 的 ctx 参数位置 | `extensions/goal/src/index.ts:238` | 第 5 参数 `ctx: ExtensionContext` |
| pi.setActiveTools / getAllTools | `extensions/plan/src/command.ts:89` | `pi.setActiveTools(string[])` + `pi.getAllTools()` |
| StringEnum 来源 | `shared/types/mariozechner/index.d.ts:142` | `@mariozechner/pi-coding-agent` 导出（非 typebox） |

## Gap 处理结果（Step 3 追踪 → Step 4 分流）

### F 类（全部确认成立，已补入 spec）

| Gap | 问题 | spec 补充 |
|-----|------|----------|
| G-001 | signal abort 未处理 | FR-11 新增：custom factory 内 `signal.addEventListener("abort", () => done(null))`，execute 入口检查 `signal?.aborted` |
| G-005 | comment 存储字段未定义 | FR-12 新增：QuestionState 新增 `commentValue: string\|null` 字段，随 confirm 持久，切 tab 保留 |
| G-006 | `_resolved` guard 未提 | FR-13 新增：组件 `_resolved` 标志，done() 后置 true，handleInput 入口检查防重入 |
| G-007 | multiSelect join 顺序不精确 | FR-7 修正：常规选项按 index 序 join，Other 自由文本**追加末尾** |
| G-009 | header 单问可选/多问必填 schema 矛盾 | FR-2 明确：schema 中 header 为 Optional，运行时校验（多问题缺 header → isError） |
| G-011 | renderCall/renderResult 组件类型 | FR-10 明确：用 Text 或 TruncatedText，长内容用 TruncatedText 防溢出 |
| G-014 | setTimeout 未 clearTimeout | FR-9 补充：done() 后 clearTimeout，用户提交后立即释放 timer |
| G-015 | custom factory 异常未捕获 | FR-14 新增：execute 顶层 try/catch，异常返回 isError |

### K 类

| Gap | 处理 |
|-----|------|
| G-016 并发调用 | spec 补充：Pi 运行时串行化 tool execute + custom UI（function calling 协议串行，TUI 单组件显示），无需额外处理 |

### D 类（用户已决策）

| Gap | 决策 |
|-----|------|
| G-002/G-013 comment 触发机制 | **选中后停顿输评论**：选中选项后不立即提交，显示评论输入行（可 Enter 跳过）。统一单/多问题流程 |
| G-008 校验失败返回 | **isError:true**（LLM 重试修正） |
| G-003 timeout 语义 | **总会话计时**（整个问答会话总时长，超时全丢） |
| G-012 已确认回改 | **允许回改**（confirmed 标记更新，■ 变回 □） |

## 已解决，进入 Step 5 收敛复核

### Round 2 收敛复核结果

独立 subagent 重跑 5 视角，Round 1 的 16 个 gap 中 15 个完全到位，1 个（G-013）引入新 gap：

| Gap | Type | 问题 | 处理 |
|-----|------|------|------|
| G-017 | D | 评论输入行的组件选型/按键映射/多选触发时机未定义 | spec 已补全：FR-4 item6 明确复用 Other 的 Editor 实例；FR-6 表补充评论输入行上下文（Enter 空=跳过、Enter 有=保存、Esc=跳过）；多选需 Enter 确认后才进入评论行；AC-19/AC-20 验证 |

**收敛判定**：新发现从 16→1，G-017 为纯实现细节（已用合理默认补全）。判定收敛，不再派 Round 3。

## Step 6 定稿

- Six-Element Check 全通过
- Ambiguity scan：修正 AC-10（补具体测试覆盖点）、FR-3（allowComment 时单问题提交时机）
- 无 TBD/TODO，内部一致

## 定稿后用户修改：移除 timeout

用户要求"超时模式需要用户开启，默认不开启"。澄清后用户选择**移除 timeout（YAGNI）**——当前无此需求，超时能力默认不存在。

**变更**：
- 移除 FR-9（原 Timeout）、AC-7（原 timeout 到期）、AC-16（原 clearTimeout）
- 移除 questions schema 的 `timeout?: number` 参数
- FR 重新编号（FR-9→自定义渲染，FR-10→signal abort，FR-11→comment 存储，FR-12→防重入，FR-13→错误兜底，FR-14→答案回改）
- AC 重新编号（18 个 AC）
- Decisions 表：移除"Timeout 语义""timeout 边界"两行，新增"Timeout | 移除（YAGNI）"
- 移除 UC-3（goal 防卡死，依赖 timeout）
- Background 文案移除 timeout 提及
- FR-12 防重入守卫理由改为 signal abort 竞态（原 timeout 竞态）

**理由记录**：超时需用户显式开启，默认不开启；当前无此需求。goal 卡死由 goal 自身的 stall 检测处理，非 ask_user 职责。
