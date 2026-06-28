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

- gate 命令：`pnpm --filter <pkg> test -- --coverage`（或项目实际命令）
- 阈值：增量代码覆盖率 ≥ 60%
- gate 位置：列为开发阶段的独立 todo（isVerification=true），验收时执行
```

> 60% 是下限。关键逻辑（状态机、金额计算、权限）应追求更高覆盖。覆盖率工具按项目实际（vitest --coverage / jest --coverage）。

**gate 必须执行**：开发收尾不是"代码写完了"，而是"单测全绿 + 覆盖率≥60%"。不达标回 implementer 补测试。

## E2E 用例清单 Schema

```markdown
## E2E 用例清单

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1     | 用户登录主流程 | 已注册用户 | 1.打开/login 2.填表单 3.提交 | 跳转/profile，显示用户名 | playwright |
| E2     | 登录失败边界 | 错误密码 | 1.打开/login 2.填错误密码 3.提交 | 显示"密码错误"，停留/login | playwright |
| E3     | 并发下单边界 | 库存=1 | 1.两请求同时下单 | 仅1成功，1返回"售罄" | 手动/脚本 |
```

### 字段规范

- **用例ID**：`E` + 数字。
- **场景**：业务用例（用户视角），非技术操作。
- **执行方式**（关键，三选一）：
  - `playwright`：项目装了 Playwright（探测 `playwright.config.*` 存在）。命令如 `npx playwright test e2e/<id>.spec.ts`
  - `browser-automation`：用 browser-automation skill 驱动浏览器（连 CDP），适合调试型 E2E，但**无 assertion 框架**——agent 需自行解读截图/DOM 判定
  - `手动`：无法自动化的场景（并发、物理设备等），写明手动验证步骤

### ⚠️ E2E 框架探测（必做）

lite-plan 写 E2E 清单前 [MANDATORY] 探测项目是否有 E2E 框架：

```
检查 playwright: 项目根或子包是否有 playwright.config.{ts,js} 或 cypress.config.{ts,js}
  - 有 → E2E 用例写 playwright 执行命令（npx playwright test ...）
  - 无 → 在 plan.md 显式标注「项目无 E2E 框架」，E2E 用例的执行方式降级为：
         a) browser-automation skill 驱动（需 Chrome 9222 端口）
         b) 手动验证步骤
         并提示用户：建议安装 Playwright 以获得可回归的 E2E
```

> 不假设项目装了 E2E 框架。lite 只负责**设计用例 + 写明执行命令**，框架由项目自备。

## 边界覆盖要求

E2E 用例**必须覆盖**以下边界（基于业务用例推导，非穷举）：

- **正常路径**：主流程跑通（至少 1 条）
- **异常路径**：错误输入、权限不足、资源不存在（至少 1 条）
- **边界值**：空值、零值、最大值、并发竞争（至少 1 条）
- **状态转换**：涉及状态机的，覆盖关键转换路径

> "根据用例尽量覆盖各种边界"——不是写越多越好，而是**每个业务用例的 happy path + 至少一个失败 path**。

## todo 映射（给 lite-execute 用）

测试用例 → todo 任务的映射规则（lite-execute 据此建 todo）：

| plan 清单条目 | todo 任务 | isVerification |
|--------------|-----------|----------------|
| 每条单测用例（U1, U2...） | 1 个 todo「实现 U1: ...」 | false（实现阶段） |
| 覆盖率 gate | 1 个 todo「覆盖率≥60%」 | true（验收阶段） |
| 每条 E2E 用例（E1, E2...） | 1 个 todo「E2E E1: ... 全绿」 | true（验收阶段） |
| 整体回归 | 1 个 todo「全量单测+E2E 全绿」 | true（验收 Wave，最后） |

> 验证任务（isVerification=true）不可取消，必须 completed。这是"测试验收不是一个任务、要严格执行"的落地机制。
