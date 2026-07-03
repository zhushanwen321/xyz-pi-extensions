# 测试用例 Schema 与覆盖率 Gate

> lite-plan 写 plan.md 的「单测用例清单」「E2E 用例清单」「覆盖率 gate」章节前 read 本文件。
> 测试设计是 lite 工作流的**重中之重**——验收标准全绿才算完成。

## 核心原则：可机器判定

每条测试用例必须**可被机器判定 pass/fail**，不能是"应该正常工作""行为正确"这类模糊描述。

```
✅ 可机器判定                         ❌ 模糊不可判定
输入: addItem(cart, "apple", 2)      输入: 添加商品
预期: cart.total === 2 且            预期: 购物车正常工作
      cart.items.length === 1
```

**「不可判定」的症状检测**（借鉴 full 的 gap 卡住信号）——测试用例的输入/预期出现以下措辞即判不合格，回炉具体化：

| 症状措辞 | 含义 | 修法 |
|---------|------|------|
| 「大概是…」「应该返回…」 | 在猜预期，没对照真实数据 | 拉对应 fixture 进上下文，按 fixture 推算预期值 |
| 「正常工作」「行为正确」 | 无具体断言 | 写成可执行的 == / throw / 状态变更断言 |
| 「让我看代码」 | 预期依赖运行时才知 | 改为可静态判定的断言，或拆成「设前提 X 下预期 Y」 |
| 「这取决于…」 | 有未定条件 | 拆成多条用例，每条覆盖一个条件分支 |

## 核心原则二：fixture 对齐（预期值对照真实数据）

测试预期值必须对照**已存在的真实 fixture**（mock 文件、种子数据、现有测试数据集）推算，不能从功能描述正向猜测。

- 写清单前，先把涉及的 fixture 数据 read 进上下文（如 `MOCK_COMMANDS` 的完整命令名列表、种子用户表、现有测试的 factory 数据）
- 涉及过滤/查询/匹配的用例：输入值取自 fixture 集合，预期值按 fixture 内容推算（而非「我想要它返回 X」）
- fixture 不在场的用例 = 预期值是猜的 = 不可信

> 实测案例：U6 设计 `query='co'` 预期匹配 /commit，但 mock 数据集 `/commit /review /fix /compact` 中 /compact 也含 'co'——设计时 fixture 没进上下文，到执行期才发现匹配 2 项。「先有功能意图、后补 fixture 认知」顺序反了，fixture 必须先于用例进上下文。

## 核心原则三：同源盲区反向自检（用例集合完整性）

从**功能描述正向推导**用例会系统性漏边界——功能意图先入为主，只覆盖「应该这样」的路径。需用**反向自检**补全用例集合：

- 每个技术改动点的异常/边界用例，从**调用方**和**数据集**反推：调用方会传什么异常输入？数据集里有哪些值会触发非预期匹配/边界？
- 对照完整数据集（不只想主用例的数据）逐一问：「输入这个值会怎样？」——而非「我要验证功能 X」
- 反向自检清单：过滤类→数据集里还有谁会命中？数值类→0/负/最大/空？状态类→每个非法转换？

> 同源盲区：主 agent 既是功能理解者又是用例设计者，两角色同源，盲区也同源。full 用 fresh subagent 禁读重建对抗；lite 降维为「反向自检」——不派 subagent，但强制从数据集/调用方反推而非正向推导。

## 核心原则四：测试分层（Mock 层 / 真实层）

测试用例必须按**是否隔离真实依赖**分成两层，验收时各自独立 todo、各自全绿：

| 测试层 | 含义 | 典型形态 | 特点 |
|--------|------|---------|------|
| **mock**（隔离层）| mock 掉外部依赖（后端 API / DB / 第三方服务），只验被测单元或前端流程自身逻辑 | 单测（天然 mock）；mock 后端 API 的 E2E（如 MSW/拦截器跑前端全流程） | 快、确定、CI 主力、可重复 |
| **real**（真实层）| 不 mock 关键依赖，用真实后端 / 真实数据 / 真实环境跑端到端 | 真实后端的集成 E2E；真实 DB 的 service 层集成测试 | 慢、环境敏感，但验证真实集成（暴露 mock 掩盖的契约/时序/数据问题） |

