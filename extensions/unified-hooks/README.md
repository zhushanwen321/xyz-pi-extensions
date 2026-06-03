# unified-hooks

统一 hooks 管理器 — 将散落的 hooks 收集到一个扩展中统一维护，每个 hook 可独立启用/禁用。

## 功能

### 内置 Hooks

| Hook | 说明 |
|------|------|
| `edit-whitespace-autofix` | edit 工具因空白字符不匹配失败时，自动注入 steering 让 AI 修复空白并重试 |
| `tool-error-handler` | 记录所有工具执行错误到控制台，方便调试 |

### 扩展方式

在 `src/hooks/` 下新建 hook 模块，然后在 `src/index.ts` 的 `hookModules` 数组中注册即可。

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/unified-hooks \
      ~/.pi/agent/extensions/unified-hooks

# npm 方式（正式）
pi install npm:@zhushanwen/pi-unified-hooks
```

## 使用

安装后自动生效。edit 空白修复无需配置，工具错误日志自动输出到控制台。

## 文件结构

```
unified-hooks/
├── index.ts
└── src/
    ├── index.ts               # 入口 — hook 注册
    └── hooks/
        └── tool-error-handler.ts  # 工具错误处理
```
