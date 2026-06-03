# taste-lint

代码品味 ESLint 插件 — 自定义规则集，强制执行编码品味标准。

## 功能

内置 5 条品味规则：

| 规则 | 类型 | 说明 |
|------|------|------|
| `prefer-allsettled` | suggestion | 独立数据源优先 `Promise.allSettled`，不用 `Promise.all` |
| `no-silent-catch` | problem | catch 块必须有实质错误处理 |
| `no-unbounded-while-true` | problem | `while(true)` 必须有退出路径 |
| `no-inline-import-type` | suggestion | 禁止行内 `import(...).Type` 类型断言 |
| `no-eslint-disable` | problem | 禁止 `eslint-disable` 注释 |

## 安装

```bash
# 作为 ESLint 配置导入
# 在项目的 eslint.config.mjs 中：
import tasteConfig from './taste-lint/base.mjs';
export default tasteConfig;
```

## 使用

配置完成后正常运行 ESLint 即可：

```bash
npx eslint src/
```

## 文件结构

```
taste-lint/
├── base.mjs                # ESLint flat config 基础配置
└── rules/
    ├── prefer-allsettled.mjs
    ├── no-silent-catch.mjs
    ├── no-unbounded-while-true.mjs
    ├── no-inline-import-type.mjs
    └── no-eslint-disable.mjs
```
