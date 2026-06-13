# 5-Perspective Scenario Tracing Reference

每个视角的完整追踪模板和典型 gap 模式。

## Perspective 1: User Journey（用户视角）

### 追踪模板

```markdown
### P1: User Journey

#### OP-U01: {操作名}
- **Actor**: {A01: 角色}
- **Precondition**: {前置条件}
- **Main Path**:
  1. {用户动作} → {系统响应} [VERIFIED: {代码位置} 或 GAP]
  2. {用户动作} → {系统响应} [VERIFIED: ...]
  3. ... → 完成

- **Branches**:
  - **B1**: {分支条件描述}
    - When: {具体触发条件}
    - Path: {分支路径步骤}
    - [GAP G-XXX: {问题}]
  - **B2**: {另一个分支}
    - ...

- **Related**: E01({状态变化}), OP01, C01
```

### 强制检查项

对每个用户操作，必须回答：

- [ ] 成功后的下一步是什么？（继续/返回/结束）
- [ ] 中途放弃怎么办？（取消/返回/自动保存）
- [ ] 重复操作怎么办？（防重复提交/幂等）
- [ ] 权限不足怎么办？（提示/引导/隐藏操作）
- [ ] 操作超时怎么办？（loading 状态/重试/提示）

### 典型 gap 模式

| 模式 | 示例 gap |
|------|---------|
| 确认缺失 | "删除操作需要二次确认吗？" |
| 中间状态 | "表单填写一半离开页面，是否保存草稿？" |
| 并发操作 | "两个用户同时编辑同一条数据" |
| 权限边界 | "普通用户能看到这个按钮吗？" |
| 批量操作 | "可以一次删除多条吗？" |
| 排序/筛选 | "列表默认按什么排序？" |

---

## Perspective 2: Data Lifecycle（数据视角）

### 追踪模板

```markdown
### P2: Data Lifecycle

#### E01: {实体名}
- **Create**:
  - Triggered by: {OP01 by A01}
  - Conditions: {创建条件}
  - Initial state: {初始状态}
  - Validation: {创建时的校验}
  - Default values: {字段默认值}
  - [VERIFIED: {代码位置} 或 GAP]

- **Read**:
  - Who: {角色列表}
  - Access patterns: {按 ID / 按用户 / 列表 / 搜索}
  - Filtering: {支持哪些筛选条件}
  - Pagination: {分页策略}
  - [GAP G-XXX: {问题}]

- **Update**:
  - Who: {角色列表}
  - Mutable fields: {可修改的字段列表}
  - Immutable fields: {不可修改的字段列表}
  - Validation: {更新时的校验}
  - Partial update: {支持部分更新？PATCH？}
  - [GAP G-XXX: {问题}]

- **Delete / Archive**:
  - Who: {角色列表}
  - Strategy: {硬删除 / 软删除 / 归档}
  - Conditions: {删除条件}
  - Cascading: {级联影响——关联数据如何处理}
  - Recovery: {可恢复吗？恢复策略}
  - [GAP G-XXX: {问题}]

- **Lifecycle Chain**: {状态1} → {状态2} → ... → {终态}
```

### 强制检查项

对每个实体，必须回答：

- [ ] 创建时的唯一性约束是什么？
- [ ] 所有外键引用的完整性如何保证？
- [ ] 数据量增长后是否有分区/归档策略？
- [ ] 哪些字段是必填的？默认值是什么？
- [ ] 删除后，引用此数据的其他数据怎么处理？

### 典型 gap 模式

| 模式 | 示例 gap |
|------|---------|
| 级联删除 | "删除用户时，用户的订单怎么处理？" |
| 软删除查询 | "软删除的数据在列表中是否可见？" |
| 数据迁移 | "新增字段时，已有数据的默认值？" |
| 唯一性边界 | "唯一约束包含软删除的记录吗？" |
| 大量数据 | "分页超过 1000 条时的性能？" |

---

## Perspective 3: API Contract（接口视角）

### 追踪模板

