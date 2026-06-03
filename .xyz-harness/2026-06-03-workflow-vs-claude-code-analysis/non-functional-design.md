---
verdict: pass
---

# 非功能性设计 — Workflow model-switch 集成

## 1. 稳定性

model-switch 配置缺失或 advisor 抛异常时，workflow 不阻断执行，回退到 Pi 默认模型。降级路径覆盖所有异常分支（loadConfig 返回 null、scene 不存在、quota 查询失败）。风险点：如果 `resolveModelForScene` 的 import 路径在运行时解析失败（model-switch 包未安装），Pi 的 extension loader 会报错但 workflow 本身不受影响（import 在模块顶层，Pi 会 catch 住）。

## 2. 数据一致性

不涉及。本改动不写入任何持久化数据，只读取 model-policy.json 和 quota cache。model 切换不写入 callCache（cache 按 callId 索引）。

## 3. 性能

`resolveModelForScene()` 在每次 `agent()` 调用时执行一次。内部调用 `loadConfig()`（读文件）+ `readCache()`（读内存）+ `computePeakRecommend`（纯计算，<1ms）。总耗时 < 5ms，相对于 spawn Pi 子进程（~1-3s）可忽略。不引入额外的异步或 I/O 开销。

## 4. 业务安全

不适用。本改动不涉及用户输入处理、权限控制或敏感数据访问。scene 参数是脚本作者声明的固定字符串，不接受终端用户输入。

## 5. 数据安全

不涉及。不处理敏感信息，不修改文件系统（只读 model-policy.json 和 quota cache）。模型推荐结果通过命令行参数传递给子进程，不记录到日志以外的位置。
