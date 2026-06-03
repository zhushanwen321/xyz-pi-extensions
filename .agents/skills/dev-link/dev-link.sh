#!/usr/bin/env bash
# dev-link.sh — Pi 扩展开发链接管理
# 在 npm 安装和本地 symlink 之间切换，用于开发调试
#
# 用法:
#   dev-link.sh <package>          # 卸载 npm → symlink 到当前 worktree
#   dev-link.sh <package> --npm    # 删除 symlink → 恢复 npm 安装
#   dev-link.sh --list             # 列出所有 @zhushanwen/pi-* 包的状态
#
# <package> 可以是短名 (model-switch)、pi-前缀 (pi-model-switch)
#           或 npm 全名 (@zhushanwen/pi-model-switch)

set -euo pipefail

PI_AGENT_DIR="$HOME/.pi/agent"
SETTINGS="$PI_AGENT_DIR/settings.json"
EXTENSIONS_DIR="$PI_AGENT_DIR/extensions"
NPM_DIR="$PI_AGENT_DIR/npm/node_modules"
SCOPE="@zhushanwen"

# ── 解析包名 ────────────────────────────────────────────

resolve_name() {
	local input="$1"
	# npm 全名: @zhushanwen/pi-xxx
	if [[ "$input" == "$SCOPE/"* ]]; then
		NPM_NAME="$input"
		SHORT_NAME="${input#$SCOPE/pi-}"
		return
	fi
	# pi-前缀: pi-xxx
	if [[ "$input" == pi-* ]]; then
		SHORT_NAME="${input#pi-}"
		NPM_NAME="$SCOPE/pi-$SHORT_NAME"
		return
	fi
	# 短名: xxx
	SHORT_NAME="$input"
	NPM_NAME="$SCOPE/pi-$input"
}

# ── 检查当前状态 ─────────────────────────────────────────

status_of() {
	local short="$1"
	local npm="$2"
	local results=()

	# npm 包是否在 settings.json packages 中
	if node -e "
		const s = JSON.parse(require('fs').readFileSync('$SETTINGS','utf-8'));
		process.exit(s.packages?.includes('npm:$npm') ? 0 : 1);
	" 2>/dev/null; then
		results+=("npm-installed")
	fi

	# npm node_modules 是否存在
	[ -d "$NPM_DIR/$npm" ] && results+=("npm-cache")

	# symlink 是否存在
	local ext_path="$EXTENSIONS_DIR/$short"
	if [ -L "$ext_path" ]; then
		results+=("symlink→$(readlink "$ext_path")")
	fi

	if [ ${#results[@]} -eq 0 ]; then
		echo "not-configured"
	else
		echo "${results[*]}"
	fi
}

# ── 切换到本地 symlink ───────────────────────────────────

link_local() {
	local short="$1"
	local npm="$2"
	local pkg_dir
	pkg_dir="$(pwd)/extensions/$short"

	if [ ! -d "$pkg_dir" ]; then
		echo "❌ Package directory not found: $pkg_dir"
		echo "   Make sure you're in the correct worktree root."
		exit 1
	fi

	# 1. 用 pi uninstall 卸载 npm 包（同时清理 package.json + settings.json + node_modules）
	if [ -d "$NPM_DIR/$npm" ]; then
		echo "  running pi uninstall npm:$npm ..."
		pi uninstall "npm:$npm" 2>&1 | sed 's/^/    /'
	else
		echo "  npm package not installed, skipping uninstall"
	fi

	# 2. 创建 symlink
	mkdir -p "$EXTENSIONS_DIR"
	local ext_path="$EXTENSIONS_DIR/$short"
	if [ -L "$ext_path" ] || [ -e "$ext_path" ]; then
		rm -f "$ext_path"
		echo "  removed existing $ext_path"
	fi
	ln -s "$pkg_dir" "$ext_path"
	echo "  linked $ext_path → $pkg_dir"

	echo "✅ $short → local symlink (restart Pi to take effect)"
}

# ── 恢复 npm 安装 ────────────────────────────────────────

link_npm() {
	local short="$1"
	local npm="$2"

	# 1. 删除 symlink
	local ext_path="$EXTENSIONS_DIR/$short"
	if [ -L "$ext_path" ]; then
		rm -f "$ext_path"
		echo "  removed symlink $ext_path"
	else
		echo "  no symlink at $ext_path"
	fi

	# 2. 用 pi install 安装 npm 包（同时写 package.json + settings.json + npm install）
	echo "  running pi install npm:$npm ..."
	pi install "npm:$npm" 2>&1 | sed 's/^/    /'

	echo "✅ $short → npm (restart Pi to load)"
}

# ── 列表模式 ────────────────────────────────────────────

list_all() {
	echo "Pi extension status (worktree: $(pwd))"
	echo ""
	printf "%-20s %-35s %s\n" "SHORT" "NPM" "STATUS"
	printf "%-20s %-35s %s\n" "-----" "---" "------"

	# 从当前 worktree 的 extensions/ 扫描
	for pkg_dir in extensions/*/; do
		[ -f "$pkg_dir/package.json" ] || continue
		local short
		short="$(basename "$pkg_dir")"
		local npm
		npm="$(node -e "console.log(require('./$pkg_dir/package.json').name)" 2>/dev/null || echo "?")"
		[[ "$npm" != "$SCOPE"* ]] && continue  # 跳过非 @zhushanwen 包（如 types）
		local status
		status="$(status_of "$short" "$npm")"
		printf "%-20s %-35s %s\n" "$short" "$npm" "$status"
	done
}

# ── 主入口 ───────────────────────────────────────────────

main() {
	if [ $# -eq 0 ]; then
		echo "Usage: dev-link.sh <package> [--npm]  OR  dev-link.sh --list"
		echo ""
		echo "  <package>  Short name (model-switch), pi- prefix, or npm full name"
		echo "  --npm      Switch back to npm (remove symlink)"
		echo "  --list     Show status of all packages"
		exit 1
	fi

	if [ "$1" = "--list" ]; then
		list_all
		exit 0
	fi

	resolve_name "$1"

	echo "Package: $SHORT_NAME ($NPM_NAME)"
	echo ""

	if [ "${2:-}" = "--npm" ]; then
		link_npm "$SHORT_NAME" "$NPM_NAME"
	else
		link_local "$SHORT_NAME" "$NPM_NAME"
	fi
}

main "$@"
