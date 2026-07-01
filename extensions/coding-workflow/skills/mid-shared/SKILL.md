---
name: mid-shared
description: "[internal] Shared reference files for the mid workflow (mid-plan / mid-detail-plan). Not invoked directly — sibling mid-* skills resolve paths via ../mid-shared/references/{file}.md. Kept hidden from model invocation."
disable-model-invocation: true
---

# mid-shared（共享参考，不可主动调用）

> **这是一个物理载体 skill，不是可执行工作流。** 不要主动加载、不要 `/skill:mid-shared`。
> 它存在的唯一目的：让 `references/` 目录被 pi 安装（symlink 到 `~/.pi/agent/skills/mid-shared/`），
> 从而使兄弟 skill 通过相对路径 `../mid-shared/references/{file}.md` 能稳定命中本目录文件。
>
> `disable-model-invocation: true` 使本 skill **不进入** system prompt 的 `<available_skills>` 列表——
> AI 无法主动发现或调用它。但 pi 的发现管道仍会加载它（symlink 安装 + 进 resourceLoader），
> 其 `references/` 子目录随目录级 symlink 天然可达。

## 定位

mid-* 是 design-* 的**编排变体**：内容对齐 design 全量（6 份 deliverable + 机器检查 + 红队门），编排改为
lite 风格（draft → batch-ask → review-fix-loop）。服务 design 复杂度档位里的 **L2 标准档**——比 design 的
每阶段深度收敛快，比 lite 的无架构设计重。

| 维度 | design-*（重） | **mid-*（中）** | lite-*（轻） |
|------|---------------|-------------|-------------|
| 适用场景 | L3 重型（多系统/跨组织/状态机复杂） | **L2 标准（多模块单系统/3~5 Wave）** | L1 小功能（无架构改动） |
| 内容 | 6 份 deliverable | **6 份 deliverable（同 design）** | plan.md 单文件 |
| 编排 | 每阶段 6 步循环（追踪+审查分两道） | **draft + batch-ask + review-fix-loop** | plan + execute + retrospect |
| ask_user | 逐个 Grilling（40~80 次） | **批量（3~5 次）** | 1~3 次 |
| subagent | 30~48 | **~20** | 5~10 |
| 阶段数 | 6+1 | **2**（mid-plan + mid-detail-plan） | 1 |

**mid 的核心取舍：** 用「正交认知帧 + 跨阶段合并」换 wall-clock。合并追踪+审查损失了 design 两道隔离的 bias 防护，
靠禁读重建路 + 红队路反向帧对冲。详见 `references/review-fix-loop.md`「为什么是它」。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `references/review-fix-loop.md` | mid 核心循环协议（6 步：机器检查→派 N 路 reviewer→认知帧→汇总去重→收敛→修复/超限）+ 派发模板 + 汇总规则 + 与 design 6 步循环差异 | 每个 skill 进入 review-fix-loop 阶段前 read |
| `references/batch-ask.md` | 批量提问协议（收集→分类→批量 ask_user→纳入 decisions.md）+ 二次 ask + 单问例外 | 每个 skill 进入 batch-ask 阶段前 read |

## 引用约定（重要）

兄弟 skill（mid-plan / mid-detail-plan）引用本目录文件，**必须用 `../mid-shared/references/{file}.md`** ——
相对路径的解析基准是当前 skill 的 baseDir（SKILL.md 的 dirname），`../` 跨到兄弟目录 `mid-shared/`。

不要用裸路径 `mid-shared/references/...`：那会解析成 `{当前skill}/mid-shared/...`，安装态下 broken。

## 跨目录引用（复用 design 资产）

mid 不重写 design 的内容资产，**全部复用**。跨到 design 目录的引用：

- **机制类**（跨阶段协议）：`../design-shared/references/{loop-skeleton|loop-method|review-agent|context-builder}.md`
  - `loop-skeleton.md` 的「subagent 派发工程规范」「decisions.md 机制」「标记约定速查表」mid 全部沿用
  - `review-agent.md` 的 6 维审查 spec + 红队维度，mid 的 reviewer 路直接引用
  - `context-builder.md` 的阶段工作摘要，mid-detail-plan Step 0 派发时引用
- **阶段内容类**（deliverable 模板 + 视角 + 词汇表）：`../design-{clarity|architecture|issues|nfr|code-arch|execution}/references/*.md`
  - mid-plan 复用 `design-clarity` + `design-architecture` 的全部 references
  - mid-detail-plan 复用 `design-issues` + `design-nfr` + `design-code-arch` + `design-execution` 的全部 references
- **机器检查脚本**：`../design-{phase}/scripts/check_{phase}.py`（mid 不重写脚本，直接调）
- **渲染 HTML**：`design-visual-explainer` skill（mid 定稿后派 fresh subagent 加载它渲染）

> mid-shared 只承载 **mid 独有的编排抽象**（review-fix-loop + batch-ask）。其余机制（派发工程、decisions.md、
> context-builder、review 维度 spec、deliverable 模板、机器检查脚本、HTML 渲染）全部引用 design 资产，不重复实现。