```markdown
### P3: API Contract

#### OP-A01: {METHOD /path} — {描述}
- **Authentication**: {无需认证 / Bearer token / API key}
- **Input**:
  ```typescript
  {参数的 TypeScript 类型定义}
  ```
- **Output 200**:
  ```typescript
  {成功返回的类型定义}
  ```
- **Errors**:
  - `400`: {校验失败} — {具体条件} [GAP?]
  - `401`: {未认证} — {条件}
  - `403`: {权限不足} — {条件}
  - `404`: {资源不存在} — {条件}
  - `409`: {冲突} — {具体冲突类型} [GAP?]
  - `429`: {限流} — {阈值} [GAP?]
  - `500`: {服务端错误} — {降级策略} [GAP?]
- **Idempotency**: {是/否} — {机制}
- **Rate Limit**: {阈值} — {超限行为}
- **Side Effects**: {副作用列表}
- **Authorization**: {需要什么权限}
```

### 强制检查项

对每个接口，必须回答：

- [ ] 所有可能的错误码都定义了吗？（不只是 happy path）
- [ ] 是否幂等？如果不是，重复调用会怎样？
- [ ] 输入的边界值？（空字符串、null、极大值、负数、特殊字符）
- [ ] 分页参数的默认值和上限？
- [ ] 返回的数据量是否有上限？

---

## Perspective 4: State Machine（状态视角）

### 追踪模板

```markdown
### P4: State Machine

#### E01 States: {列出所有状态}

**合法转换：**

| From | To | Trigger | Guard | If Guard Fails | Side Effects |
|------|----|---------|-------|----------------|--------------|
| draft | pending | submit | items > 0 | [GAP: 提示什么？] | notify_admin |
| pending | approved | admin_approve | payment_verified | [GAP: 自动验证？] | send_email |
| ... | ... | ... | ... | ... | ... |

**非法转换处理：**

| Attempt | Expected Behavior | [GAP?] |
|---------|------------------|--------|
| 用户尝试从 draft 直接到 approved | 拒绝 + 提示 | — |
| 管理员批准已取消的订单 | [GAP: 提示什么？] | G-XXX |
| ... | ... | ... |

**中间状态可见性：**

| State | Visible to User? | Visible to Admin? | Display Text |
|-------|------------------|-------------------|--------------|
| draft | 是 | 是 | "草稿" |
| pending | 是 | 是 | "待审核" |
| ... | ... | ... | ... |
```

### 强制检查项

对每个状态机，必须回答：

- [ ] 每个状态的"停留时间"有限制吗？（超时自动转换？）
- [ ] 谁能看到什么状态？（可见性矩阵）
- [ ] 非法转换时用户看到什么？
- [ ] 状态回滚允许吗？（批准 → 退回修改）
- [ ] 有没有"僵尸状态"？（不可能到达或不可能离开的状态）

---

## Perspective 5: Failure Path（失败视角）

### 追踪模板

```markdown
### P5: Failure Path

#### F-{源操作}: {失败场景名}
- **Source**: {P1/OP-U01 Step 2} 或 {P3/OP-A01}
- **Failure Type**: {输入无效 | 状态冲突 | 依赖不可用 | 权限不足 | 并发冲突 | 资源耗尽 | 数据不一致}
- **Condition**: {具体触发条件}
- **Detection**: {系统如何检测到这个失败}
- **Recovery**:
  - Automatic: {自动重试策略} [GAP?]
  - Manual: {用户需要做什么}
  - Escalation: {什么情况下升级处理}
- **User Impact**: {用户看到什么、可以做什么}
- **Data Consistency**: {失败后的数据状态——是否需要补偿/回滚}
- **Logging/Monitoring**: {是否需要告警} [GAP?]
```

### 强制检查项

对 Perspective 1-4 中的每个操作，逐一追问：

- [ ] 网络断开怎么办？
- [ ] 上游服务超时怎么办？
- [ ] 数据库写入失败怎么办？
- [ ] 并发冲突怎么办？
- [ ] 部分成功部分失败怎么办？（事务一致性）
- [ ] 用户重复触发怎么办？

### 失败影响矩阵

```markdown
| Operation | Most Likely Failure | Impact | Recovery | GAP |
|-----------|-------------------|--------|----------|-----|
| Create Order | payment_timeout | 订单创建但未支付 | 自动重试 3 次 | G-XXX |
| Approve Order | concurrent_modification | 审核结果丢失 | 乐观锁重试 | — |
| ... | ... | ... | ... | ... |
```

