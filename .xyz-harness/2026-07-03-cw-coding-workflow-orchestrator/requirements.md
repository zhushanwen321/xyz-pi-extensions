---
verdict: pass
tier: mid
skill: mid-plan
stage: requirements
---

# Requirements — CW (Coding Workflow Orchestrator)

## 1. 业务目标

### G1: 让 coding 流程的状态流转由机器强制，而非 agent 自觉

**成功标准（可衡量）**:
- agent 无法跳过任一阶段直接到后续阶段（状态机非法转换被 CW 拒绝）
- 每个阶段的交付物经机器 gate 验证（强度标注：weak/medium/strong）
- lite 路径的 E2E 测试结果由机器重算，agent 无法谎报 actual（strong-recompute）
- goal_control(complete) 的 evidence 含 CW topicId + gate 历史，可事后对账

### G2: agent 只需认 CW 一个接口，无需知道全流程

**成功标准**:
- agent 工具箱中只有 `coding-workflow` tool（test-orchestrator 不再独立暴露）
- agent 每次调用 CW 后，CW 返回 `nextAction` 明确告知下一步调什么 action + 用什么 skill
- MVP 阶段：新增入口 skill coding-workflow + 各 skill description 顶部加"对应 CW action: xxx"映射句（[REVISIT of D-007] 降级版）。彻底删除各 skill 内"下一步 /skill:xxx"路由与 D-011 改名同步做，不在 MVP 验收范围内

### G3: 支持渐进式提交，任务粒度可追溯

**成功标准**:
- dev 阶段：每完成一个 Wave 提交 commit，CW 校验 commit 真实性并记录
- test 阶段：每跑完一条用例可提交结果，CW 机器重算（lite）或记录声明（mid）
- `_cw.db` 维护权威进度（devProgress / testProgress），agent 可随时查询剩余任务

## 2. 约束 & 不做

### 约束
- **不改 goal 扩展**：CW 不与 goal_control(complete) 硬耦合（D-002, D-009）。强制点在 CW 状态机，不在 goal。
- **不重造 budget/followUp**：goal 提供的 token/时间预算、followUp 每 turn 注入 objective 由 goal 继续承担。
- **复用现有 check 脚本**：check_plan/check_clarity/check_architecture/check_issues/check_nfr/check_code_arch/check_execution/check_execute 不重写，作为 CW gate 的内部检查器调用。
- **复用 test-orchestrator 判定逻辑**：judgeByExpected + 状态机 + 全覆盖校验内化进 CW，不重写。
- **CW 状态存项目内**：_cw.db 放 .xyz-harness 下以 topic 命名的子目录。目录命名规则 = 创建日期前缀（YYYY-MM-DD）+ 连字符 + 用户传入的 slug（与现有 topic 目录约定一致，例：2026-07-03-cw-coding-workflow-orchestrator）。CW create-topic 入参 slug 不带日期，CW 建目录时自动加创建日期前缀。git 追踪是审计特性（D-016 改用 sqlite，审计用 sqlite3 CLI 查询）。

### 不做（YAGNI / MVP 边界）
- **不做 full 路径接入**（D-010）：MVP 只支持 tier=lite + tier=mid。
- **不做 skill 改名**（D-011）：mid-plan→mid-clarify 等改名推迟到 CW 稳定后。
- **不做开发任务的 CW 细粒度派发**：dev 阶段 agent 用 todo 自拆 Wave 内任务，CW 只校验 Wave 维度的 commit 完整性。
- **不做内容正确性判定**：weak-structural gate 只判结构（章节齐全/无占位符），不为需求/架构内容背书。内容正确性靠 review/人判。
- **不做 mid test 的机器重算**：mid 断言是自然语言，CW 信 agent 声明（medium-coverage，诚实标注）。
- **不做 get-status action**：续跑场景靠 agent 读 `_cw.db` 或重调上次 action 的返回；MVP 不提供独立 status 查询 action。

## 3. 业务用例（Use Case）

### Actor: AI Agent（主使用者）

agent 在 coding 流程中与 CW 交互。业务用例按 CW 的 action 划分。

**通用入参约定**：除 create 外，所有 action 入参含 topicId 定位当前操作的 topic。create 用 slug 新建 topic 并返回 topicId，后续 action 用该 topicId。

#### UC-1: 创建 topic 并锁定 tier

