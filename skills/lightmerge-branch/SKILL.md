---
name: lightmerge-branch
description: "Use when users want to merge multiple development branches into one test branch for integration testing, or mention lightmerge, lm, lightmerge-branch, 合并测试, or need to quickly deploy and verify multiple features together. Also use when users want to add or remove branches from a test merge configuration, or manage per-project branch merging setups."
user-invocable: true
argument-hint: "[add <branch>] [remove <branch>] [list] [init [branch-name]] [rebuild] [push]"
model: sonnet
---

# Lightmerge Branch

将多个开发分支合并到一个临时集成分支，用于快速集成测试。每次操作都从 base branch 全量重建，保证状态干净。

## 【强制】执行前前置条件

**在执行任何 lightmerge 操作前（`add`、`remove`、`rebuild`），必须先完成以下检查：**

1. 检查当前分支是否有未提交的更改：`git status --porcelain`
2. 如果有未提交的更改，先提醒用户，然后提交并推送当前分支
3. 确认推送成功后，再执行 lightmerge 操作

**示例流程：**
```
检测到当前分支 feature/login 有未提交的更改，先提交并推送：
git add -A && git commit -m "WIP: xxx" && git push
推送成功，继续执行 lightmerge 操作...
```

**仅 `init`、`list` 命令不需要此前置检查。**

## 【强制】脚本执行约束

**所有 lightmerge 相关的 git 操作必须且只能通过 `lightmerge.sh` 脚本执行。**

禁止事项：
- 禁止手动执行 `git merge`、`git checkout`、`git push` 等 git 命令来完成 lightmerge 操作
- 禁止绕过脚本直接操作 lightmerge 分支
- 禁止修改 lightmerge 配置文件（必须通过脚本命令修改）

唯一例外：冲突解决阶段，允许手动 `git add` 标记冲突已解决文件（详见"冲突处理流程"）。

## 快速参考

| 命令 | 用途 |
|------|------|
| `init [branch-name]` | 首次使用，配置 base_branch、remote 和 lightmerge 分支名（默认 `lightmerge`） |
| `add <branch>` | 添加分支到合并列表并重建 |
| `remove <branch>` | 移除分支并重建 |
| `rebuild` | 从 base branch 全量重建 lightmerge 分支 |
| `continue` | 冲突解决后继续合并（从断点恢复） |
| `abort` | 中止当前重建并切回原分支 |
| `list` | 查看当前配置和分支状态（默认命令） |
| `push` | 手动推送到远端 |

## 配置文件

路径：`~/.claude/lightmerge-data/<project-name>/lightmerge-branches.json`

```json
{
  "base_branch": "main",
  "lightmerge_branch_name": "lightmerge",
  "remotes": ["origin"],
  "branches": []
}
```

- `lightmerge_branch_name` 默认为 `lightmerge`，可在 `init` 时通过第四个参数自定义（如 `my-test-branch`）
- `remotes` 支持多个远端，如 `["origin", "user-fork"]`
- 首次使用 `init` 自动生成，后续只需 add/remove 分支

### 【重要】首次 init 前必须预览配置

**当配置文件不存在时，执行 `init` 前必须先向用户展示拟生成的配置并等待确认：**

1. 收集信息：从 git 仓库自动推断 `project_name`（目录名）、`base_branch`（检测 main/master）、`remote`（检测 origin）
2. 展示预览：用代码块格式向用户展示即将生成的完整 JSON 配置
3. 逐项说明每个字段的来源和默认值，方便用户判断是否需要修改
4. 询问用户是否有修改意见
5. 用户确认后才执行 `init` 命令；如有修改则调整参数后再执行

**预览示例（Claude 输出格式）：**

```
即将为项目 my-project 生成以下 lightmerge 配置：

​```json
{
  "base_branch": "main",
  "lightmerge_branch_name": "lightmerge",
  "remotes": ["origin"],
  "branches": []
}
​```

字段说明：
- base_branch: "main" — 从 git remote HEAD 自动检测
- lightmerge_branch_name: "lightmerge" — 默认值，可自定义
- remotes: ["origin"] — 从 git remote 自动检测

如有修改请告知，确认无误后将执行 init。
```

## 执行方式

所有 git 操作通过脚本执行（`scripts/lightmerge.sh`，相对于 SKILL.md 所在目录）：

```bash
bash <skill-dir>/scripts/lightmerge.sh <command> [project-name] [args...]
```

`project-name` 默认取 git 仓库目录名，可省略。

## 常见问题

| 场景 | 处理方式 |
|------|----------|
| 合并冲突 | 脚本暂停，输出结构化冲突信息（退出码 10），LLM 尝试解决后执行 `continue` |
| 分支不存在 | 跳过并警告，不阻断其余分支合并 |
| 推送失败 | 输出错误信息，本地 lightmerge 分支不受影响 |
| 首次使用 | 先运行 `init` 配置 base_branch 和 remote，再 `add` 分支 |

## 示例

**初始化 + 添加分支：**

```
> /lm init
配置文件已创建: ~/.claude/lightmerge-data/my-project/lightmerge-branches.json

> /lm init main origin test-integration
# 使用自定义分支名 test-integration

> /lm add feature/login
[1/1] 合并 feature/login... 成功
推送到 origin... 成功
```

**查看状态：**

```
> /lm
Base branch: main | Remotes: origin
合并列表 (2): feature/login, feature/dashboard
分支状态: 存在于本地和 origin
```

## 冲突处理流程

当合并出现冲突时，脚本会暂停并输出结构化冲突信息（退出码 10）。处理流程如下：

### 第一步：识别冲突

脚本输出格式如下：
```
=== CONFLICT DETECTED ===
CONFLICT_BRANCH: feature/login
CONFLICT_FILES:
  src/auth/login.ts
  src/utils/helpers.ts
REMAINING_BRANCHES:
  feature/dashboard
  feature/api-refactor
ORIGINAL_BRANCH: feature/my-work
============================
```

### 第二步：LLM 尝试解决冲突

1. 读取每个冲突文件的内容，理解冲突双方的代码
2. 根据两个分支的功能意图，选择合理的合并策略：
   - 如果两个分支修改了不同部分 → 合并两边的修改
   - 如果修改了同一部分但逻辑兼容 → 智能合并
   - 如果逻辑冲突无法自动判断 → 停止，询问用户
3. 编辑冲突文件，解决所有冲突标记（`<<<<<<<`、`=======`、`>>>>>>>`）
4. 执行 `git add` 标记所有已解决的文件

### 第三步：继续合并

```bash
bash <skill-dir>/scripts/lightmerge.sh continue
```

脚本会自动提交冲突解决，然后继续合并剩余分支。

### 第四步：无法解决时

如果冲突涉及业务逻辑歧义、不明确的功能取舍等无法自动决策的场景：
1. 向用户展示冲突文件内容和双方修改
2. 说明每个冲突点的分歧
3. 提供你的建议（如果有的话）
4. 等待用户决策

用户决策后，按其意图解决冲突，然后执行 `continue`。

### 中止重建

如果用户决定放弃当前重建（不解决冲突）：

```bash
bash <skill-dir>/scripts/lightmerge.sh abort
```

脚本会中止重建，切回原分支，不影响已有代码。
