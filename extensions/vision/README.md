# vision

图片分析工具 — 使用多模态视觉模型分析图片，支持会话隔离和上下文感知。

## 功能

- **多模型支持**：从 `~/.pi/agent/vision-models.json` 读取模型配置
- **会话隔离**：spawn 独立 Pi 子进程执行视觉分析，不污染主会话
- **上下文感知**：支持 `fork` 模式，继承父会话上下文理解图片
- **自动清理**：定期清理临时文件

## 安装

```bash
# symlink 方式（开发推荐）
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/vision \
      ~/.pi/agent/extensions/vision

# npm 方式（正式）
pi install npm:@zhushanwen/pi-vision
```

## 使用

AI 可调用 `analyze_image` 工具：

```
> 帮我看下这张截图里的错误信息
（AI 自动调用 analyze_image 工具）
```

工具参数：
- `image_path`：图片路径（必需）
- `question`：要回答的问题（必需）
- `context`：`fresh`（独立会话）或 `fork`（继承上下文）

## 配置

创建 `~/.pi/agent/vision-models.json` 指定视觉模型：

```json
[
  {
    "provider": "your-provider",
    "model": "vision-model-id",
    "input": ["image"]
  }
]
```

## 文件结构

```
vision/
├── index.ts
└── src/
    ├── index.ts          # 入口 — 工具注册、事件
    ├── spawn.ts          # 子进程管理、结果收集
    └── vision-model.ts   # 模型配置加载
```
