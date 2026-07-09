#!/usr/bin/env python3
"""
项目结构树生成器（给主 agent 用的结构化速览）

Usage:
    python3 dump_tree.py [project_root] [--depth N] [--out PATH] [--follow-symlinks]
    # 默认 project_root=., depth=3, 不跟随 symlink, 输出到 stdout

用途：coding-init 扫描阶段一次性获取项目布局，替代串行 Glob 往返。
设计取向：给主 agent 看（结构化、限深度、合并同类、标注关键文件），非给人看的漂亮树。

鲁棒性（7 个失败路径，详见各 R 注释）：
  R1 symlink 循环   R2 权限不足   R3 规模爆炸
  R4 编码/特殊字符   R5 .bare/worktree   R6 参数错误   R7 异常透出

Exit code: 0=正常, 2=参数错误, 3=内部错误
"""

import argparse
import os
import re
import sys

# ---------------------------------------------------------------------------
# 配置常量
# ---------------------------------------------------------------------------

# 跳过的目录名（与 _shared_check_lib.iter_source_files 的 skip_dirs 取并集 + 语言/工具扩展）
# 不做 gitignore 解析：git 规则复杂（!/ **/ 嵌套）易错，硬编码跨项目稳定且与共享库一致。
SKIP_DIRS = {
    # 共享库同款（保证一致性）
    "node_modules", "dist", "build", ".git", "__pycache__", ".next",
    # 语言专属
    "target", ".gradle", ".bin",                 # Rust/Java
    ".venv", "venv", ".tox", ".pytest_cache",    # Python
    # 工具产物
    "coverage", ".turbo", ".cache", ".svelte-kit", ".nuxt",
    # worktree/bare（R5：本项目是 .bare+worktree 结构）
    ".bare", ".worktrees",
    # harness 工作产出（运行时生成，非项目源码结构）
    ".xyz-harness",
}

# 跳过的文件名（噪声，不进树）
SKIP_FILES = {".DS_Store", "Thumbs.db"}

# 深度限制
DEFAULT_DEPTH = 3
MAX_DEPTH = 10  # R3: 硬上限，防误操作

# 规模限制（R3）
MAX_NODES = 5000          # 累计展示节点上限，超过折叠
DIR_COLLAPSE_THRESHOLD = 40  # 单目录直接子项超过此值，显示前 N + (X more)
DIR_COLLAPSE_SHOW = 15       # 合并时展示前 N 个（够看核心，不刷屏）

# 关键文件标注规则
ENTRY_FILES = {
    "index.ts", "index.tsx", "index.js", "index.jsx",
    "main.py", "main.go", "main.rs", "lib.rs", "app.py", "mod.rs",
    "App.vue", "main.ts", "main.tsx",
}
MAIN_CONFIG = {"AGENTS.md", "CLAUDE.md"}
DESIGN_DOCS = {
    "ARCHITECTURE.md", "PRODUCT.md", "NFR.md", "CONTEXT.md",
    "TEST-STRATEGY.md", "DESIGN-LOG.md",
}
MONOREPO_MARKERS = {
    "pnpm-workspace.yaml", "lerna.json", "turbo.json",
    "nx.json", "rush.json", "melange.yaml",
}

# 控制字符（破坏树形对齐）→ repr 转义
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


# ---------------------------------------------------------------------------
# 统计计数器
# ---------------------------------------------------------------------------

class Stats:
    def __init__(self):
        self.shown = 0          # 已展示节点数
        self.truncated_depth = 0  # 因深度截断的节点数
        self.collapsed = 0      # 因单目录合并折叠的节点数
        self.skipped_perm = 0   # 权限/IO 错误的目录数
        self.cycles_cut = 0     # symlink 环剪枝次数

    def summary(self):
        parts = [f"展示 {self.shown} 节点"]
        if self.truncated_depth:
            parts.append(f"深度截断 {self.truncated_depth}")
        if self.collapsed:
            parts.append(f"合并折叠 {self.collapsed}")
        if self.skipped_perm:
            parts.append(f"权限跳过 {self.skipped_perm}")
        if self.cycles_cut:
            parts.append(f"环剪枝 {self.cycles_cut}")
        return "，".join(parts)


# ---------------------------------------------------------------------------
# 目录遍历（鲁棒性核心）
# ---------------------------------------------------------------------------