- **前置**: 用户发起一个新功能需求，决定走 lite 或 mid 流程
- **主流程**: agent 调 cw create-topic 传 slug/tier/objective → CW 建 .xyz-harness 下 topic 目录与 _cw.db（status=created, tier 锁定） → CW 返回 topicId + nextAction（按 tier 指向 plan 或 clarify）
- **替代流程**: slug 已存在 → CW 拒绝，agent 换 slug
- **后置**: topic 进入 planning（lite）或 designing（mid）待办状态
- **验收标准（AC）**:
  - AC-1.1: tier=lite 时返回的 nextAction.action === "plan"
  - AC-1.2: tier=mid 时返回的 nextAction.action === "clarify"
  - AC-1.3: _cw.db 写入后 tier 字段只读（后续 action 无法修改）
  - AC-1.4: slug 重复时 CW 报错且不覆盖已有目录

#### UC-2: 提交 plan/clarify/detail 交付物过 gate

- **前置**: topic 已创建，status 符合对应 action 的前置状态
- **主流程**: agent 完成 plan/clarify/detail skill 产出 JSON+MD 交付物 → agent 调对应 CW action 传 deliverables → CW 校验文件存在 + JSON 的 format 字段等于 topic.tier（tier 锁定，D-003） → CW 跑对应 check 脚本（weak-structural gate） → pass 时 CW 从 JSON 解析 waves/testCases 写入 _cw.db，状态流转，返回 nextAction（含下一步任务清单）；fail 时 CW 返回 must_fix，状态不变
- **替代流程**: tier 不匹配 → CW 拒绝（提示 tier 在 create 锁定，作废重建）
- **后置**: topic 进入下一状态（planned/clarified/detailed），dev 任务清单就绪
- **验收标准（AC）**:
  - AC-2.1: JSON.format !== topic.tier 时 CW 报 tier mismatch，gate fail，状态不变
  - AC-2.2: 任一 check 脚本 exit 1 时整体 gate fail（fail-fast）
  - AC-2.3: gate pass 时 _cw.db 的 wave/test_case 表从 JSON 正确填充
  - AC-2.4: gate fail 时 _cw.db 的 status 不变，gateHistory 仍追加本次尝试
  - AC-2.5: gate pass 时 status 按 tier 流转（lite: created→planned；mid: created→clarified，clarified→detailed）
  - AC-2.6: gate pass 前 review-fix-loop 的收敛结果已由 skill 阶段落盘为 changes/ 下对应 review 文件（verdict: APPROVED），满足 check 脚本的 review 前置要求（由 skill 阶段产出，非 CW 运行时产）
  - AC-2.7: mid detail 交付物含 detail.json + 4 份 .md + code-skeleton/，三者结构存在均校验（code-skeleton 是可编译骨架，detail gate 校验其存在）

#### UC-3: 渐进式提交开发 commit

- **前置**: topic 状态为 planned（lite）/ detailed（mid），waves 已写入 _cw.db
- **主流程**: agent 派 implementer subagent 完成一个 Wave 的代码并 commit → agent 调 cw dev 传 tasks 数组（每项含 waveId 和 commitHash） → CW 逐个校验 commit 真实性（存在 + 属于本仓库 + 非空，D-005） → 有效时更新 _cw.db 对应 wave 的 committed 字段，返回 devProgress → 全部 Wave committed 时 gatePassed=true，nextAction 指向 test（含 testCases 清单）
- **替代流程**: commit 校验失败 → 该 task 记 fail，不更新 committed，failureReason 列具体哪项检查挂了
- **后置**: topic 状态保持 developed（首次有效提交时从 planned/detailed 流转），待全 Wave 完成进 test
- **验收标准（AC）**:
  - AC-3.1: 假 commitHash（git cat-file 不存在）→ 该 task fail
  - AC-3.2: 外来 commitHash（不在本仓库历史）→ 该 task fail
  - AC-3.3: 空 commit（--allow-empty）→ 该 task fail
  - AC-3.4: 全 Wave committed 前 gatePassed=false（表示阶段未完，非错误）
  - AC-3.5: 首次有效 dev 提交触发 planned/detailed → developed 状态流转
  - AC-3.6: dev 的 gateTier 标注为 medium-git（commitHash 经 GitValidator 三项校验，有真实凭证但不重算业务结果）

