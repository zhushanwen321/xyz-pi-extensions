# pi-interactive-shell — 直接安装分析

## 基本信息

| 维度 | 信息 |
|------|------|
| 原始仓库 | [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) |
| Stars | 513 |
| 安装方式 | direct-install |
| 安装日期 | 2026-06-01 |
| 版本 | 0.13.0 |

## 选择直接安装的理由

1. **填补能力空白**：我们的 subagent 只能派遣 Pi 进程做编码任务，无法控制交互式 CLI 程序（vim、htop、数据库 shell 等）。pi-interactive-shell 补齐了这一层
2. **架构独立**：不与 goal/todo/subagent 等扩展冲突，纯增量能力
3. **代码质量高**：约 7200 行 TypeScript，模块划分清晰，有完整测试套件和 CHANGELOG
4. **Token 经济性设计优秀**：四种模式（interactive/hands-free/dispatch/monitor）按需选择，预算控制是一等公民
5. **维护活跃**：5 个 closed issues 在 2026-04 批量修复，版本迭代到 0.13.0

## 核心设计

### 不用 tmux 的 PTY 仿真

核心创新：用 **xterm-headless**（xterm.js 的 headless 模式）在内存中完整仿真终端渲染，替代 tmux。

- **zigpty** 提供真正的 PTY（伪终端），子进程认为自己连接到真实终端
- **@xterm/headless** 完整解析 VT100/VT220/xterm 转义序列，维护 buffer、光标、alternate buffer
- **手动 DSR 响应**：TUI 程序查询光标位置时，从 xterm buffer 读取真实坐标并回复

### 四种运行模式

| 模式 | 场景 | Token 消耗 |
|------|------|-----------|
| interactive | 人类直接操作，Pi 不参与 | 零 |
| hands-free | Pi 自主操作，定期报告输出 | 中（有预算控制） |
| dispatch | 启动命令后等完成，零轮询 | 低（仅完成通知） |
| monitor | 后台监控，事件驱动通知 | 最低（仅 trigger 命中时） |

### Token 节省策略

- 输出预算：总量 100KB，单次上限 1500 字
- 增量读取：`drain`/`sinceLast` 只返回未读内容
- Rate limiting：默认 60s 最小查询间隔
- Monitor 四层过滤：literal → regex + threshold → detector → cooldown 去重

### 关键依赖

| 依赖 | 用途 | 风险 |
|------|------|------|
| zigpty ^0.1.6 | PTY 进程管理（Rust 原生模块） | 在非 AVX-512 CPU 上有 SIGILL 风险（#9） |
| @xterm/headless ^5.5.0 | 内存终端仿真 | 成熟稳定 |
| @xterm/addon-serialize ^0.13.0 | 序列化 xterm buffer | 成熟稳定 |

## 架构概览

```
index.ts (入口，1901 行)
├── overlay-component.ts (TUI overlay，1094 行)
│   └── pty-session.ts (PTY + xterm-headless，614 行)
│       ├── pty-protocol.ts (DSR 光标响应)
│       └── pty-log.ts (输出缓冲管理)
├── reattach-overlay.ts (重连 overlay，446 行)
├── headless-monitor.ts (后台监控，397 行)
├── session-manager.ts (会话生命周期，355 行)
├── runtime-coordinator.ts (运行时状态协调，216 行)
├── tool-schema.ts (工具 schema，484 行)
├── spawn.ts (命令解析，313 行)
├── key-encoding.ts (按键编码，270 行)
├── config.ts (配置管理，258 行)
└── 辅助模块 (notification-utils, handoff-utils, session-query, background-widget)
```

## 与我们扩展的关系

- **subagent**：互补。subagent 派遣独立 Pi 进程做编码任务，interactive-shell 控制交互式 CLI。两者可结合使用
- **context-engineering**：间接相关。interactive-shell 的 token 预算控制策略（增量读取、分页、预算硬限制）可借鉴到上下文压缩
- **unified-hooks**：如果要在 bash 命令前后做拦截，interactive-shell 的 PTY 输出处理有参考价值
- **goal/todo**：无冲突，interactive-shell 可作为 goal 执行阶段的一个工具选项

## 已知问题

| Issue | 状态 | 影响 |
|-------|------|------|
| #9 zigpty SIGILL crash | Open | 在非 AVX-512 CPU 上崩溃，升级 zigpty 到 0.1.5 可修复 |
| #16 支持自定义 spawn agent | Open | 当前硬编码 pi/codex/claude/cursor 四种 |
| #3 overlay 窗口大小位置自定义 | Open | 体验优化，非阻塞 |

## 可借鉴的设计模式

1. **多模式分流**：同一工具根据场景用不同模式，避免一刀切
2. **输出预算控制**：总量 + 单次上限 + 增量读取的三层控制，context-engineering 可借鉴
3. **Monitor trigger 设计**：literal → regex → threshold → detector 四层过滤，比简单字符串匹配灵活
4. **Session 持久化**：overlay → background → reattach 全生命周期，slug 命名便于调试
5. **Debounce 渲染**：16ms 合并多次数据更新，避免 TUI 闪烁

## 后续计划

- 持续使用，验证 hands-free 和 dispatch 模式在实际工作流中的效果
- 关注 zigpty 0.1.6 是否解决 #9 SIGILL 问题
- 评估 monitor 模式是否可以用于长运行服务（dev server、测试套件）的监控
- 如果需要自定义 spawn agent（如 aider、cline），关注 #16 进展或考虑 fork