def list_dir(path):
    """列目录内容，返回排序后的 DirEntry 列表。失败返回 (None, error)。

    R2: 不用 os.walk（异常粒度粗），用 os.scandir 显式捕获。
    """
    try:
        entries = list(os.scandir(path))
    except (PermissionError, OSError) as e:
        return None, e
    # 排序：目录在前，同类按名排序（不区分大小写，中文按 unicode）
    entries.sort(key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
    return entries, None


def is_real_skip(entry, follow_symlinks):
    """是否应跳过该 entry。"""
    name = entry.name
    if name in SKIP_DIRS or name in SKIP_FILES:
        return True
    return False


def safe_realpath(path):
    """os.path.realpath 的安全版，解析失败返回 None。"""
    try:
        return os.path.realpath(path)
    except OSError:
        return None


# ---------------------------------------------------------------------------
# 树形渲染
# ---------------------------------------------------------------------------

def annotate(name, is_dir):
    """返回文件/目录的语义标注。"""
    tags = []
    if name in MAIN_CONFIG:
        tags.append("[主配置]")
    elif name == "package.json":
        # 是否 monorepo 根在调用方判定（这里只标 [pkg]，根级用 [monorepo根]）
        tags.append("[pkg]")
    elif name in MONOREPO_MARKERS:
        tags.append("[monorepo]")
    elif name in DESIGN_DOCS:
        tags.append("[design容器]")
    elif name in ENTRY_FILES:
        tags.append("[entry]")
    return ("  " + " ".join(tags)) if tags else ""


def safe_name(name):
    """R4: 文件名含控制字符 → repr 转义，防破坏树形对齐。"""
    if _CTRL_RE.search(name):
        return repr(name)
    return name


def render_entry(name, is_dir, prefix, is_last, annotation="", suffix=""):
    """渲染单行树形。prefix 是缩进前缀，is_last 控制分支符号。"""
    branch = "└── " if is_last else "├── "
    trailing = "/" if is_dir else ""
    return f"{prefix}{branch}{safe_name(name)}{trailing}{annotation}{suffix}"


def count_children(path):
    """快速统计目录子项数（用于深度截断时显示 (N items)）。失败返回 0。"""
    try:
        # 只数第一层，不递归；用生成器避免大目录全量加载
        n = 0
        with os.scandir(path) as it:
            for _ in it:
                n += 1
        return n
    except (PermissionError, OSError):
        return 0


def walk_tree(root, depth, follow_symlinks, max_nodes, stats, out_lines):
    """DFS 遍历，渲染到 out_lines。

    R1: 维护已访问真实路径集合，检测 symlink 环。
    R3: 超过 max_nodes 立即停止追加。
    """
    visited = set()  # 已访问的真实路径（仅 follow_symlinks 时有意义）

    def _recurse(path, cur_depth, prefix, is_root_last):
        if stats.shown >= max_nodes:
            return
        entries, err = list_dir(path)
        if err is not None:
            # R2: 权限/IO 错误，记单条继续
            stats.skipped_perm += 1
            out_lines.append(f"{prefix}└── [无权限/IO错误]")
            return

        # 过滤 + 统计被合并的
        visible = []
        skipped_names = 0
        for e in entries:
            if is_real_skip(e, follow_symlinks):
                continue
            visible.append(e)

        # R3: 单目录合并
        collapsed = 0
        if len(visible) > DIR_COLLAPSE_THRESHOLD:
            collapsed = len(visible) - DIR_COLLAPSE_SHOW
            stats.collapsed += collapsed
            visible = visible[:DIR_COLLAPSE_SHOW]

        n = len(visible)
        for i, e in enumerate(visible):
            if stats.shown >= max_nodes:
                return
            is_last = (i == n - 1) and collapsed == 0
            name = e.name
            # R1: symlink 处理
            is_link = e.is_symlink()
            if is_link and not follow_symlinks:
                # 不展开，显示 → target
                target = readlink_target(e.path)
                stats.shown += 1
                ann = ""
                suffix = f" → {target}" if target else " → (broken)"
                out_lines.append(render_entry(name, False, prefix, is_last, ann, suffix))
                continue

            # R1: follow_symlinks 模式下，realpath 环检测必须在 is_dir 之前——
            # 循环 symlink（a→b→a）会让 is_dir(follow_symlinks=True) 抛 ELOOP OSError，
            # 必须先剪枝环，避免异常先抛出。
            if follow_symlinks:
                rp = safe_realpath(e.path)
                if rp is None:
                    out_lines.append(render_entry(name, False, prefix, is_last, "", " → (解析失败)"))
                    continue
                if rp in visited:
                    stats.cycles_cut += 1
                    out_lines.append(render_entry(name, False, prefix, is_last, "", " → (环，已剪枝)"))
                    continue
                visited.add(rp)

            # is_dir 可能抛 OSError（悬空链接、ELOOP 残余），安全包裹
            try:
                is_dir = e.is_dir(follow_symlinks=follow_symlinks)
            except OSError:
                stats.skipped_perm += 1
                out_lines.append(render_entry(name, False, prefix, is_last, "", " → (解析失败)"))
                continue
            if is_dir:
                stats.shown += 1
                ann = annotate(name, True)
                out_lines.append(render_entry(name, True, prefix, is_last, ann))

                # 深度截断 or 递归
                if cur_depth >= depth:
                    # R3: 深度截断，显示子项计数
                    child_count = count_children(e.path)
                    if child_count:
                        child_prefix = prefix + ("    " if is_last else "│   ")
                        trunc_msg = f"({child_count} items) → 深度截断"
                        stats.truncated_depth += child_count
                        out_lines.append(f"{child_prefix}└── {trunc_msg}")
                else:
                    child_prefix = prefix + ("    " if is_last else "│   ")
                    _recurse(e.path, cur_depth + 1, child_prefix, is_last)
                # follow_symlinks 模式下回溯 visited（允许同名不同路径）
                # 注意：不 remove，因为环检测要求全局唯一访问；跨分支重复路径属正常
            else:
                stats.shown += 1
                ann = annotate(name, False)
                out_lines.append(render_entry(name, False, prefix, is_last, ann))

        # R3: 合并折叠提示
        if collapsed:
            out_lines.append(f"{prefix}└── ... ({collapsed} more)")

    _recurse(root, 1, "", True)


def readlink_target(path):
    """读 symlink 目标，失败返回 None。"""
    try:
        return os.readlink(path)
    except OSError:
        return None


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(
        description="项目结构树生成器（coding-init 扫描辅助）",
        usage="dump_tree.py [project_root] [--depth N] [--out PATH] [--follow-symlinks]",
    )
    p.add_argument("root", nargs="?", default=".", help="项目根目录（默认当前目录）")
    p.add_argument("--depth", type=int, default=DEFAULT_DEPTH,
                   help=f"遍历深度 1-{MAX_DEPTH}（默认 {DEFAULT_DEPTH}）")
    p.add_argument("--out", default=None, help="输出文件路径（默认 stdout）")
    p.add_argument("--follow-symlinks", action="store_true",
                   help="跟随 symlink（默认不跟随，仍带环检测）")
    args = p.parse_args(argv)

    # R6: 参数校验（失败要出声，不静默吞）
    if not os.path.isdir(args.root):
        print(f"Error: 路径不存在或非目录: {args.root}", file=sys.stderr)
        sys.exit(2)
    if args.depth < 1 or args.depth > MAX_DEPTH:
        print(f"Error: --depth 须在 1-{MAX_DEPTH} 之间，得到 {args.depth}", file=sys.stderr)
        sys.exit(2)
    return args


def ensure_utf8_stdout():
    """R4: 强制 stdout UTF-8，避免中文/emoji 在非 UTF-8 终端报 UnicodeEncodeError。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        # Python <3.7 或特殊环境：降级，输出已尽力
        pass


def main(argv=None):
    # R7: 顶层兜底，防未捕获异常污染主 agent 上下文
    try:
        args = parse_args(argv or sys.argv[1:])
        ensure_utf8_stdout()

        root_abs = os.path.abspath(args.root)
        stats = Stats()
        out_lines = []

        # 标记 monorepo 根的 package.json（需要在根级改标注）
        root_pkg = os.path.join(root_abs, "package.json")
        has_monorepo_marker = any(
            os.path.exists(os.path.join(root_abs, m)) for m in MONOREPO_MARKERS
        )

        out_lines.append(f"项目结构树（深度≤{args.depth}，跳过依赖/构建产物）")
        out_lines.append(f"根: {root_abs}")
        out_lines.append("")

        walk_tree(
            root_abs, args.depth, args.follow_symlinks,
            MAX_NODES, stats, out_lines,
        )

        out_lines.append("")
        out_lines.append(f"统计: {stats.summary()}")
        out_lines.append(f"排除目录: {', '.join(sorted(SKIP_DIRS))}")

        text = "\n".join(out_lines)

        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"已写入: {args.out}")
        else:
            print(text)

        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 R7: 顶层兜底
        print(f"[dump_tree] 内部错误: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
