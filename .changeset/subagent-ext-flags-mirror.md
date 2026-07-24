---
"@zhushanwen/pi-subagent-workflow": patch
---

Subagent 子进程镜像主进程的 extension/approve flag

新增 `mirrorMainProcessFlags(argv)`：从主 pi 进程的 `process.argv` 解析
`--extension` / `--no-extensions` / `--approve`，透传给 `buildSpawnArgs`，
让 subagent 子进程的 extension 加载行为与主进程一致（之前子进程完全不继承，
会加载全局自动发现的 extension 且不信任项目级 .pi/skills）。

- 数据源是主进程 argv（已运行时验证完整保留启动 flag），非 env 传递
- 向后兼容：argv 无这些 flag 时 `buildSpawnArgs` 行为完全不变
- 对任意 pi 宿主通用（不只 xyz-agent），xyz-agent 侧零改动
- 嵌套 subagent（孙进程）自动继承——镜像后父进程 argv 自带这些 flag
