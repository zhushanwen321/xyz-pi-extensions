# @zhushanwen/pi-rename-session

Pi rename-session 扩展 — 新 session 首 turn 完成后，自动生成会话标题并落库（`setSessionName`），让 session 列表摆脱默认的日期/序号占位，一眼可辨。

## 功能

- 新 session 的**首个 turn** 完成后自动生成简短标题（3-8 个词，跟随对话语言）
- 复用主 turn 完整上下文发起独立 LLM 调用，命中 kvcache，几乎不产生额外成本
- 标题直接 `setSessionName` 落库，不进 session history（不污染对话记录）
- fire-and-forget：任何失败（LLM 调用 / 提取 / auth / 读取）都静默跳过，保留原 label，绝不阻断 agent 循环
- **子 session 自动排除**：subagent 子进程 session 不触发 rename（避免给临时产物起名）

## 安装

```bash
pi install npm:@zhushanwen/pi-rename-session
```

## 开关

文件存在 = 开启。默认**关闭**，需显式开启。

- **原生 pi 用户**：手动创建开关文件
  ```bash
  touch ~/.pi/agent/auto-rename-enabled
  ```
- **xyz-agent 用户**：通过 settings 的开关控制（由 xyz-agent 桥接到同一个开关文件）

开关文件路径可通过 `PI_CODING_AGENT_DIR` 环境变量覆盖基础目录（默认 `~/.pi/agent`）。

## 工作原理

1. **监听 `turn_end`**：每个 turn 完成时触发。
2. **开关 + subagent 过滤**：开关关闭则直接返回；session 路径含 `subagents` 段则视为子进程 session，跳过。
3. **首 turn 判定**：统计 session entries 中 `assistant` 回复数，===1 才是首 turn（后续 turn 不重复 rename）。
4. **LLM 生成标题**：复用主 turn 的完整上下文（system prompt + tools + messages），追加一条 rename 指令的 user message，发起一次独立 LLM 调用。由于前缀与主 turn 字节级一致，能命中 kvcache，显著省成本。
5. **落库**：调 `setSessionName` 写入标题。**不**写入 session history（不调用 `appendEntry`），对话记录不受影响。

## 子 session 自动排除

subagent 子进程的 session 目录形如 `.../subagents/...`，是临时产物。本扩展通过检测路径中的 `subagents` 段判定子 session，自动跳过 rename，避免给这些临时 session 生成噪音标题。

## 文件结构

```
rename-session/
├── index.ts              # 工厂入口（re-export src/index.ts）
├── package.json
├── vitest.config.ts
├── README.md
└── src/
    ├── index.ts          # 工厂入口（注册 turn_end handler）
    ├── pure.ts           # 纯函数（countAssistantReplies / extractTitle / isEnabled / CONFIG）
    ├── llm.ts            # callRenameLLM（动态 import completeSimple，复用主 turn 上下文）
    └── __tests__/        # 单测（pure 纯函数 + llm mock + index 集成）
```
