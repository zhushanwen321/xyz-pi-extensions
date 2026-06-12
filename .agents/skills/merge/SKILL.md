---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-pi-extensions 项目。
---

# Merge

## 8 阶段流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-add-extension`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

```bash
CURRENT_WT=$(basename $(pwd))  # 如果从 feature worktree 的上级目录调用
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace
bash ~/.agents/skills/merge-worktree/stages/0-init.sh $CURRENT_WT patch
```

### 阶段 1: 本地验证
```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```

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
bash <dev-link-skill-dir>/link-npm.sh <name>
```

其中 `<dev-link-skill-dir>` 解析为 dev-link skill 所在目录。

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
```bash
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh
```

### 阶段 3: Post-merge CI
```bash
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

### 阶段 4: 版本 bump + 发布（项目特化）

本项目使用 changeset 独立版本模式，每个 extension 版本号各不相同。**不能委托全局 4-publish.sh**——需要 AI 逐步执行，精确控制每个子包的版本号。

#### 4.1 检查 changeset 文件

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/main
find .changeset -name '*.md' ! -name README.md ! -name config.json
```

确认本次 PR 包含的 changeset 文件，以及每个文件对应的子包和版本类型。

⚠️ 如果无 changeset 文件 → 子包不会 bump → `pnpm changeset publish` 无新包可发。必须回 feature 分支创建 changeset。

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

```bash
git add -A
git commit -m "chore: bump versions (root $CURRENT_ROOT → $NEW_VER)" 2>/dev/null || echo "无变更需提交"
TAG="v$NEW_VER"
git tag "$TAG" 2>/dev/null || echo "Tag $TAG 已存在"
git push origin HEAD:refs/heads/main --tags
```

#### 4.5 同步远程

```bash
git fetch origin main
git merge --ff-only origin/main 2>&1 || true
```

### 阶段 5: 等待 CI 发布完成

**[MANDATORY] npm 发布由 GitHub Actions 自动完成，禁止在本地执行 `pnpm changeset publish` 或 `npm publish`。**

发布流程：
1. 阶段 4.4 推送 `v*` tag → 触发 `.github/workflows/release.yml`
2. CI 自动执行 `pnpm changeset publish`（通过 `NPM_TOKEN` secret 认证）
3. CI 自动创建 GitHub Release（`softprops/action-gh-release`）

等待 CI 完成后，进入阶段 6 验证。

⚠️ **新包首次发布**：如果本次包含全新的 npm 包（之前从未发布过），需要确认 `NPM_TOKEN` 对应的 npm 账号在 `@zhushanwen` scope 下有发布权限。首次需要手动在 npm 网站创建包或用 `npm publish --access public`（需先 `npm login`）。

### 阶段 6: 交付物验证（项目特化）

确认 CI 发布成功后验证：

```bash
for f in extensions/*/package.json shared/*/package.json; do
  PKG_NAME=$(node -p "require('$f').name" 2>/dev/null)
  PKG_VER=$(node -p "require('$f').version" 2>/dev/null || echo "?")
  if [ -n "$PKG_NAME" ]; then
    npm view "$PKG_NAME@$PKG_VER" version 2>/dev/null && \
      echo "  ✅ $PKG_NAME@$PKG_VER" || echo "  ❌ MISSING: $PKG_NAME@$PKG_VER"
  fi
done
```

也可通过 GitHub Actions 页面确认 release workflow 是否成功：
```bash
gh run list --workflow=release.yml --limit=1
```

### 阶段 7: 清理
```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

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
- **新包首次发布**：需确认 npm scope 权限，可能需要手动 `npm login` + `npm publish --access public` 初始化
- **交付物**：npm registry 包 + GitHub Release（自动生成 release notes）
- **Dev-Link 清理 [MANDATORY]**：merge 前必须清理指向当前 worktree 的 symlink（阶段 1.5）。跳过会导致阶段 7 删除 worktree 后 symlink dangling，Pi 启动失败。使用 dev-link skill 的 `link-npm.sh` 恢复已有 extension；全新 extension 直接删除 symlink

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
