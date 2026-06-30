# ADR-028: Subagents 资源发现与宿主解耦（discovery.json 契约）

## Status: Accepted

## Context

subagents extension 此前硬编码 `~/.pi/agent` 作为 agent .md 与 subagent 配置的根目录。前置改动（本分支同 PR）已将所有目录解析统一为 pi 核心的 `getAgentDir()`，使其尊重 `PI_CODING_AGENT_DIR` 环境变量，宿主可整体重定向配置根。

但仅重定向根目录不足以满足宿主（xyz-agent GUI）的需求：

1. **多目录动态加载**：宿主希望用户按"全局/项目"两个维度勾选多个 skill 与 agent 目录（如 `~/.agents/`、Claude 目录、项目内 `.agents/`），并按覆盖顺序排列，重启 pi 生效。
2. **主子 session 资源一致**：派生 subagent 时，加载的 skill 与 agent 必须与主 agent 一致。

调研 pi-mono 源码确认三个关键技术事实（决定方案边界）：

| 事实 | 出处 | 影响 |
|------|------|------|
| pi 核心不管 agent .md 发现，100% 由 subagents 的 `AgentRegistry` 负责 | `coding-agent` 无 agent .md 加载逻辑 | 多 agent 目录纯是 subagents 内部改造 |
| `createAgentSession` 子 session 用**新建**的 `DefaultResourceLoader`，会重新发现 settings.json 已安装的 skill，但**不继承** argv `--skill` 与 `resources_discover` 动态注入的"目录型" skill | `sdk.ts:182-188`、`resource-loader.ts:421` | 目录型 skill 在子 session 丢失，必须显式注入 |
| `ExtensionAPI` 不暴露 `getSkills()`，extension 拿不到主 session 已加载的 skill 列表 | `extensions/types.ts:1093` | 子 session 无法从主 session "查询"继承，只能从外部契约读取 |

**踩过的坑**：初判误以为 `createAgentSession` 是"裸 session 不加载任何 skill"。实际上它传了 `resourceLoader` 并 `reload()`，会继承 settings.json 已装的 skill（`pi install` 装的）。真正丢失的只有"目录型" skill（argv 与 resources_discover 两路）。

### pi 原生 skill 加载机制（决定 discovery.json 的定位）

pi 核心有 5+ 路 skill 来源，全部汇入一个 `skillPaths` 数组交给 `loadSkills`（`skills.ts:387`）。`loadSkills` 按数组顺序遍历，**先到先得**——同名 skill 只记 collision diagnostic 不覆盖（`skills.ts:414-422`）。最终数组合并顺序（`resource-loader.ts:421-423` + `extendResources:300`）：

```
skillPaths = [
  ...cliEnabledSkills,        // ① --skill argv（最高优先）
  ...enabledSkills,           // ② settings.json pi install + auto-discovery
  ...additionalSkillPaths,    // ③ DefaultResourceLoader 构造参数
]
// reload 后，resources_discover 触发时再 append：
  ...extensionSkillPaths      // ④ resources_discover 返回的（最低优先）
```

**auto-discovery 扫描的目录**（`package-manager.ts:2279-2366`，按 project→user 顺序加入 enabledSkills）：

| scope | 目录 | 说明 |
|-------|------|------|
| project | `<cwd>/.pi/skills` | pi 项目级标准目录 |
| project | `<cwd>/.agents/skills` 及所有祖先目录 | `.agents` 约定，逐级向上扫到 git root |
| user | `~/.pi/agent/skills` | pi 全局标准目录 |
| user | `~/.agents/skills` | `.agents` 全局约定 |

**两个对方案定位的关键结论**：

1. **pi 原生已扫 `.agents/skills`**：宿主期望支持的 `.agents/` 目录，pi 自己 auto-discovery 就支持了。discovery.json 的 `skillDirs` 对这些标准目录是**冗余**的，只对非标准位置（如 `~/.claude/skills`）或临时动态目录有意义。

2. **resources_discover 返回的 skill 优先级最低**：排在所有原生来源之后，会被同名 argv/settings/auto skill 抢占。这是 pi 的设计——extension 注入的是"补充"资源，不是"覆盖"资源。

宿主定位评估后选择**方向 A（维持 resources_discover）**：discovery.json 定位为"补充加载额外 skill 目录"，不追求覆盖原生 skill。理由——宿主主要需求是"加载额外目录"而非"抢占标准目录"，维持 extension 层实现最简单，不碰 pi 核心。

