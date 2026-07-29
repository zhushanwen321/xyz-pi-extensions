# @zhushanwen/pi-permission

## 0.1.0

### Minor Changes

- 66a42a4: Permission footer migration + onboarding widget

  - permission: removed self-managed footer, now registers footer line via globalThis Symbol handshake to statusline (solves footer single-slot conflict)
  - permission: added status widget showing rule count + classifier model (auto mode, since removed — see hotfix below)
  - statusline: upgraded to footer canonical owner (footer-handshake-access.ts), buildLines aggregates external lines
  - statusline: simplified line2 (speed/cache show current only, removed day marker, since restored — see hotfix below)

  # Hotfix — restore speed/cache day metrics + merge widget info into footer

  Two regressions from W1/W2 fixed in patch (0.4.8 → 0.4.9):

  - statusline: restore dual-value display for speed/cache (was oversimplified to current-only in W1):
    `speed 58t/s · day 70t/s` / `cache 96% · day 91%`. current=0/null hides whole segment.
  - permission: delete the standalone widget (classifier model moved to a widget in W2, leaving footer
    with only mode + enabled); merge all info into the footer line:
    `[permission] auto · enabled · N user rule(s) · classifier: <model>`
    classifier shown only in auto mode with non-empty model.
  - permission: replace `refreshWidget(ctx)` calls with `requestFooterRender()`.

  BREAKING CHANGE for permission-only users (no statusline installed): footer mode label is no longer displayed. Install @zhushanwen/pi-statusline to restore, or use /permission status.

### Patch Changes

- Updated dependencies [66a42a4]
  - @zhushanwen/pi-statusline@0.4.9

## 0.1.0 (unreleased)

### Breaking Changes

- **白名单扩张**：内置安全白名单从 24+5 扩至 50+9（新增 diff/jq/ps/du/file/sort/iconv 等）。auto/approve 模式下，这些命令从「需审批/AI 判」变为「静默放行」。已有用户若依赖这些命令触发审批，需自行添加 user rule。
- **approval 键位**：TUI 审批对话框移除 y/n 快捷键，仅保留 Enter（approve）/ Esc（deny）。
- **classifier prompt 改写**：auto 模式 AI 判定标准变化——写项目/cwd 目录的操作倾向 allow，写系统目录（~/.ssh、/etc）倾向 ask。

### Features

- 四档权限模式（yolo/auto/approve/strict）
- 三层管道（AST + 规则 + AI Classifier）
- rule editor（/permission rule overlay CRUD）
- model picker（/permission model）
- statusline footer 集成
