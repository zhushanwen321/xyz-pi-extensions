# types

共享类型定义包（私有，不发布到 npm）。为其他 Pi 扩展提供统一的类型声明。

## 功能

- 补充 `@mariozechner/pi-coding-agent` 未导出的内部类型
- 跨扩展共享类型定义

## 安装

作为 workspace 内部依赖使用，不需要单独安装。在 `package.json` 中引用：

```json
{
  "dependencies": {
    "@zhushanwen/pi-types": "workspace:*"
  }
}
```

## 文件结构

```
types/
└── mariozechner/
    └── index.d.ts    # 类型声明
```