**为什么必须两层都有：** mock 层验证「逻辑对不对」，real 层验证「接起来对不对」。只有 mock 层 = mock 掩盖了真实后端的契约偏差/数据形态/时序问题，到生产才爆；只有 real 层 = 慢、脆弱、失败定位难，CI 跑不起高频回归。两层互补，缺一即虚假安全感。

**单测（U\*）默认 mock 层**（单测本性就是隔离单元依赖），无需标。**E2E/集成（E\*）必须标 mock 或 real**——同一条业务流程往往两条都要：mock 层一条（快、CI 跑）+ real 层一条（真实集成兜底）。

> **与 full/mid 体系的映射**：full-code-arch test-matrix 来源 B 的「强制层级」（`unit/integration/e2e`）是更细的 NFR 风险归属——`unit`≈mock 层，`integration/e2e`≈real 层。lite（L1 小功能）用 mock/real 粗分够用；full（L3）/ mid（L2）来源 A 也标 mock/real（与 lite 对齐），来源 B 保留 unit/integration/e2e 细分（NFR 风险需精确归属执行层）。

**项目无真实环境时**：real 层用例不能省略设计，标 `[需集成环境]`。但**执行阶段禁止 AI 自决「手动验证通过」**——这是最大的 E2E 逃逸口子。执行期（coding-execute）的合法出路只有两条：

1. **test-runner 真跑**：worktree 起本地 mock 后端 / docker-compose / 本地集成环境，报 pass/fail
2. **用户显式豁免**：确无环境时，主 agent **必须 ask_user** 由用户拍板跳过，报告中记 `status: user-skipped` + `user_confirm_ref`（用户确认凭证）

`check_execute.py` 对 real 层用例只认 `pass` 或 `user-skipped`（须带凭证）；AI 自标的 `manual` / `blocked` / `skipped` 一律判 FAIL。`pending-env` 是 test-runner 的合法**中间态**（确无环境时记录，待主 agent ask_user 解析），但若留在终态（未解析）同样判 FAIL。降级决定权在用户不在 AI。略掉 real 层设计 = 默认「mock 过了真实就过」的危险假设。

## 单测用例清单 Schema

```markdown
## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1     | cart.ts:addItem | addItem(cart,"apple",2) | total=2,items.length=1 | 正常 |
| U2     | cart.ts:addItem | addItem(cart,"",0) | throw "invalid item" | 异常 |
| U3     | cart.ts:addItem | addItem满载cart) | throw "cart full" | 边界 |
```

### 字段规范

- **用例ID**：`U` + 数字，全局唯一。验收 Wave 用此 ID 追踪。
- **覆盖改动点**：精确到 `文件:函数`。每个技术改动点（plan.md「技术改动点」清单里的每个文件）至少 1 条单测。
- **输入**：具体的函数调用 / 数据。非"传入有效数据"。
- **预期**：具体的断言（返回值 / 抛错 / 状态变更）。非"返回正确结果"。
- **类型**：正常 / 异常 / 边界。**每个覆盖点的三条至少各有 1 条**（异常和边界最常漏）。

### 覆盖率 Gate（强制）

```markdown
## 覆盖率 gate

- gate 命令：按下方「语言×框架增量覆盖率」表选项目实际命令
- 阈值：增量代码覆盖率 ≥ 60%（下限；项目已有更高阈值则就高不就低）
- gate 位置：列为开发阶段的独立 todo（isVerification=true），验收时执行
```

#### 语言×框架增量覆盖率计算（示例，按项目实际选）

不同语言/测试框架算增量覆盖率的手段不同。下表每语言给一个主流框架的完整示例，其余同类框架同理用各自 `--coverage`。

