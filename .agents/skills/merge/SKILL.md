---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-pi-extensions 项目。
---

# Merge

> **范围与命名区分**：本 skill 是 xyz-pi-extensions 的**纯手动 8 阶段合并流程**，所有命令直接可执行，**不依赖任何外部脚本**。
> 另有一个随仓库分发的工具 `skills/merge-worktree/merge-and-publish.sh`（单体自动化脚本，一条命令跑完全程），那是**不同的执行方式**，不要与本 skill 混淆。本 skill 的价值在阶段 1.5（dev-link symlink 清理）、阶段 4（changeset 独立版本）等项目特化步骤——这些自动化脚本不覆盖。

> **执行约定（cwd 与 bash 块）**：
> - 阶段 4（bump + 发布）的所有命令默认在 `main` worktree（`/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main`）下执行。阶段 4.0 会执行一次 `cd` 确认进入该目录，后续 4.1-4.4 的脚本使用相对路径（`./package.json`、`.changeset`）。
> - **每个独立的 bash 代码块是一个独立 shell**——环境变量和 cwd **都不跨块持久**。因此：阶段 4.4 的脚本从 `package.json` 重新读版本号（不依赖 4.3 的变量）；如果执行环境的 bash 工具不持久化 cwd，需在每个使用相对路径的块开头补 `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main`。
> - 阶段 3/5 的 `gh run watch` 命令用绝对路径 `git -C <path>` 读取 SHA，不依赖 cwd。

## 8 阶段流程

### 阶段 0: 前置确认

手动流程无脚本初始化。确认以下前置条件后进入阶段 1：

- 当前位于 **workspace root**（`/Users/zhushanwen/Code/xyz-pi-extensions-workspace`），不在 feature worktree 内（阶段 7 会删 worktree）
- feature 分支的 PR 已创建且为 open 状态（`gh pr view <num> --json state`）
- 已确定版本类型（patch / minor / major），本次 PR 包含对应 changeset 文件
- `main` worktree 可用（阶段 4 在 `$WS_ROOT/main` 内执行 bump/tag/push）

### 阶段 1: 本地验证

在 feature worktree 内执行全量检查（与 `.githooks/pre-commit` 对齐）：

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/<feature-worktree>
pnpm -r typecheck   # 全量 tsc --noEmit
pnpm -r lint        # 全量 eslint
pnpm -r test        # 全量 vitest
```

**[MANDATORY] 零容忍**：任何失败必须正面修复，不允许跳过。三项均 exit 0 方可继续。

### 阶段 1.5: Dev-Link Symlink 清理 [MANDATORY]

检查并清理指向当前 worktree 的 extension symlink。**跳过此步骤会导致阶段 7 删除 worktree 后 symlink dangling，Pi 无法启动。**

#### 1.5.1 列出本次 PR 变更的 extension

```bash
git diff --name-only main...HEAD -- 'extensions/*' | cut -d/ -f2 | sort -u
```

记录变更的 extension 列表，用于后续判断哪些是全新 extension。

#### 1.5.2 检测指向当前 worktree 的 symlink

```bash
WT_PATH="$(pwd)"
for link in ~/.pi/agent/extensions/*/; do
  [ -L "${link%/}" ] || continue
  target="$(readlink "${link%/}")"
  if [[ "$target" == "$WT_PATH"* ]]; then
    name="$(basename "${link%/}")"
    echo "  symlink: $name → $target"
  fi
done
```

如果没有检测到指向当前 worktree 的 symlink，跳过后续步骤。

#### 1.5.3 清理 symlink

对每个检测到的 symlink，按 npm 可用性分别处理：

**已发布的 extension**（`npm view` 返回版本号）：

```bash
bash /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/.agents/skills/dev-link/link-npm.sh <name>
```

`dev-link` skill 随仓库分发，所在目录为 `<repo>/.agents/skills/dev-link`；在当前项目即解析为上面的绝对路径。

**全新 extension**（`npm view` 404）：

```bash
SHORT="<name>"
rm -f ~/.pi/agent/extensions/$SHORT
# 清理 settings.json 中的 local 条目
SETTINGS="$HOME/.pi/agent/settings.json" SHORT_CHECK="$SHORT" node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.env.SETTINGS,'utf-8'));
  const key = 'extensions/' + process.env.SHORT_CHECK;
  if (s.packages && s.packages.includes(key)) {
    s.packages = s.packages.filter(p => p !== key);
    fs.writeFileSync(process.env.SETTINGS, JSON.stringify(s, null, 2) + '\n');
  }
"
echo "  已删除 symlink: $SHORT (全新 extension，npm 未发布)"
```

#### 1.5.4 验证清理结果

```bash
WT_PATH="$(pwd)"
found=0
for link in ~/.pi/agent/extensions/*/; do
  [ -L "${link%/}" ] || continue
  target="$(readlink "${link%/}")"
  if [[ "$target" == "$WT_PATH"* ]]; then
    echo "  ⚠️ 未清理: $(basename "${link%/}") → $target"
    found=1
  fi
