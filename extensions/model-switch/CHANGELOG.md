# @zhushanwen/pi-model-switch

## 0.2.10

### Patch Changes

- Remove per-turn context injection from model-switch; make model-switch an optional peer dep of workflow

## 0.2.9

### Patch Changes

- Updated dependencies [00fb8bd]
  - @zhushanwen/pi-quota-providers@0.5.1

## 0.2.8

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.5.0

## 0.2.7

### Patch Changes

- Fix systemPrompt overwrite bug and KV cache hostile injection

  - Bug A: systemPrompt was completely replacing base prompt instead of appending to event.systemPrompt
  - Bug B: Dynamic context injected into systemPrompt every turn broke KV prefix cache (~10x cost). Split into static systemPrompt (injected once) + dynamic customType message (per-turn)
  - Extract computeSnapshotAndRecommend() to eliminate duplication
  - Extract findModelMatch() to reduce handleSwitch complexity
  - Add @mariozechner/pi-tui and typebox to peerDependencies

## 0.2.6

### Patch Changes

- Audit and fix all 11 extensions against project specifications

## 0.2.5

### Patch Changes

- 8079ae5: Fix config path mismatch and add v1 config migration. The extension was looking for config at `~/.pi/agent/extensions/model-switch/model-policy.json` but the actual file is at `~/.pi/agent/model-policy.json`. Also adds v1→v2 config format migration, proactive model switching triggers in promptSnippet, and specific action recommendations in context injection.

## 0.2.3

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [045ade1]
  - @zhushanwen/pi-quota-providers@0.4.0

## 0.2.0

### Minor Changes

- model-switch v2 redesign: provider-keyed config, deterministic recommend, clear prompt labels. quota-providers: normalize IDs to kebab-case.

### Patch Changes

- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.2

## 0.1.1

### Patch Changes

- Fix GATE_SCRIPT_PATH path for npm packaging, module-level state encapsulation, execute error handling compliance, peerDependencies cleanup, ANSI escaping removal, and directory restructuring
- Updated dependencies
  - @zhushanwen/pi-quota-providers@0.1.1