| 语言/运行时 | 主流框架（示例） | 跑覆盖率命令 | 如何界定"增量"范围 |
|------------|----------------|-------------|---------------|
| **TypeScript / Node.js** | vitest（示例）；jest 同理 | `npx vitest run --coverage` | vitest `--changed=<base分支>` 只跑改动相关用例并报这些文件覆盖；无 `--changed` 时用 `git diff --name-only <base>` 出改动文件，看报告中这些文件的行覆盖。jest 用 `--coverage --changedSince=<base>` |
| **Python** | pytest + coverage.py（示例）；unittest 用 `coverage run -m unittest` | `pytest --cov=<pkg> --cov-report=term-missing` | `pip install diff-cover && diff-cover coverage.xml` 对比 git diff，报改动行的覆盖率 |
| **Java** | JUnit5 + JaCoCo（示例；Maven/Gradle 均支持） | Maven: `mvn test jacoco:report`<br>Gradle: `./gradlew test jacocoTestReport` | JaCoCo 默认报全量；增量用 `diff-cover target/site/jacoco/jacoco.xml`（Gradle: `build/reports/jacoco/test/jacocoTestReport.xml`）对比 git diff |

> **如何界定增量**：本质都是"只看本次改动涉及的代码行是否被测试覆盖"。框架原生支持 diff 过滤的优先用（vitest `--changed` / jest `--changedSince`）；不支持的用 `diff-cover` 这类工具拿 `git diff` 对比覆盖率报告（Python coverage.xml / Java jacoco.xml）。若项目无任何增量工具，降级为"看全量报告中改动文件的行覆盖"，并在 plan.md 标注。
>
> 60% 是下限。关键逻辑（状态机、金额计算、权限）应追求更高覆盖。阈值按项目既有约定调整（项目已配了 jacoco-check/vitest threshold 就从其配置，不重设）。

**gate 必须执行**：开发收尾不是"代码写完了"，而是"单测全绿 + 增量覆盖率达标"。不达标回 implementer 补测试。

## E2E 用例清单 Schema

```markdown
## E2E 用例清单

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1     | 用户登录主流程 | mock | 已注册用户(mock API) | 1.打开/login 2.填表单 3.提交 | 跳转/profile，显示用户名 | <项目测试框架> |
| E1-r   | 用户登录主流程 | real | 已注册用户+真实后端 | 同 E1 | 同 E1（真实后端返回） | 集成环境/手动 |
| E2     | 登录失败边界 | mock | 错误密码 | 1.打开/login 2.填错误密码 3.提交 | 显示"密码错误"，停留/login | <项目测试框架> |
| E3     | 并发下单边界 | real | 库存=1（真实DB） | 1.两请求同时下单 | 仅1成功，1返回"售罄" | 集成环境/脚本 |
```

> 同一业务流程常拆 mock + real 两条（如 E1 mock / E1-r real）：mock 条快、CI 高频跑；real 条真实集成兜底。用 `-r` 后缀区分同一场景的两层用例。

### 字段规范

- **用例ID**：`E` + 数字。同一场景的 mock/real 两条用 `-r` 后缀区分（E1 mock / E1-r real）。
- **场景**：业务用例（用户视角），非技术操作。
- **测试层**（必填，`mock` 或 `real`）：见上方「核心原则四」。mock = 隔离外部依赖；real = 真实后端/数据/环境。决定该用例进 mock 验收组还是 real 验收组。
- **执行方式**（按项目实际测试栈适配，不写死某框架）：
  - `项目测试框架`：探测项目装了什么 E2E/前端测试框架（Playwright / Cypress / Puppeteer / Testing Library / 项目自研等），执行方式写实测探测到的命令。Playwright/Cypress 只是常见示例，不是默认。
  - `browser skill / MCP`：项目无 E2E 框架时，前端交互用例可调用 browser-automation **类** skill 或 CDP **类** MCP 驱动真实浏览器（Agent 主动发现当前环境有哪些 browser 类 skill/MCP，不限定具体名称）。注意这类手段**无 assertion 框架**——Agent 需自行解读截图/DOM 判定 pass/fail。
  - `手动`：无法自动化的场景（并发、物理设备等），写明手动验证步骤