#### UC-4: 渐进式提交测试结果

- **前置**: topic 状态为 developed，testCases 已写入 _cw.db
- **主流程**: agent 派 test-runner subagent 跑一条用例获取 actual 与截图 → agent 调 cw test 传 cases 数组 → CW 按 tier 分化判定（D-008）—— lite 校验截图存在后读 expected 调 judgeByExpected 重算并丢弃 claimedStatus（strong-recompute）；mid 信 agent 声明的 status 记录 commitHash（medium-coverage） → 更新 _cw.db 对应 test_case，返回 testProgress → 全用例 passed 时 gatePassed=true，nextAction 指向 retrospect
- **替代流程**: lite 机器判定 failed → testCase.status=failed，failureReason 记 mismatch 详情；mid agent 声明 fail → testCase.status=failed
- **后置**: topic 状态保持 tested（首次提交时从 developed 流转），待全用例 passed 进 retrospect
- **验收标准（AC）**:
  - AC-4.1: lite 路径传入 claimedStatus=pass 但 actual 与 expected 不符 → 机器判定 failed（丢声明）
  - AC-4.2: lite 路径 screenshotPath 文件不存在 → 该 case fail
  - AC-4.3: mid 路径 status=pass 直接记录为 passed（不重算），但 commitHash 须经 GitValidator 校验真实性（medium-coverage，指向 dev 阶段的测试产物 commit 或同一批 commit）
  - AC-4.4: 全 testCase passed 前 gatePassed=false
  - AC-4.5: 首次有效 test 提交触发 developed → tested 状态流转

#### UC-5: 提交复盘和归档

- **前置**: topic 状态为 tested（retrospect）/ retrospected（closeout），test 全 passed
- **主流程**: agent 完成 retrospect/closeout 产出物 → agent 调 cw retrospect 或 closeout 传 deliverables → CW weak gate 校验（文件存在 + 非空） → pass 时状态流转；closeout pass 时 evidence 填充完整，状态=closed（终态）
- **retrospect 交付物清单**: changes/retrospect.md（复盘报告，含过程回顾/问题/改进）
- **closeout 交付物清单**: 归档到长期文档（ARCHITECTURE.md / NFR.md / ADR 等，按归档目标）+ changes/closeout-summary.md（归档摘要，记录沉淀去向）
- **后置**: closeout 完成 = topic 终态，agent 拿 evidence 调 goal_control(complete)
- **验收标准（AC）**:
  - AC-5.1: retrospect 前置不满足（testCases 未全 passed）→ CW 拒绝
  - AC-5.2: closeout pass 时 evidence 含完整 gateHistory
  - AC-5.3: closeout 后 status=closed（终态，不可再流转）
  - AC-5.4: retrospect gate pass 时 status: tested→retrospected

### Actor: 用户（间接）

用户不直接调 CW。用户通过以下方式影响 CW:
- 决定 tier（create-topic 前的判断，或 agent ask_user 后用户拍板）
- review plan.md / requirements.md 等人类可读交付物（CW gate 不替代人判）
- 事后审计：sqlite3 `_cw.db` 核对 gateHistory 与 agent 的 goal_control evidence 是否一致

## 4. 数据流转

CW 维护的数据按以下流转（本节描述数据视角，不展开实现）：

```
用户需求 → agent 调 cw create-topic
  → 生成 _cw.db（topicId/status=tier 锁定/空任务清单）

agent 调 cw plan/clarify/detail（交付 JSON+MD）
  → CW 解析 JSON 的 waves/testCases 写入 _cw.db
  → CW 跑 check 脚本 → pass 流转状态

agent 调 cw dev（逐 Wave 提交 commit）
  → CW git 校验 → 更新 _cw.db wave.committed

agent 调 cw test（逐用例提交 actual）
  → CW 机器重算(lite)/记录声明(mid) → 更新 _cw.db test_case.status

agent 调 cw closeout → _cw.db evidence 填充 → status=closed
  → agent 拿 evidence 调 goal_control(complete)
```

CW 维护每 topic 一份 _cw.db（sqlite 关系表，D-016），逻辑模型见 architecture §8。含以下状态类别：
- **身份**: topicId, slug, tier（锁定）, objective, workspacePath, createdAt
- **状态**: status（状态机节点；流转轨迹从 gateHistory 重建，见 architecture §8）
- **任务清单**: waves（dev 任务，含 committed commitHash）, testCases（test 任务，含 status/actual/screenshot）
- **gate 历史**: gateHistory（每次 action 的 gate 结果 + 强度标注）
- **证据**: evidence（收尾时填充，供 goal_control）

