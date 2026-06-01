# YAML Frontmatter Guide

Description 是 YAML frontmatter 的一部分，格式错误会导致 Pi 启动报错。

## 格式选择

| 格式 | 适用场景 | 优势 |
|------|---------|------|
| `>-` 折叠块标量 | **推荐默认**，任何含冒号/引号/中文的 description | 无需转义、不会配对失败、可读性好 |
| 双引号 | 仅极短纯英文 description（无冒号/引号） | 紧凑 |
| plain string | **禁止** | 冒号被解析为 mapping key |

## `>-` 折叠块标量（推荐默认）

无转义负担，内部 `"` 直接写，不会因配对问题导致 `Missing closing "quote`：

```yaml
---
name: example-skill
description: >-
  当用户说"提交PR"、"创建PR"、"pr-worktree"时使用此 skill。
  支持参数：--style=simple|full。
user-invocable: true
---
```

注意 `>-` 的缩进：内容行必须比 `description:` 缩进至少一个空格（通常 2 空格），`user-invocable:` 回到与 `description:` 同一缩进级别表示 frontmatter 继续。

### `>-` 约束

1. **块标量内容内部不能包含单独一行的 `---`**（会被 YAML 解析为文档结束标记）
2. **块标量结束后必须是另一个 frontmatter 字段（如 `user-invocable:`）或 `---` 闭合标记**，不能紧跟 Markdown 正文
3. **`-` 表示折叠换行**：多行内容会被合并为单行（保留空格分隔），不影响实际效果

## 双引号（仅极短纯英文）

```yaml
---
name: example-skill
description: "Use when executing plans with independent tasks"
---
```

双引号内含 `"` 需转义为 `\"`，断行位置不当易配对失败 → 能用 `>-` 就用 `>-`。

## 禁止无引号 plain string

```yaml
# 错误 — 冒号被解析为 mapping key，YAML 解析失败
description: Gate check for harness. Trigger: run gate check.

# 正确
description: >-
  Gate check for harness. Trigger: run gate check.
```

## 常见错误

| 错误 | 现象 | 修复 |
|------|------|------|
| `description: "..."` 内含偶数个 `\"` 但断行位置不当 | `Missing closing "quote` | 改用 `>-` |
| `description: >-` 后紧跟 Markdown 标题 `# Skill` | frontmatter 解析错误 | 插入 `---` 闭合标记或另一个 frontmatter 字段 |
| `description: 触发词: "提交"` | `Nested mappings are not allowed` | 加双引号或改用 `>-` |
| `description: "` 开头但忘记闭合 | YAML parse error | 补全引号或改用 `>-` |

## 验证与自动修复

```bash
# 检查所有 skill
python3 scripts/validate-skill-yaml.py skills/*/SKILL.md

# 自动修复问题 description（双引号转义过多 → 转换为 >-）
python3 scripts/validate-skill-yaml.py --fix skills/*/SKILL.md
```