done
[ $found -eq 0 ] && echo "✓ 清理完成，无残留 symlink"
```

如果仍有残留，**必须手动处理后再继续**。

### 阶段 2: PR CI + 合并

本项目 `ci.yml` 在 PR 上自动跑（触发：`pull_request`）。等 CI 通过后用 merge commit 合并（保护 main 历史）：

```bash
# 等 PR 上的 ci.yml 跑完（非必须，可直接 merge，GitHub 会阻断未绿 CI）
gh pr checks <PR_NUM> --watch

# merge commit 合并并删除远程分支（绝不用 squash）
gh pr merge <PR_NUM> --merge --delete-branch
```

### 阶段 3: Post-merge CI

合并后 `ci.yml` 在 main 上再跑一次（触发：`push: branches:[main]`）。等它通过再 bump 版本，避免发布基于未绿的 main：

```bash
# 阶段 2 的 gh pr merge 只更新远程 main，不更新本地 refs/remotes/origin/main。
# 必须先 fetch，否则 rev-parse origin/main 拿到的是合并前的旧 SHA → 匹配到合并前的 CI run。
git -C /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main fetch origin main
# 拿到合并后 main 的最新 commit SHA（用于精确过滤本次触发的 CI run）
MAIN_SHA=$(git -C /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main rev-parse origin/main)
# GitHub 对新触发的 run 有数秒传播延迟，短暂等待后查询
sleep 5
RUN_ID=$(gh run list --workflow=ci.yml --branch main --commit "$MAIN_SHA" --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

⚠️ `gh run watch` 默认只要 run 结束就退出 0，**必须加 `--exit-status`** 才会在 CI 失败时返回非 0。用 `--commit "$MAIN_SHA"` 过滤是为了避免拿到上一次 main 的 CI run（run list 有传播延迟，见阶段 5 的同类说明）。

### 阶段 4: 版本 bump + 发布（项目特化）

本项目使用 changeset 独立版本模式，每个 extension 版本号各不相同。**不能委托全局 4-publish.sh**——需要 AI 逐步执行，精确控制每个子包的版本号。

#### 4.0 同步本地 main（bump 前置条件）

阶段 2 的 `gh pr merge` 只更新了**远程** main；本地 `/main` worktree 不会自动同步。必须在 bump 之前先拉取，否则 changeset 文件不在本地、`pnpm changeset version` 无东西可消费：

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
git fetch origin main
git merge --ff-only origin/main
```

`--ff-only` 失败说明本地 main 与远程分叉（通常是本地混入了未推送的提交），**必须人工排查**，禁止用 `|| true` 吞掉错误后继续 bump。

#### 4.1 检查 changeset 文件

```bash
find .changeset -name '*.md'
```

确认本次 PR 包含的 changeset 文件，以及每个文件对应的子包和版本类型。

⚠️ 如果无 changeset 文件 → 子包不会 bump → `pnpm changeset publish` 无新包可发。此时 feature 分支已被阶段 2 删除，补救方式：在当前本地 main 上用 `pnpm changeset`（交互式）或手写 `.changeset/<slug>.md`（格式见下方）创建 changeset，然后再跑 4.2 的 `pnpm changeset version`。创建后务必验证目标子包版本号确实变化。

**changeset 文件格式**（key 必须是 `package.json` 的 `name` 全名，不是目录名；版本类型 `patch`/`minor`/`major`）：

```markdown
---
"@zhushanwen/pi-<name>": minor
---

一句话描述本次变更。
```

示例（`@zhushanwen/pi-rename-session` 的首次发布 changeset）：

```markdown
---
"@zhushanwen/pi-rename-session": minor
---

New extension: auto-rename sessions after the first turn.
```

写错包名 key 会静默不 bump —— 创建后务必用 `pnpm changeset version` 验证该包版本号确实变化。

#### 4.2 消费 changeset

```bash
pnpm changeset version
```

执行后逐一验证每个子包的新版本号：

```bash
for f in extensions/*/package.json shared/*/package.json; do
  PKG_NAME=$(node -p "require('./$f').name" 2>/dev/null)
  PKG_VER=$(node -p "require('./$f').version" 2>/dev/null)
  [ -n "$PKG_NAME" ] && echo "  $PKG_NAME → $PKG_VER"
done
```

确认版本号变化是否符合预期。如有子包未被 bump（changeset 遗漏），在此处补救。

#### 4.3 bump 根版本

```bash
CURRENT_ROOT=$(node -p "require('./package.json').version")
npm version patch --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")
echo "根版本: $CURRENT_ROOT → $NEW_VER"
```

#### 4.4 commit + tag + push

⚠️ **不要依赖上一个 bash 块的 `CURRENT_ROOT`/`NEW_VER` 变量** —— 每个独立的 bash 执行是独立 shell，环境变量不跨块持久。下面的脚本从 `package.json` 重新读取版本号，自包含。

⚠️ **不要用 `git commit ... 2>/dev/null || echo` 吞掉错误** —— 本仓库 `.githooks/pre-commit` 会跑全量 lint + typecheck（`core.hooksPath=.githooks`），hook 失败时 `git commit` 退出非 0。如果用 `2>/dev/null` 把 stderr 吞掉，agent 会看到"无变更需提交"而误以为提交成功，但实际 bump commit 没进 main，tag 却推了上去 → release.yml 在旧 main 上跑，发的是旧版本。

```bash
NEW_VER=$(node -p "require('./package.json').version")
TAG="v$NEW_VER"
git add -A
# 先检查是否有变更：无变更时 git commit 退出 1，这是正常情况
if git diff --cached --quiet; then
  echo "无变更需提交（版本已是 $NEW_VER 或 changeset 无改动）"
else
  # 有变更则提交；保留 stderr，让 pre-commit hook 错误可见
  git commit -m "chore: bump versions (root → $NEW_VER)"
fi
git tag "$TAG" 2>/dev/null || echo "Tag $TAG 已存在（如非预期请人工核对）"
git push origin HEAD:refs/heads/main --tags
```

如需在 bump commit 上跳过 pre-commit hook（如纯版本号变更不需要重跑全量检查），可用 `SKIP_LINT=1 git commit -m "..."` —— 但仅限紧急情况，且后续必须补跑 `pnpm -r typecheck && pnpm -r lint`。

### 阶段 5: 等待 CI 发布完成

**[MANDATORY] npm 发布由 GitHub Actions 自动完成，禁止在本地执行 `pnpm changeset publish` 或 `npm publish`。**

发布流程：
1. 阶段 4.4 推送 `v*` tag → 触发 `.github/workflows/release.yml`
2. CI 自动执行 `pnpm changeset publish`（通过 `NPM_TOKEN` secret 认证）
3. CI 自动创建 GitHub Release（`softprops/action-gh-release`）

**阻塞等待 release.yml 跑完**（release.yml 是 tag 触发，不在 branch 上，所以不能按 branch 过滤；用刚推的 tag 对应的 commit SHA 过滤）：

```bash
# ⚠️ 本块为独立 shell，$TAG 不跨块持久——必须从 package.json 重读版本号自行构造
NEW_VER=$(node -p "require('/Users/zhushanwen/Code/xyz-pi-extensions-workspace/main/package.json').version")
TAG="v$NEW_VER"
# 拿到刚推送的 tag 对应的 commit SHA，用于精确匹配本次触发的 release run
TAG_SHA=$(git -C /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main rev-parse "$TAG" 2>/dev/null \
  || echo "")
if [ -z "$TAG_SHA" ]; then
  echo "❌ 无法解析 tag $TAG 的 commit SHA，请人工核对 tag 是否已推送"
  exit 1
fi
# 轮询等待本次 tag 触发的 release run 出现（GitHub API 有传播延迟，不 fallback 到无过滤 list——
# 无过滤 list 会拿到上一次旧的 release run，误判完成）
RUN_ID=""
for i in $(seq 1 15); do
  RUN_ID=$(gh run list --workflow=release.yml --commit "$TAG_SHA" --limit=1 --json databaseId -q '.[0].databaseId' 2>/dev/null)
  [ -n "$RUN_ID" ] && break
  echo "等待 release run 出现...（$((i*2))s）"
  sleep 2
done
if [ -z "$RUN_ID" ]; then
  echo "❌ 30 秒内未发现 tag $TAG 对应的 release run，请到 GitHub Actions 页面人工检查"
  exit 1
fi
echo "Watching release run: $RUN_ID (tag=$TAG, sha=$TAG_SHA)"
gh run watch "$RUN_ID" --exit-status
```

**⚠️ 两处陷阱**：
1. `gh run watch` 默认只要 run 结束就退出 0，**必须加 `--exit-status`** 才会在 release 失败时返回非 0。否则 NPM_TOKEN 权限缺失等 CI 失败会被误判为成功，进阶段 6 时 `npm view` 拿到 404，误以为是 registry 延迟而反复重试。
2. `gh run list` 对刚触发的 run 有传播延迟（数秒）。推 tag 后立即查询可能返回**上一次** release run → watch 立即退出 → 误判完成。上面的轮询循环只接受 `--commit "$TAG_SHA"` 精确匹配的 run（最多等 30 秒），不做无过滤 fallback，从根上避免拿到旧 run。

必须等 release 成功后再进阶段 6 —— 否则 `npm view` 会因 npm registry 最终一致性延迟拿到 404，误判为发布失败。

⚠️ **新包首次发布**：`pnpm changeset publish` 配合根目录 `.npmrc` 的 `access=public`，能正确发布全新的 scoped 包（`@zhushanwen/*`），**无需手动 `npm publish`**。已验证案例：`@zhushanwen/pi-rename-session` 首次发布（0.2.0）完全由 changeset publish 完成。唯一前置条件是 `NPM_TOKEN` 对应的 npm 账号在 `@zhushanwen` scope 下有发布权限——这是 npm 账号层面的配置，与发布机制无关，权限缺失时 CI 会报 E403 Forbidden（而非 E403 "cannot publish over"）。

### 阶段 6: 交付物验证（项目特化）

确认 CI 发布成功后验证：

```bash
for f in extensions/*/package.json shared/*/package.json; do
  PKG_NAME=$(node -p "require('./$f').name" 2>/dev/null)
  PKG_VER=$(node -p "require('./$f').version" 2>/dev/null || echo "?")
  if [ -n "$PKG_NAME" ]; then
    # 重定向 stdout，只用退出码判断；版本号由下面的 echo 统一打印，避免 npm view 重复输出
    npm view "$PKG_NAME@$PKG_VER" version >/dev/null 2>&1 && \
      echo "  ✅ $PKG_NAME@$PKG_VER" || echo "  ❌ MISSING: $PKG_NAME@$PKG_VER"
  fi
done
```

⚠️ **registry 传播延迟**：刚发布完立即跑 `npm view` 可能因 npm registry 最终一致性拿到 404。如见 ❌，等待 30s 后重试本阶段脚本；持续 ❌ 才判定发布失败（届时应回阶段 5 确认 release run 是否真的成功）。

也可通过 GitHub Actions 页面确认 release workflow 是否成功：
```bash
gh run list --workflow=release.yml --limit=1
```

### 阶段 7: 清理

用 `remove-worktree` skill 清理 feature worktree（会检查分支已合并到 main）。或手动：

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace
git worktree remove <feature-worktree>   # 删 worktree 目录
git branch -d <branch-name>               # 删本地分支（远程分支阶段 2 已删）
```

**同步 main worktree（仅 main，不碰其他 worktree）**：

合并完成后，只在 `main` worktree 执行 fetch + ff-only merge，把远程 main 的最新状态拉到本地 main：

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
git fetch origin
git merge --ff-only origin/main
```

**[MANDATORY] 禁止在其他 worktree 里执行 pull/fetch+merge。** 其他 worktree（如长期持有的 feat/*、fix/* 工作分支）各有自己的跟踪分支，在它们里面 pull main 会把无关的 main 提交混入工作分支，造成分支历史污染和潜在的合并冲突。main 的更新由各 worktree 在需要时（如 rebase onto main）主动拉取，merge skill 不代劳。

**安全网：检查 dangling symlink**

```bash
for link in ~/.pi/agent/extensions/*/; do
  [ -L "${link%/}" ] || continue
  [ -e "${link%/}" ] || echo "  ⚠️ Dangling symlink: $(basename "${link%/}") → $(readlink "${link%/}")"
done
```

如有 dangling symlink，说明阶段 1.5 清理遗漏或 worktree 被其他途径删除。必须手动清理。

## 项目特化要点

- **版本管理**：changeset 独立版本，子包版本各不同
- **发布方式**：push tag `v*` → GitHub Actions (`release.yml`) 自动 `pnpm changeset publish` + GitHub Release
- **禁止本地发布**：`pnpm changeset publish` 和 `npm publish` 均由 CI 执行，本地只做 bump + tag + push
- **新包首次发布**：由 CI 的 `pnpm changeset publish` + 根 `.npmrc access=public` 自动完成，**无需本地 `npm publish`**（详见阶段 5）。唯一前置条件是 `NPM_TOKEN` 账号在 `@zhushanwen` scope 有发布权限
- **交付物**：npm registry 包 + GitHub Release（自动生成 release notes）
- **Dev-Link 清理 [MANDATORY]**：merge 前必须清理指向当前 worktree 的 symlink（阶段 1.5）。跳过会导致阶段 7 删除 worktree 后 symlink dangling，Pi 启动失败。使用 dev-link skill 的 `link-npm.sh` 恢复已有 extension；全新 extension 直接删除 symlink

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
