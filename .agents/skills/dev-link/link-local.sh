#!/usr/bin/env bash
# link-local.sh — 卸载 npm 版本，安装 symlink 版本
# 用法: ./link-local.sh <package>
#   <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)
#
# 幂等安全：重复执行不会产生副作用，已是最新状态时直接跳过。
set -euo pipefail

PI_AGENT_DIR="$HOME/.pi/agent"
EXTENSIONS_DIR="$PI_AGENT_DIR/extensions"
SETTINGS="$PI_AGENT_DIR/settings.json"
SCOPE="@zhushanwen"

# ── 颜色输出 ────────────────────────────────────────────
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

# ── 包名解析 ────────────────────────────────────────────
resolve_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then
		NPM_NAME="$input"
		SHORT_NAME="${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then
		SHORT_NAME="${input#pi-}"
		NPM_NAME="$SCOPE/pi-$SHORT_NAME"
	else
		SHORT_NAME="$input"
		NPM_NAME="$SCOPE/pi-$input"
	fi
}

# ── 检查 symlink 是否存在且指向正确 ──────────────────────
is_symlink_correct() {
	local short="$1"
	local target="$2"
	[ -L "$EXTENSIONS_DIR/$short" ] && [ "$(readlink "$EXTENSIONS_DIR/$short")" = "$target" ]
}

# ── 检查 local path 是否已注册到 settings.json ───────────
is_local_registered() {
	local short="$1"
	node -e "
		const s = JSON.parse(require('fs').readFileSync(process.env.SETTINGS,'utf-8'));
		process.exit(s.packages?.includes('extensions/' + process.env.SHORT_CHECK) ? 0 : 1);
	" 2>/dev/null
}

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	if [ $# -ne 1 ]; then
		echo "用法: $0 <package>"
		echo "  <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)"
		exit 1
	fi

	resolve_name "$1"
	WORKTREE_PKG="$(pwd)/extensions/$SHORT_NAME"
	EXT_PATH="$EXTENSIONS_DIR/$SHORT_NAME"
	NPM_ENTRY="npm:$NPM_NAME"

	echo "==> 切换 $SHORT_NAME → local symlink"

	# ── 前置检查 ──
	if [ ! -d "$WORKTREE_PKG" ]; then
		red "✗ 当前 worktree 找不到扩展目录: $WORKTREE_PKG"
		echo "   确保在 xyz-pi-extensions 的正确 worktree 根目录执行"
		exit 1
	fi
	if [ ! -f "$WORKTREE_PKG/package.json" ]; then
		red "✗ 扩展目录缺少 package.json: $WORKTREE_PKG/package.json"
		exit 1
	fi

	# ── 幂等检查：已是目标状态 ──
	if is_symlink_correct "$SHORT_NAME" "$WORKTREE_PKG" && SHORT_CHECK="$SHORT_NAME" is_local_registered "$SHORT_NAME"; then
		green "✓ 已完成，无需操作 (symlink → $WORKTREE_PKG)"
		exit 0
	fi

	# ── 步骤 1: 卸载 npm 版本（settings + node_modules 都要清理）──
	# 无条件执行 pi uninstall，避免 node_modules 残留导致 tool conflict
	echo "  卸载 npm 版本: $NPM_ENTRY"
	pi uninstall "$NPM_ENTRY" 2>&1 | sed 's/^/    /' || true

	# 兜底：pi uninstall 可能不删 node_modules 物理目录
	local npm_dir="$HOME/.pi/agent/npm/node_modules/$NPM_NAME"
	if [ -d "$npm_dir" ]; then
		echo "  清理 node_modules 残留: $npm_dir"
		rm -rf "$npm_dir"
	fi

	# ── 步骤 2: 清理旧 symlink（不删普通目录）──
	if [ -L "$EXT_PATH" ]; then
		rm -f "$EXT_PATH"
		echo "  删除旧 symlink: $EXT_PATH"
	elif [ -e "$EXT_PATH" ]; then
		red "✗ $EXT_PATH 存在但不是 symlink，请手动处理"
		exit 1
	fi

	# ── 步骤 3: 创建 symlink ──
	mkdir -p "$EXTENSIONS_DIR"
	ln -s "$WORKTREE_PKG" "$EXT_PATH"
	echo "  创建 symlink: $EXT_PATH → $WORKTREE_PKG"

	# ── 步骤 4: 注册到 settings.json ──
	# 用 pi install 注册本地路径（幂等：如果已注册会覆盖）
	pi install "$EXT_PATH" 2>&1 | sed 's/^/    /'

	echo ""
	green "✓ 完成: $SHORT_NAME → local symlink"
	echo "  重启 Pi 生效。验证方式: 重启后检查 [Extensions] 列表包含 $SHORT_NAME"
}

main "$@"
