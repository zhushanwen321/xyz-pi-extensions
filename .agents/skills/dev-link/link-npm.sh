#!/usr/bin/env bash
# link-npm.sh — 卸载 symlink 版本，安装 npm 版本
# 用法: ./link-npm.sh <package>
#   <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)
#
# 幂等安全：重复执行不会产生副作用，已是最新状态时直接跳过。
set -euo pipefail

PI_AGENT_DIR="$HOME/.pi/agent"
EXTENSIONS_DIR="$PI_AGENT_DIR/extensions"
SETTINGS="$PI_AGENT_DIR/settings.json"
NPM_DIR="$PI_AGENT_DIR/npm/node_modules"
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

# ── 检查 npm 是否已注册且缓存存在 ─────────────────────────
is_npm_ready() {
	local npm="$1"
	# settings.json 中有 npm: 条目
	SETTINGS="$SETTINGS" NPM_CHECK="$npm" node -e "
		const s = JSON.parse(require('fs').readFileSync(process.env.SETTINGS,'utf-8'));
		process.exit(s.packages?.includes('npm:' + process.env.NPM_CHECK) ? 0 : 1);
	" 2>/dev/null || return 1
	# node_modules 缓存存在
	[ -d "$NPM_DIR/$npm" ] || return 1
	return 0
}

# ── 检查 local path 是否已注册到 settings.json ───────────
is_local_registered() {
	local short="$1"
	SETTINGS="$SETTINGS" SHORT_CHECK="$short" node -e "
		const s = JSON.parse(require('fs').readFileSync(process.env.SETTINGS,'utf-8'));
		process.exit(s.packages?.includes('extensions/' + process.env.SHORT_CHECK) ? 0 : 1);
	" 2>/dev/null
}

# ── 检查 symlink 是否存在 ────────────────────────────────
has_symlink() {
	local short="$1"
	[ -L "$EXTENSIONS_DIR/$short" ]
}

# ── 从 settings.json 移除 local packages 条目 ──────────────
remove_local_entry() {
	local short="$1"
	SETTINGS="$SETTINGS" SHORT_CHECK="$short" node -e "
		const fs = require('fs');
		const path = process.env.SETTINGS;
		const s = JSON.parse(fs.readFileSync(path, 'utf-8'));
		const key = 'extensions/' + process.env.SHORT_CHECK;
		if (s.packages && s.packages.includes(key)) {
			s.packages = s.packages.filter(p => p !== key);
			fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
		}
	"
}

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	if [ $# -ne 1 ]; then
		echo "用法: $0 <package>"
		echo "  <package> = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)"
		exit 1
	fi

	resolve_name "$1"
	EXT_PATH="$EXTENSIONS_DIR/$SHORT_NAME"
	NPM_ENTRY="npm:$NPM_NAME"

	echo "==> 切换 $SHORT_NAME → npm 版本"

	# ── 幂等检查：已是目标状态 ──
	if is_npm_ready "$NPM_NAME" && ! has_symlink "$SHORT_NAME"; then
		green "✓ 已完成，无需操作 (npm: $NPM_NAME)"
		exit 0
	fi

	# ── 步骤 1: 清理 symlink ──
	if [ -L "$EXT_PATH" ]; then
		rm -f "$EXT_PATH"
		echo "  删除 symlink: $EXT_PATH"
	else
		echo "  无 symlink 需删除"
	fi

	# 如果 ext_path 是普通目录（非 symlink），不删除——可能是用户手工放置的
	# 只删除 symlink 类型的路径

	# ── 步骤 2: 清理 settings.json 中残留的 local 条目 ──
	if is_local_registered "$SHORT_NAME"; then
		remove_local_entry "$SHORT_NAME"
		echo "  清理 settings.json 中的 local 条目: extensions/$SHORT_NAME"
	else
		echo "  无 local 条目需清理"
	fi

	# ── 步骤 3: 安装 npm 版本 ──
	echo "  安装 npm 包: $NPM_ENTRY ..."
	pi install "$NPM_ENTRY" 2>&1 | sed 's/^/    /'

	echo ""
	green "✓ 完成: $SHORT_NAME → npm ($NPM_NAME)"
	echo "  重启 Pi 生效。"
}

main "$@"
