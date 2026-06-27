# @zhushanwen/pi-system-prompt-loader

Pi coding agent 的可配置 system prompt 规则加载器。

从用户配置的多种来源（具体路径 / 向上遍历文件名 / 向上遍历目录 / glob 模式）收集 Markdown 规则文件，解析 frontmatter 条件分流后，作为 system prompt 后缀确定性注入。

## 功能

- **四类加载来源**（`explicit` / `walk-files` / `walk-dirs` / `glob`），按 source 声明序 + kind 优先级排序
- **YAML frontmatter 条件分流**：`paths:` 声明 glob 的规则列为 Conditional Rules，其余全文注入
- **跨 source 去重**：`realPath` 相同的规则只保留优先级最高的一份
- **Pi 原生 context file 去重**：已被 Pi 作为 context file 加载的规则（`realPath` 命中）自动排除，避免重复注入
- **噪声目录排除**：跳过 `node_modules`/`.git`/`dist` 等 16 类噪声目录，避免 glob 递归暴涨
- **确定性输出**：规则按 localeCompare 排序，注入位置固定，保证 KV cache 稳定

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/system-prompt-loader \
      ~/.pi/agent/extensions/system-prompt-loader

# npm 方式（正式）
pi install npm:@zhushanwen/pi-system-prompt-loader
```

重启 Pi 后生效。

## 配置

配置文件路径（首次使用需手动创建，扩展不自动生成）：

```
~/.pi/agent/extensions/system-prompt-loader/config.json
```

配置不存在或为空时，扩展零副作用（不加载任何内容，不报错）。

### 配置格式

顶层一个 key `system-prompt-loader`，其 `sources` 是一个**有序数组**。每个 source 有 `kind` 字段决定类型：

| `kind` | 含义 | 必填字段 |
|--------|------|---------|
| `explicit` | 具体路径（文件或目录） | `path`（绝对或相对 CWD；支持 `~` 展开） |
| `walk-files` | 从 CWD 向上遍历匹配**文件名**（止于 home） | `filenames`（字符串数组） |
| `walk-dirs` | 从 CWD 向上遍历匹配**目录**（止于 home，目录内 `.md` 递归加载） | `dirnames`（字符串数组） |
| `glob` | glob 模式匹配（相对 CWD，仅 `.md`，支持 `*`/`**`/`?`） | `patterns`（字符串数组） |

### 示例

参考扩展包内的 `config.example.json`：

```json
{
  "system-prompt-loader": {
    "sources": [
      { "kind": "walk-files", "filenames": ["CLAUDE.md", "AGENTS.md"] },
      { "kind": "walk-dirs", "dirnames": [".rules", ".claude/rules"] },
      { "kind": "explicit", "path": "~/global-rules.md" },
      { "kind": "explicit", "path": "./project-rules/" },
      { "kind": "glob", "patterns": ["docs/conventions/**/*.md"] }
    ]
  }
}
```

`sources` 缺失或空数组 → 零加载（等价于配置不存在）。

### 规则文件格式

每个 `.md` 规则文件可选 YAML frontmatter 声明条件 glob：

```markdown
---
paths:
  - "src/**/*.ts"
  - "*.test.ts"
---

本规则内容仅在编辑匹配 paths 的文件时注入。
```

- 无 frontmatter 或 `paths` 为空 → 无条件规则（全文注入）
- 有 `paths` → 条件规则（列为 Conditional Rules，按 glob 列出）

空内容文件自动跳过。

### 排序与去重

1. **source 内**：walk 类按 root(home) → CWD 序收集，先收集的优先级高
2. **source 间**：按 `kind` 优先级 `explicit(0) > walk-files(1) > walk-dirs(2) > glob(3)`，同优先级按声明序
3. **去重**：`realPath` 相同的规则保留优先级最高的一份
4. **最终序**：无条件规则按显示路径 `localeCompare` 排序，条件规则各自排序

## 与 claude-rules-loader 并存

本扩展与 [`claude-rules-loader`](../claude-rules-loader/) 设计为兼容并存（C-5）：

- **不冲突**：两者都不修改 Pi 原生 context file 行为，只追加后缀
- **各自独立**：两者后缀都被 Pi chain，各自独立 section；跨扩展的拼接顺序由 Pi 决定
- **双重注入过渡期**：若两者同时启用且指向相同文件，可能出现重复内容。建议在迁移期用本扩展的 `explicit`/`glob` 覆盖 CRL 的固定路径，稳定后再考虑卸载 CRL

本扩展在 CRL 基础上提供**完全可配置**的加载来源（CRL 硬编码 `.claude/rules/`，本扩展四类 source 任意组合）。

## 行为细节

- **fs 错误静默**：不存在的路径 / 权限不足 → 静默跳过，不报错、不中断其余 source
- **walk 退化提示**：配置含 walk 类 source 且 CWD 不在 home 子树时，仅扫 CWD 一级；若零收集会 notify 提示（避免误判为 bug）
- **glob 语法**：仅支持 `*`（单层不跨 `/`）/ `**`（跨 `/`）/ `?`（单字符）；不支持 `{}`/`[abc]`/`!` 等复杂语法（按字面匹配，不报错）
- **notify 文案**：收集到规则时 `ui.notify` 提示 `System prompt loader: N collected`；零收集不 notify
- **stale context 容错**：`ui.notify` 抛 "Extension context no longer active" 时自动吞掉（session 中断容错）
