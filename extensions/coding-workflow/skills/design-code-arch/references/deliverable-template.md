# 交付物模板：code-architecture.md + code-architecture.html

> 时序图详细模板见 `sequence-template.md`。Deep Module 词汇见 `deep-module-vocabulary.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: system-architecture.md, issues.md, non-functional-design.md
downstream: execution-plan.md
---
```

## 章节结构

```markdown
# 代码架构设计 — {主题}

## 1. 工程目录
（目录树 + 每目录职责 + 变化轴 + 依赖方向，见 sequence-template.md）

## 2. 包依赖图
（Mermaid graph + import 规则 + 循环依赖检测点）

## 3. API 契约

### 模块: {module-name}

#### 类: {ClassName}

| 方法 | 签名 | 返回 | 边界条件 | Spec/Issue 关联 |
|------|------|------|---------|----------------|

（按模块分组，所有公开方法）

## 4. 功能代码链路（时序图）

### 功能: {功能名}（关联 UC-N）

#### 时序图
（Mermaid sequenceDiagram — 入口到底层 + 异常路径）

#### 方法签名表
#### 数据流链
#### 关联（requirements/issues/nfr）

（每个关键功能一张）

## 5. Deep Module 设计决策

### 模块: {module}
- **Interface**: {入口方法}
- **Depth**: {deletion test 结论}
- **Seam**: {位置 + 有几个 adapter}
- **Port 决策**: {依赖分类 + 要不要 port}

## 6. 下游衔接

### 喂给 Step 6（执行计划）的部分
| 时序图 | 对应 Wave | 依赖的其他时序图 |
```
