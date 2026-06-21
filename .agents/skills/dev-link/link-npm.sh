#!/usr/bin/env bash
# link-npm.sh — 卸载 symlink 版本，安装 npm 版本（或纯卸载）
# 用法:
#   ./link-npm.sh <package>              # 切换到 npm 版本（包未发布时自动降级为纯卸载）
#   ./link-npm.sh <package> --uninstall   # 纯卸载：只删 symlink + 清 settings.json，不安装 npm
#
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

# ── 检查 npm 包是否已发布 ────────────────────────────────
# npm view 在包不存在时返回非零；2>/dev/null + || true 容错
is_npm_published() {
	local npm="$1"
	npm view "$npm" version >/dev/null 2>&1
}

# ── 执行清理（删 symlink + 清 settings.json）────────────
do_cleanup() {
	local short="$1"

	# 步骤 1: 清理 symlink（只删 symlink 类型，不动普通目录）
	if [ -L "$EXTENSIONS_DIR/$short" ]; then
		rm -f "$EXTENSIONS_DIR/$short"
		echo "  删除 symlink: $EXTENSIONS_DIR/$short"
	else
		echo "  无 symlink 需删除"
	fi

	# 步骤 2: 清理 settings.json 中残留的 local 条目
	if is_local_registered "$short"; then
		remove_local_entry "$short"
		echo "  清理 settings.json 中的 local 条目: extensions/$short"
	else
		echo "  无 local 条目需清理"
	fi
}

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	local mode="install" # 默认模式：卸载后安装 npm 版本

	# 解析参数：<package> [+ 可选 --uninstall]
	if [ $# -lt 1 ] || [ $# -gt 2 ]; then
		echo "用法: $0 <package> [--uninstall]"
		echo "  <package>  = 短名 (model-switch) / pi-前缀 (pi-model-switch) / npm全名 (@zhushanwen/pi-model-switch)"
		echo "  --uninstall = 纯卸载：只清理不安装 npm（适用于未发布的包）"
		exit 1
	fi

	if [ $# -eq 2 ] && [ "$2" == "--uninstall" ]; then
		mode="uninstall"
	fi

	resolve_name "$1"
	EXT_PATH="$EXTENSIONS_DIR/$SHORT_NAME"
	NPM_ENTRY="npm:$NPM_NAME"

	# ── 纯卸载模式 ──
	if [ "$mode" == "uninstall" ]; then
		echo "==> 纯卸载 $SHORT_NAME (不安装 npm 版本)"
		do_cleanup "$SHORT_NAME"
		echo ""
		green "✓ 完成: $SHORT_NAME 已卸载"
		echo "  重启 Pi 生效。"
		exit 0
	fi

	# ── 切换到 npm 模式 ──
	echo "==> 切换 $SHORT_NAME → npm 版本"

	# 幂等检查：已是目标状态
	if is_npm_ready "$NPM_NAME" && ! has_symlink "$SHORT_NAME"; then
		green "✓ 已完成，无需操作 (npm: $NPM_NAME)"
		exit 0
	fi

	# 步骤 1+2: 清理 symlink + settings.json
	do_cleanup "$SHORT_NAME"

	# 步骤 3 前预检：npm 包是否已发布
	if ! is_npm_published "$NPM_NAME"; then
		echo ""
		yellow "⚠ npm 包 $NPM_NAME 未发布 (404)。"
		echo "  清理已完成 (symlink 已删、settings.json 已清), 跳过 npm 安装。"
		echo "  如需安装, 请先 npm publish, 再运行: $0 $1"
		echo ""
		green "✓ 完成: $SHORT_NAME 已卸载 (npm 版本不可用)"
		echo "  重启 Pi 生效。"
		exit 0
	fi

	# 步骤 3: 安装 npm 版本（显式捕获退出码，不用管道掩盖失败）
	echo "  安装 npm 包: $NPM_ENTRY ..."
	if ! pi install "$NPM_ENTRY"; then
		echo ""
		red "✗ pi install 失败: $NPM_ENTRY"
		echo "  清理已完成，但 npm 安装失败。请检查网络或 npm registry。"
		echo "  重试安装: pi install $NPM_ENTRY"
		exit 1
	fi

	echo ""
	green "✓ 完成: $SHORT_NAME → npm ($NPM_NAME)"
	echo "  重启 Pi 生效。"
}

main "$@"
