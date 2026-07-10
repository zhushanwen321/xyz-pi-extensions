# 工程约束（NFR）

> **always-current**。每个主题 ④非功能性设计完成、代码验证落地后，由 **coding-closeout** 沉淀**经代码验证**的约束。
> 完整分析过程在 `.xyz-harness/{主题}/non-functional-design.md`。
> 每条约束必须四件套齐全（约束 / 为什么 / 验证 / 例外）；缺"验证" = 空头口号，check_closeout 报错。

## 安全

<!-- 前缀 S-*：待 coding-closeout 沉淀 -->

## 业务数据安全

<!-- 前缀 D-*：敏感字段脱敏规则、PII 处理边界、保留周期 -->

## 性能

<!-- 前缀 P-*：SLO、热路径预算、缓存不变式 -->

## 并发控制

### C-1 Session 隔离  [from: 基建]

- **约束**：扩展状态必须存在 `session_start` 重建的闭包变量或 `ctx.sessionManager` entries，禁止模块级 `let` 跨 session 共享
- **为什么**：同一 Pi 进程可能有多个 session，模块级变量会被所有 session 共享导致状态串
- **验证**：新代码 grep 无模块级可变状态；`todo` 扩展的 `let todos` 是已知违反（见 RISK-1）
- **例外**：无

## 稳定性·高可用

<!-- 前缀 R-*：降级策略、熔断阈值、重试边界 -->

## 编码规范

### CS-1 键码解析必须复用 SDK parseKey  [from: fix-ask-user-arrow-leak]

- **约束**：终端键码解析必须使用 `@mariozechner/pi-tui` 的 `parseKey()`，禁止自建正则/字符表解析
- **为什么**：parseKey 覆盖全终端协议（legacy/VT100/Kitty CSI u/modifyOtherKeys），自建解析会遗漏协议变体导致键码泄漏
- **验证**：`grep -c "import.*parseKey.*pi-tui" component.ts` === 1；`ls parse-key.ts` 无文件
- **例外**：无

### CS-2 handleInput 路由函数行数上限  [from: fix-ask-user-arrow-leak]

- **约束**：主输入路由函数（handleInput）≤ 40 行（去空行注释），复杂分支拆分为独立方法
- **为什么**：路由函数是编辑器的入口，过长会导致维护困难和测试覆盖盲区
- **验证**：`sed -n '/handleInput/,/^}/p' component.ts | grep -v '^$' | grep -v '^\s*//' | wc -l` ≤ 40
- **例外**：无

## 兼容性

<!-- 前缀 V-*：API 版本边界、数据迁移约束、向后兼容承诺 -->

## 可观测性

<!-- 前缀 O-*：必埋点清单、告警阈值、日志结构约定 -->

## 已知残余风险

> 跨主题累积。下次设计会先读这里，避免重复发现已知问题。

| ID | 风险 | 接受理由 | 监控方式 | 溯源 |
|----|------|---------|---------|------|
| RISK-1 | `todo` 扩展用模块级 `let todos`，多 session 时状态串 | 当前单 session 使用不会出问题 | 多 session 启用时重构为闭包内状态 | [from: 基建] |
| RISK-2 | `handleEditorInput` fallback 守卫依赖 StdinBuffer 序列拆分假设（data 整体性） | StdinBuffer.extractCompleteSequences 源码确认混合输入 a+OSC+b 拆为三次 emit | 若 Pi 核心修改 StdinBuffer 拆分策略，回归测试 C-CSI-1~10 会红 | [from: fix-ask-user-unknown-csi-leak] |