详细字段结构属 system-architecture.md（数据模型），本 requirements 只声明"CW 维护这些状态类别"。

## 5. 界面视角

CW 不直接面向终端用户 UI。交互界面是:
- **agent ↔ CW**: tool call（Pi 的 tool 接口）
- **agent → 用户**: agent 把 CW 返回的 status/progress/nextAction.guidance 转述给用户
- **用户 ↔ `_cw.db`**: 用户可直接用 sqlite3 CLI 查询审计（D-016，审计表结构见 architecture §8.1）

## 6. 跨系统依赖

| 依赖 | 类型 | 契约 |
|------|------|------|
| goal 扩展 | 自有可控（同项目）| CW 不调用 goal；goal 的 complete 由 agent 调，evidence 引用 CW topicId。松耦合（agent-mediated，非机器强制）。 |
| todo 扩展 | 自有可控 | CW 不调 todo；agent 据 CW nextAction.waves/testCases 自建 todo。 |
| 现有 check_*.py 脚本 | 自有可控 | CW 内部 spawn 调用，入参为 topic_dir 或文件路径，出参为 exit code + changes/ 下以 machine-check 开头的报告文件。脚本硬性要求 review 文件 + verdict:pass，该 review 文件由 skill 阶段的 review-fix-loop 产出落盘（非 CW 运行时产），CW gate 跑 check 时该文件已存在（见架构 §5.2）。 |
| git | 第三方不可控但稳定 | CW 调只读 git 命令校验 commit 真实性（cat-file / merge-base / diff-tree，execFileSync）。 |
| CW tool 宿主 | 自有可控 | CW tool 宿主 = 现有 @zhushanwen/pi-coding-workflow 扩展，取代 test-orchestrator tool 注册位（D-004 落点）。tool 名 coding-workflow 与扩展包同名但不同命名空间（tool vs package）。 |
| 各 coding skill | 自有可控 | CW nextAction.skill 返回 skill 名，agent 调 /skill:xxx。skill 收口改造（D-007，[REVISIT] 降级版）。 |
| coding-init skill | 自有可控，正交 | 项目级文档容器产出，与 topic 级 CW 正交，不在状态机内。 |
| plan 扩展（@zhushanwen/pi-plan）| 自有可控，无关 | CW 与 plan 扩展完全无关。plan 扩展提供轻量级 Plan Mode（brainstorming + writing-plans），是独立工具；CW 的结构化 JSON（plan.json/clarify.json/detail.json）是 CW 的内部关注点，由各 coding skill 产出，不经 plan 扩展。两者命名都含 plan 但无调用关系。 |

## 7. 领域术语（统一语言）

| 术语 | 定义 |
|------|------|
| **CW** | Coding Workflow Orchestrator，本需求定义的 tool。Pi registerTool name = coding-workflow，agent 调用形式 cw（tool description 注明别名）。宿主 @zhushanwen/pi-coding-workflow 扩展，与扩展包同名但不同命名空间 |
| **topic** | 一个需求的生命周期单元，由 create-topic 创建，slug 唯一标识 |
| **tier** | topic 的复杂度档位（lite/mid），create-topic 锁定，不可变 |
| **gate** | CW 在某阶段跑的机器检查，分 4 档强度（weak-structural / medium-git / medium-coverage / strong-recompute）|
| **gateTier** | gate 强度标注 4 档：weak-structural（仅结构）/ medium-git（commitHash 经 GitValidator 校验，dev 用）/ medium-coverage（凭证+信声明，不重算业务断言，mid test 用）/ strong-recompute（机器重算丢 AI 声明，lite test 用）|
| **渐进式提交** | dev/test 阶段 agent 多次调用 CW，每次提交部分任务结果，CW 累计判定 |
| **waves** | dev 任务清单，从 plan/detail JSON 解析，每个 Wave 对应一个 commit |
| **testCases** | test 任务清单，从 plan/detail JSON 解析，含 expected（lite 结构化/mid 自然语言）|
| **状态机** | topic 的生命周期状态（created→planned/clarified→...→closed），线性流转，CW 强制 |
