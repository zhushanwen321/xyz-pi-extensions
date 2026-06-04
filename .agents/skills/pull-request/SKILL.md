---
name: pull-request
description: >-
  提交 Pull Request。触发词："提交 PR"、"创建 PR"、"push"、"提交代码"、
  "pr-worktree"。仅用于 xyz-pi-extensions 项目。
---

# Pull Request

## 前提

当前在 worktree 目录中，有未提交的变更。

## 步骤

### 1. pre-merge 验证

```bash
# 全量类型检查
pnpm -r typecheck

# 全量 lint
pnpm -r lint

# 全量测试
pnpm -r test

# 构建检查（无需产物，只确认不报错）
pnpm -r build --if-present 2>/dev/null || true
```

**[MANDATORY] 零容忍**：任何失败都必须正面修复，不允许跳过。

`.githooks/pre-commit` 执行相同的检查（tsc + eslint + vitest + pi manifest 校验），pre-merge 验证应与 githook 对齐。

### 2. commit message

用户提供 commit message（或 zcommit 生成），填入 `$COMMIT_MSG`。PR title 也由用户提供后填入 `$PR_TITLE`。

### 3. push + PR

```bash
# commit
git add -A
git commit -m "$COMMIT_MSG"

# push
git push origin HEAD

# 创建 PR
gh pr create --title "$PR_TITLE" --body "$PR_BODY" --base main
```

## 项目特化

- 验证覆盖所有子包（`pnpm -r`）
- PR 中应包含 changeset 文件（`pnpm changeset` 创建）
- 新增/修改 SKILL.md 时用本目录的 `validate-skill-yaml.py` 校验 frontmatter
- 新增/修改 extensions.yaml 时用本目录的 `validate-extensions-yaml.py` 校验

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