## Decision

引入 `<agentDir>/subagents/discovery.json` 作为宿主与 subagents 的**解耦契约**。宿主启动 pi 前写入该文件，subagents 在固定位置读取，双方互不知道对方实现。

### 契约格式

```json
{
  "version": 1,
  "skillDirs": ["/abs/path/.agents/skills", "/abs/path/claude/skills"],
  "agentDirs": ["/abs/path/.agents/agents", "/abs/path/claude/agents"]
}
```

文件缺失或字段缺失时，`skillDirs`/`agentDirs` 视为空数组，行为与无契约时完全一致（零破坏）。

### 三路数据流（单一真相源 = 一个文件）

| 数据 | 谁读 discovery.json | 喂给谁 |
|------|---------------------|--------|
| `skillDirs` | subagents 的 `resources_discover` 处理器（主进程） | 主 agent 的 resourceLoader |
| `skillDirs` | subagents 的 session 创建逻辑（原 `session-factory.ts`，已合并进 `session-runner.ts`） | 子 agent 的 `additionalSkillPaths` |
| `agentDirs` | subagents 的 `AgentRegistry`（主进程内） | agent .md 发现；子 session 自动继承解析结果（agent 配置作为静态数据传入 run） |

### 关键设计点

1. **主 agent 的 skill 用 `resources_discover` 而非 argv**：pi 原生官方通道（`extensions/types.ts:501`），extension 返回 `skillPaths` 后 pi 自动 merge。比 argv 优势——单一真相源（宿主只写一个文件），主子 session 天然一致，支持 `/reload` 热重载。代价是 skill 优先级最低（见 Context「pi 原生 skill 加载机制」），但符合"补充加载"定位。

2. **子 session 的 skill 由 session-runner 显式注入**：`createAndConfigureSession` 中 `additionalSkillPaths` 从 `[input.skillPath]` 改为 `[...discovery.skillDirs, input.skillPath].filter(Boolean)`。这是补齐"目录型 skill 在子 session 丢失"的唯一正确位置。

3. **多目录优先级 = 数组顺序，靠前覆盖靠后**：该规则对 **agent .md** 完全成立（`AgentRegistry.discoverAll` 逆序扫描，靠前目录后写覆盖；`agent-registry.ts`）。对 **skill** 则受 pi 核心顺序约束——discovery 的 skillDirs 整体排在原生来源之后，仅在 discovery.json 内部多个目录间维持"靠前优先"（resources_discover 返回时保序，`loadSkills` 先到先得）。

4. **与 settings.json 已装 skill 正交**：`pi install` 写入 settings.json 的 skill 由 `DefaultResourceLoader` 的 `enabledSkills` 路径自动发现，主子 session 都继承，与 discovery.json 的目录型 skill 互不干扰、并行生效。

## Consequences

**优点**

- **解耦**：subagents 只认 discovery.json 文件格式，不知宿主是谁、GUI 长啥样。手动编辑文件或换宿主均可。
- **主子一致**：skill 列表单一真相源（一个文件两处读），杜绝主子进程 skill 不一致的隐蔽 bug。
- **单独可用**：subagents 在裸 pi 中无 discovery.json 时全走默认，零配置成本。
- **动态可控**：宿主改配置 → 重写 discovery.json → 重启 pi 生效，契合"重启生效"的动态模型。

**代价**

- 多一层文件 IO（session_start 读一次，配 mtime 缓存避免重复解析）。
- 宿主需保证写入一致性（原子写：temp + rename；写前比对内容，一致则跳过避免触发无谓 reload）。
- **skill 优先级最低**：discovery.json 声明的 skill 排在 pi 所有原生来源之后，同名会被 argv/settings/auto 抢占。宿主若需"用户勾选优先覆盖标准目录"，本方案不满足（需改走 argv 或 settings.json，见备选方案）。

**备选方案（已否决）**

| 方案 | 否决理由 |
|------|----------|
| 环境变量 `XYZ_AGENT_SKILL_DIRS` | 子进程自动继承 env 能解决 skill 一致性，但 agent 目录也要 env、宿主管两套机制、非 pi 标准 |
| argv `--skill` | 主 agent 有效，子 session 不读 argv，丢失 |
| 纯 `resources_discover` 不落盘 | session-runner 拿不到主 session 的 discover 结果（extension 间无共享状态通道），且子 session 不触发该事件 |
