# 测试策略

> **always-current**。记录**测试策略**（金字塔/边界/门禁/约定），非每次的 test-matrix 堆叠。
> 每次 ⑥的 test-matrix 留在 `.xyz-harness/{主题}/`；coding-closeout 只把「不可回退基线」沉淀到此。
> 命名刻意区分 TEST-STRATEGY（策略）vs per-topic test-matrix（用例）。

## 测试金字塔与边界

{单元/集成/e2e 各自职责边界，谁测什么、不测什么}

## 覆盖率门禁

{门禁阈值、豁免规则、CI 集成方式}

## Mock 与测试数据约定

{mock 边界（什么该 mock/什么禁 mock）、测试数据策略、fixture 组织}

## 不可回退基线（Regression Baseline）

> coding-closeout 从 ⑥验收清单提炼：破坏即事故的用例。每条标溯源。
> 与 NFR.md「验证」字段双向引用。

### RB-1 {基线名}  [from: {topic}]

- **用例来源**：⑥验收清单 {ID}
- **断言**：{一句话}
- **破坏即**：{事故级别，如「资金重复扣款」/「用户数据泄露」}
- **关联约束**：NFR {S-1 / C-2 / ...}