### ⚠️ E2E / 前端测试栈探测（必做）

lite-plan 写 E2E 清单前 [MANDATORY] 探测项目**实际**的测试栈（不预设 Playwright）：

```
1. 扫描项目测试配置与依赖，确定实际用哪个框架：
   - 前端/E2E：playwright.config.* / cypress.config.* / puppeteer / package.json 里 testing-library 等
   - 后端/集成：项目实际用的测试框架（pytest / JUnit / go test / vitest / jest 等）
2. [MANDATORY] 扫描项目是否已有测试手册/策略文档，有则 read 对应功能章节复用，不从零探索：
   - 优先扫：根目录 `TEST-STRATEGY.md`（测试分层/mock 策略/回归基线 SSOT）、`docs/testing/`（若有，各功能 MOCK/非MOCK/E2E 操作手册）、`CLAUDE.md`/`AGENTS.md` 的「测试规范」章节
   - 复用内容：已有 data-testid 清单（避免重新发明 selector）、调用链/时序（fixture 怎么流转）、fixture/mock 数据位置、已知坑（mock 回显双匹配、收起态 v-if 时序、预填默认值等仅靠读组件代码无法发现的运行时行为）
   - 与本次改动的功能对应：若 docs/testing/ 有该功能的文档，E2E 用例的「执行方式」「前置」「预期值」直接复用其调用链和断言模式，标注来源；无对应文档时才从 fixture 对齐（见核心原则二）推导
3. 有框架 → E2E 用例的执行方式写「该框架的实际命令」（如探测到 Playwright 才写 npx playwright test ...）
4. 无 E2E 框架但需测前端交互 → 执行方式写「browser 类 skill / CDP 类 MCP 驱动」
   Agent 执行时主动发现当前环境可用的 browser 类 skill/MCP（不写死名称）
5. 都不适用 → 在 plan.md 显式标注，执行方式写手动验证步骤
   并提示用户：如需可回归 E2E，建议引入项目适配的测试框架
```

> 不假设项目用某特定框架。lite 只负责**设计用例 + 写明项目实际的执行命令**，框架由项目自备。不同项目测试栈差异大（TS 项目可能 vitest+Playwright，Java 项目可能 JUnit，Python 项目可能 pytest），泛化适配而非写死。
>
> **复用优先于重新探索**：成熟项目往往已沉淀测试手册（docs/testing/）记录历史踩坑——这些经验（如 mock 会回显 user 输入导致 getByText 双匹配、contenteditable 不触发原生 input 事件、组件收起态 v-if 导致 toBeVisible 时序竞争）仅靠读组件源码无法发现，必须读测试手册。第 2 步的 read 是设计期规避历史坑的最高 ROI 动作。

### ⚠️ E2E 用例可执行性自检（必做）

设计了执行不了的用例 = **虚假安全感**（比没有用例更危险）。每条 E2E 用例必须标注「执行前提」，并自检在当前降级环境下是否真能执行：

- 每条 E2E 用例的「前置」列必须写明执行前提（需要什么：真实浏览器/特定视口尺寸/真实后端/超长内容 fixture/mock 数据）
- 自检：若执行前提在当前环境（无框架→手动 / mock 环境）下**无法满足**，必须二选一：
  - a) plan 里写明「该用例需补充 fixture/工具才能执行」（如超长内容 fixture、缩小视口）+ 标 `[执行前提待补]`
  - b) 拆解为可单测覆盖的逻辑断言 + 标注「交互层手动验证，逻辑层单测覆盖」

**常见陷阱**（plan 设计时就要预见）：

