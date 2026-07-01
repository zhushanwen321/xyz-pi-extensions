# plan.md 完整模板

> lite-plan 写 plan.md 时 read 本文件获取完整模板。
> 正文只列 6 章节名称 + 每章一句，本文件是各章节的详细填写规范。

## 模板正文

用 write 工具写入 plan extension 指定的 planFilePath，内容如下（替换 `{...}` 占位）：

````markdown
# {功能名} 实现计划

## 业务目标
<!-- 一句话目标 + 可衡量的成功标准 + 约束/不做 -->
{目标}。成功标准：{可衡量指标，如"X 达到 Y"}。
约束：{技术约束只记录不展开}。不做：{明确边界}。

## 技术改动点
<!-- 文件级清单：创建/修改的文件 + 每个文件的职责。这是 Wave 拆分依据 -->
- 创建 {path} — {职责}
- 修改 {path} — {职责}

## Wave 拆分与依赖
<!-- read ../lite-shared/references/wave-model.md 后填。垂直切片 + 依赖推导 + 并行组 -->
| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1   |         |      |        |      |
| W{N+1} | 验收 Wave | 所有功能 Wave | - | 跑全量测试+覆盖率 |

## 单测用例清单（AC 级）
<!-- read ../lite-shared/references/test-case-schema.md 后填。每条可机器判定。每个改动点正常/异常/边界各≥1 -->
| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1     |           |      |      | 正常 |
| U2     |           |      |      | 异常 |
| U3     |           |      |      | 边界 |

## E2E 用例清单
<!-- E2E 框架探测结果：[有 playwright / 无框架，降级 browser-automation|手动]。每条必标测试层 mock/real，见 test-case-schema.md 核心原则四 -->
| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1     |      | mock   |      |      |      |         |
| E1-r   |      | real   |      |      |      |         |

## 覆盖率 gate
- gate 命令：按 `../lite-shared/references/test-case-schema.md`「语言×框架增量覆盖率」表选项目实际命令
- 阈值：增量覆盖率 ≥ 60%（项目已有更高阈值则就高）

## 实现步骤
<!-- [MANDATORY] 必须用此标题（plan extension extractPlanSteps 识别）。按 Wave 顺序 -->
1. [W1] 写 U1/U2/U3 失败测试 → 实现 → 测试通过 → 提交
2. [W2] ...
3. [W{N+1}] 验收 Wave：跑全量单测 + E2E + 覆盖率，全绿才算完成
````

## 章节填写规范

### 业务目标
- 一句话目标 + **可衡量**的成功标准（"X 指标达到 Y"，非"做好 X"）
- 约束只记录不展开（"必须用 Postgres"记下，不选型）
- 明确"不做"边界（防 scope creep）

### 技术改动点
- 文件级清单（创建/修改），每个写明职责
- 不遗漏（漏了 Wave 依赖推导会错）

### Wave 拆分与依赖
- read `wave-model.md` 后填
- 垂直切片 + blocked_by 从调用关系推导 + 并行组判定
- 末尾强制验收 Wave

### 单测用例清单
- read `test-case-schema.md` 后填
- 每条可机器判定（输入/预期具体值）
- 每个改动点正常/异常/边界各 ≥1

### E2E 用例清单
- **先探测项目实际测试栈**（不预设 Playwright；扫描 playwright.config / cypress.config / puppeteer / 项目测试依赖等）
- **每条 E2E 必标测试层 `mock` 或 `real`**（见 `test-case-schema.md` 核心原则四）：mock = 隔离外部依赖（mock API/DB 跑流程）；real = 真实后端/数据/环境。同一业务流程常拆 mock + real 两条（E1 mock / E1-r real）
- mock 层、real 层**各至少 1 条**；项目无真实环境时 real 层标 `[需集成环境]` 降级手动，不可省略设计
- 有框架 → 执行方式写「该框架的实际命令」（探测到 Playwright 才写 `npx playwright test`；Cypress 写 `npx cypress run`；后端框架按其命令）
- 无 E2E 框架但需测前端交互 → 用 browser 类 skill / CDP 类 MCP 驱动（Agent 主动发现，不写死名称）
- 都不适用 → 标注手动验证步骤
- 覆盖每个业务用例的 happy path + ≥1 失败 path

### 覆盖率 gate
- read `test-case-schema.md`「语言×框架增量覆盖率」表后填
- 写明项目实际的命令 + 如何界定增量（框架原生 diff 过滤 或 diff-cover）
- 必须列为开发阶段独立 todo（isVerification）

### 实现步骤
- **[MANDATORY] 必须用 `## 实现步骤` 标题**——plan extension `extractPlanSteps` 唯一识别此标题，用别的标题 plan→goal 桥接断裂
- 按 Wave 顺序，每个 Wave 的 TDD 步骤
