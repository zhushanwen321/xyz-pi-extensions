# 交付物模板：non-functional-design.md + non-functional-design.html

> non-functional-design.md 的章节结构模板。本文件是格式起点，具体内容由 shared-loop 的 Step 1-5 产出。
> 7 维度详解见 `nfr-dimensions.md`。渲染 HTML 的规范见 `skills/xyz-harness-design-clarity/references/visual-deliverable.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
---
```

## 章节结构

```markdown
# 非功能性设计 — {主题}

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 | 方案A | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| #3 | 方案B | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ |

（✅ 无风险 / ⚠️ 有风险已缓解 / ❌ 不可接受需回退 / — 不适用+理由）

## 详细分析

### Issue #1: {标题} — 方案 A

#### 安全影响
#### 数据一致性影响
（7 个维度，不适用的写理由）

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|

## Prototype 验证记录
（如有 prototype 验证的副作用，记录结论——不是代码）
```