| 用例类型 | 在 mock/单测环境的可执行性 | 处理 |
|---------|-------------------------|------|
| 滚动/视口交互（如「上滚脱离锚定」） | ❌ happy-dom 无真实视口，mock 内容常小于视口无法制造滚动距离 | 标 `[执行前提待补:超长内容fixture]` 或拆为单测断言 + 手动 |
| 真实后端依赖（如「并发下单库存」） | ❌ mock 无并发 | 拆为单测断言 + real 层用例标 `[需集成环境]`（执行期由用户豁免或起本地集成环境，**禁止 AI 自标手动通过**） |
| 纯 DOM 断言（如「working 态全展开」） | ✅ happy-dom 可验 | 正常标项目测试框架/手动 |
| 强依赖浏览器原生 API（contenteditable / Selection / Range / TreeWalker） | ⚠️ happy-dom 支持有限，单测层行为失真（单测过 ≠ 真实 DOM 对） | 单测覆盖逻辑层断言 + 标「需集成层/手动验证真实 DOM」 |

> 实测案例：plan 设计了 E3-E5 滚动交互用例，执行时发现 mock 会话内容小于视口无法制造真实滚动距离，只能靠单测覆盖逻辑层——这在 plan 设计时就该预见并标注，而非执行时才发现。

## 边界覆盖要求

E2E 用例**必须覆盖**以下边界（基于业务用例推导，非穷举）：

- **正常路径**：主流程跑通（至少 1 条）
- **异常路径**：错误输入、权限不足、资源不存在（至少 1 条）
- **边界值**：空值、零值、最大值、并发竞争（至少 1 条）
- **状态转换**：涉及状态机的，覆盖关键转换路径

> "根据用例尽量覆盖各种边界"——不是写越多越好，而是**每个业务用例的 happy path + 至少一个失败 path**。

### 测试层覆盖要求（mock / real 各有）

E2E 用例除上述边界外，**必须两层都有覆盖**（见「核心原则四」）：

- **mock 层**：至少 1 条（关键业务流程的 mock 环境跑通，CI 高频回归主力）
- **real 层**：至少 1 条（真实后端/数据的集成验证；项目无真实环境则标 `[需集成环境]` 降级手动，**不可省略设计**）

> 同一业务流程的 mock + real 两条用例，验证的是不同性质的问题（逻辑正确性 vs 集成正确性），不能互相替代。只有 mock 层 = 默认「mock 过了真实就过」的危险假设。

## todo 映射（给 coding-execute 用）

测试用例 → todo 任务的映射规则（coding-execute 据此建 todo）：

| plan 清单条目 | 实现阶段 todo（isVerification=false） | 验收阶段 todo（isVerification=true） |
|--------------|-------------------------------------|--------------------------------------|
| 每条单测用例（U1, U2...） | 1 个「实现 U1: ...」 | 1 个「[验收] U1 全绿」 |
| 每条 mock 层 E2E（E1, E2...） | —（实现期不建） | 1 个「[验收-mock] E1 全绿」 |
| 每条 real 层 E2E（E1-r, E3...） | —（实现期不建） | 1 个「[验收-real] E1-r 全绿」 |
| 覆盖率 gate | — | 1 个「[验收] 覆盖率达标」 |
| mock 层回归 | — | 1 个「[验收-mock] 全量单测+mock E2E 全绿」 |
| real 层回归 | — | 1 个「[验收-real] 全量 real E2E 全绿」（最后） |

> 验证任务（isVerification=true）不可取消，必须 completed。这是"测试验收不是一个任务、要严格执行"的落地机制。
>
> **粒度铁律：每条 U*/E* 各自一个 todo，跨阶段亦然。** 实现阶段每条 U* 一个「实现」todo，验收阶段**再次**每条 U*/E* 各建一个「[验收] 全绿」todo——不打包成「U1-U{N} 全绿」一条。打包会掩盖单条失败（一条红则全标红，定位不到具体用例）。
>
> **测试层分组铁律：E2E 验收 todo 必须按 mock / real 分组**（`[验收-mock]` / `[验收-real]`），不能混成一堆。mock 层快、CI 跑，失败定位到逻辑问题；real 层慢、环境敏感，失败定位到集成问题。混为一组会掩盖哪层出问题，且 real 层环境依赖失败会携掣 mock 层回归的频率。末尾的 mock 层回归 + real 层回归也是两个独立 todo。
