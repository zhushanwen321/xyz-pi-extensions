#!/usr/bin/env bash
# render.sh — 把骨架 HTML 的占位符替换为公共 css/js 全文，输出自包含 HTML。
#
# 用法:
#   ./render.sh <input.html>              # 输出到 stdout
#   ./render.sh <input.html> > out.html   # 重定向到文件
#   ./render.sh <input.html> out.html     # 第二参数=输出文件
#
# 占位符（骨架里预埋）:
#   /* INLINE: design.css */   → 替换为 templates/design.css 全文
#   /* INLINE: zoom.js */      → 替换为 templates/zoom.js 全文
#
# subagent 填好骨架的 AGENT-FILL 槽位后跑本脚本，得到最终单文件自包含 HTML。
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: $0 <input.html> [output.html]" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="${2:-}"  # 空 = stdout

# 定位 templates/ 目录（本脚本所在目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESIGN_CSS="$SCRIPT_DIR/design.css"
ZOOM_JS="$SCRIPT_DIR/zoom.js"

if [ ! -f "$DESIGN_CSS" ]; then echo "错误: 找不到 $DESIGN_CSS" >&2; exit 1; fi
if [ ! -f "$ZOOM_JS" ]; then echo "错误: 找不到 $ZOOM_JS" >&2; exit 1; fi
if [ ! -f "$INPUT" ]; then echo "错误: 找不到输入文件 $INPUT" >&2; exit 1; fi

# 用 perl 替换（比 sed 更好处理含 / 的多行内容；占位符是字面量，无需转义正则元字符）
if [ -n "$OUTPUT" ]; then
  perl -0777 -pe "
    s{/\* INLINE: design\.css \*/}{qx{cat \"$DESIGN_CSS\"} // ''}eg;
    s{/\* INLINE: zoom\.js \*/}{qx{cat \"$ZOOM_JS\"} // ''}eg;
  " "$INPUT" > "$OUTPUT"
  echo "已生成: $OUTPUT" >&2
else
  perl -0777 -pe "
    s{/\* INLINE: design\.css \*/}{qx{cat \"$DESIGN_CSS\"} // ''}eg;
    s{/\* INLINE: zoom\.js \*/}{qx{cat \"$ZOOM_JS\"} // ''}eg;
  " "$INPUT"
fi
