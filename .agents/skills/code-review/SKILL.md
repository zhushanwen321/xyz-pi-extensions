---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 xyz-pi-extensions 项目。
---

# Code Review

## 审查范围

当前 worktree 相对于 main 的所有变更：
```bash
git diff main...HEAD --stat
git diff main...HEAD
```

## 审查维度

### 1. 业务逻辑
- 变更是否解决声明的问题
- 边界条件是否覆盖
- 是否有回归风险

### 2. monorepo 影响
- 子包间依赖是否正确（`workspace:*` 引用）
- 是否引入循环依赖
- 公共 API 变更是否影响下游包

### 3. 类型安全
- 新增代码是否完整类型标注
- 禁止 `any`，用 `unknown` 或具体类型

### 4. 扩展接口
- 新增 tool/command 的 schema 是否完整
- 向后兼容性

### 5. 测试
- 新增逻辑是否有对应测试
- 测试用例是否覆盖边缘情况

### 6. 代码质量（fallow 扫描）

在人工审查前，先运行 fallow 静态分析获取基线数据：

```bash
# 检查 fallow 是否已安装（包名是 fallow，不是 @sourcemeta/fallow）
which fallow 2>/dev/null || npm install -g fallow

# 审计变更文件的代码质量（dead-code + complexity + duplication）
fallow audit --base main --format json --quiet

# 若只需复杂度热点
fallow health --top 10 --format json --quiet

# 若只需重复代码
fallow dupes --format json --quiet
```

关注以下指标：
- **复杂度热点**：新增函数是否超过 80 行 / 15 圈复杂度
- **重复代码**：是否与现有代码有重复
- **未使用导出**：新增的类型/函数是否被使用
- **循环依赖**：是否引入新的循环引用

## 输出格式

```
## 总体评价
Pass / 需修改 / 阻塞

## fallow 扫描摘要
<复杂度、重复、未使用导出、循环依赖的统计>

## 发现的问题
| 严重程度 | 位置 | 问题 | 建议 |
|----------|------|------|------|

## 亮点
...
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
