---
verdict: pass
---

# Use Cases — Monorepo 合并

## UC-1: 扩展开发者跨仓库改动

- **Actor**: 项目维护者
- **Preconditions**:
  - monorepo 结构已建立
  - 两个仓库的代码已合并
- **Main Flow**:
  1. 维护者发现 subagent 的 model resolve 需要增加新策略
  2. 修改 `packages/subagent/src/model.ts`
  3. 运行 `pnpm -r typecheck` 验证
  4. coding-workflow 通过 `workspace:*` 依赖自动获得更新
  5. 创建 changeset，提交 PR
- **Alternative Paths**:
  - AP-1: 如果改动影响 coding-workflow 的调用方式 → coding-workflow 也需要对应修改，但在同一个 PR 中完成
- **Postconditions**: 所有依赖 subagent 的包自动获得更新，无需跨仓库 PR
- **Module Boundaries**: `packages/subagent/` 是独立包，`packages/coding-workflow/` 通过 workspace 协议依赖它
- **Spec AC 覆盖**: AC-4（依赖关系）

## UC-2: 用户安装 Pi 扩展

- **Actor**: Pi 用户
- **Preconditions**:
  - npm 包已发布到 @zhushanwen scope
  - 用户已安装 Pi
- **Main Flow**:
  1. 用户运行 `npm install @zhushanwen/pi-goal`
  2. npm 包安装到 `node_modules/@zhushanwen/pi-goal/`
  3. 用户通过 `pi --extension` 参数或配置加载 extension
  4. goal extension 正常工作
- **Alternative Paths**:
  - AP-1: 用户想安装 coding-workflow → `npm install @zhushanwen/pi-coding-workflow`，内嵌 skills 通过 `resources_discover` 自动注册
  - AP-2: 用户想使用独立 skill（如 create-worktree） → 需要手动从 GitHub clone 或 symlink
- **Postconditions**: extension 功能可用，版本可追踪可回退
- **Module Boundaries**: npm registry（公开分发）、`resources_discover` 事件（skill 注册）
- **Spec AC 覆盖**: AC-2（npm 包可发布）

## UC-3: 扩展版本发布

- **Actor**: 项目维护者
- **Preconditions**:
  - monorepo 中已完成功能开发
  - 所有 typecheck 通过
- **Main Flow**:
  1. 维护者运行 `pnpm changeset` 记录变更
  2. 选择受影响的包和变更类型（major/minor/patch）
  3. 运行 `pnpm changeset version` 更新版本号
  4. 提交 version change
  5. CI 运行 `pnpm changeset publish` 发布到 npm
- **Alternative Paths**: 无
- **Postconditions**: 指定包的新版本发布到 npm，Release Notes 自动生成
- **Module Boundaries**: `.changeset/` 目录（变更记录）、npm registry（发布目标）
- **Spec AC 覆盖**: AC-2（npm 包可发布）

## UC-4: 维护者迁移 harness skill

- **Actor**: 项目维护者
- **Preconditions**:
  - monorepo 结构已建立
  - coding-workflow 有 resources_discover 处理器
- **Main Flow**:
  1. 新增 skill 到 `packages/coding-workflow/skills/<skill-name>/SKILL.md`
  2. Pi 启动时，coding-workflow 的 `session_start` 事件扫描 `skills/` 目录
  3. 通过 `resources_discover` 自动注册新 skill
  4. 用户使用 `/skill-name` 触发 skill
- **Alternative Paths**: 无
- **Postconditions**: 新 skill 自动对 Pi 可用，无需手动安装
- **Module Boundaries**: `packages/coding-workflow/skills/`（skill 资源目录）、`resources_discover` 事件（注册机制）
- **Spec AC 覆盖**: AC-2（resources_discover）、AC-3（代码迁移）

## UC-覆盖映射

| UC | 覆盖的 Spec AC |
|----|---------------|
| UC-1 | AC-4, AC-5 |
| UC-2 | AC-2 |
| UC-3 | AC-2 |
| UC-4 | AC-2, AC-3 |
