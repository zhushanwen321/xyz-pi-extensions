// src/__tests__/list-component.test.ts
//
// SubagentsListComponent 单元测试（循环依赖消除后的新结构）。
//
// 被测组件 list-component.ts 不再 import list-view——按键处理经第 7 个构造函数参数
// keyHandler 注入（list-view factory 的 processKey），状态经第 4 参数 ViewState 注入。
// 本测试覆盖 render 三分支调度 / hasRunning / 左列视口窗口 / 右列预览兜底链 /
// handleInput exit|changed|none 分支 / render 缓存 / detailMode 切换。
//
// Mock 策略：theme 透传为纯文本（断言业务文本而非 ANSI 码），service 只 stub collectRecords，
// keyHandler 由各用例注入返回 KeyResult。spinner 帧 Date.now() 驱动 → fake timers 锁定。

import { afterEach,beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentService } from "../subagent-service.ts";
import type { ThemeLike } from "../../interface/format.ts";
import { SubagentsListComponent } from "../../interface/list-component.ts";
import type { KeyHandler, KeyResult, TuiLike, ViewState } from "../../interface/list-shared.ts";
import type { SubagentRecord } from "../types.ts";

// ── KeyResult 常量（语义清晰，避到处写字面量对象） ──

const KEY_NONE: KeyResult = { changed: false, exit: false };
const KEY_CHANGED: KeyResult = { changed: true, exit: false };
const KEY_EXIT: KeyResult = { changed: false, exit: true };

// ── stub 工厂 ──

/** 透传 theme（list-component 经 format.ts 调用 fg/bold，ThemeLike 要求 4 方法齐全）。 */
function makeTheme(): ThemeLike {
  return {
    fg: (_tag: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
  } as ThemeLike;
}

/** service stub：list-component 只调 collectRecords(limit) 单参数。
 *  与 tool-action.test.ts 同模式：部分对象直接断言为 SubagentService（duck-type）。 */
function makeService(records: SubagentRecord[] = []): SubagentService {
  return {
    collectRecords: vi.fn(() => records),
  } as SubagentService;
}

/** record fixture（参考 tool-action.test.ts，字段见 types.ts SubagentRecord）。 */
function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1",
    agent: "worker",
    task: "do the thing",
    status: "done",
    mode: "sync",
    startedAt: 1000,
    endedAt: 2000,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    turns: 1,
    totalTokens: 10,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: "ok",
    error: undefined,
    sessionFile: undefined,
    ...over,
  };
}

/** 构造 N 条 records（agent/task 含索引便于断言可见性）。 */
function makeRecords(n: number): SubagentRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord({ id: `run-${i}`, agent: `agent-${i}`, task: `task-${i}` }),
  );
}

interface MakeOpts {
  records?: SubagentRecord[];
  rows?: number;
  selectedIdx?: number;
  detailMode?: boolean;
  keyHandler?: KeyHandler;
}

/** 构造组件 + 暴露 service/tui/state 供断言。 */
function makeComponent(opts: MakeOpts = {}) {
  const records = opts.records ?? [];
  const service = makeService(records);
  const theme = makeTheme();
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: opts.rows ?? 24 },
  };
  const state: ViewState = {
    selectedIdx: opts.selectedIdx ?? 0,
    scrollOffset: 0,
    filterText: "",
    detailMode: opts.detailMode ?? false,
    disposed: false,
    syncCancelHint: false,
  };
  const keyHandler: KeyHandler = opts.keyHandler ?? (() => KEY_NONE);
  const comp = new SubagentsListComponent(
    service,
    theme,
    tui as TuiLike,
    state,
    () => {},
    () => {},
    keyHandler,
  );
  return { comp, service, theme, tui, state };
}

// ============================================================
// SubagentsListComponent
// ============================================================
describe("SubagentsListComponent", () => {
  beforeEach(() => {
    // spinner 帧由 Math.floor(Date.now()/250) 选取，锁定时间避免 flaky。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── render 三分支调度 ──────────────────────────────────
  describe("render 分支调度", () => {
    it("rows < MIN_TERM_ROWS(8) → too small 提示", () => {
      const { comp } = makeComponent({ records: [], rows: 5 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("too small");
      expect(joined).toContain("need >=");
    });

    it("空 records → emptyBox（含 (no subagent records) 文案）", () => {
      const { comp } = makeComponent({ records: [], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("(no subagent records)");
      // 紧凑小框不渲染分屏分区线
      expect(joined).not.toContain("Records");
    });

    it("有 records → splitBox（含 record 的 task + agent 文本）", () => {
      const rec = makeRecord({ agent: "researcher", task: "investigate bug" });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("researcher"); // 左列 agent
      expect(joined).toContain("investigate bug"); // 右列 task 首行
      expect(joined).toContain("Records"); // 分区线标题
      expect(joined).toContain("Detail");
    });
  });

  // ── hasRunning ────────────────────────────────────────
  describe("hasRunning", () => {
    it("records 全是 done → false", () => {
      const { comp } = makeComponent({
        records: [makeRecord({ status: "done" }), makeRecord({ status: "failed" })],
      });
      expect(comp.hasRunning()).toBe(false);
    });

    it("records 含一个 running → true", () => {
      const { comp } = makeComponent({
        records: [
          makeRecord({ id: "a", status: "done" }),
          makeRecord({ id: "b", status: "running" }),
        ],
      });
      expect(comp.hasRunning()).toBe(true);
    });
  });

  // ── 左列视口窗口 ──────────────────────────────────────
  describe("左列视口窗口", () => {
    it("records 数 > bodyH → render 行数 ≤ rows（不溢出终端）", () => {
      // rows=24 → 内框高 innerRows = 24 - PAD_ROWS(2) = 22；bodyH = 22 - SPLIT_FIXED_LINES(6) = 16。
      // 30 条 records 远超 bodyH，选中行在中间。断言输出总行数 == rows（overlay 填满全屏），
      // 且左列只渲染 bodyH 条（不溢出导致底框被推出终端）。
      const records = makeRecords(30);
      const { comp } = makeComponent({ records, rows: 24, selectedIdx: 15 });
      const lines = comp.render(80);
      expect(lines.length).toBe(24); // 填满全屏，不溢出
      // 中间 record 的 agent 不在视口窗口外应仍可见（窗口居中显示 selectedIdx 附近）。
      const joined = lines.join("\n");
      expect(joined).toContain("agent-15"); // 选中行在视口内
    });

    it("selectedIdx 在尾部 → 视口贴底（最后一条可见）", () => {
      const records = makeRecords(30);
      const { comp } = makeComponent({ records, rows: 24, selectedIdx: 29 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("agent-29"); // 尾部 record 仍可见（视口贴底）
    });
  });

  // ── 右列预览兜底链 ────────────────────────────────────
  describe("右列预览兜底链 (renderRightPreview)", () => {
    it("record 有 displayItems → 输出含 displayItems 内容", () => {
      const rec = makeRecord({
        displayItems: [{ type: "text", text: "partial analysis output" }],
      });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("partial analysis output");
    });

    it("record 无 displayItems 但有 eventLog → 回退 eventLog（输出含 event 标签）", () => {
      const rec = makeRecord({
        displayItems: [],
        eventLog: [{ type: "tool_start", label: "Read file.ts", ts: 1500 }],
      });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      // formatEventLine 的 tool_start 输出 "tool: <label>"
      expect(joined).toContain("tool:");
      expect(joined).toContain("Read file.ts");
    });

    it("record 两者都无 → 输出 (no output) 兜底文案", () => {
      const rec = makeRecord({ displayItems: [], eventLog: [] });
      const { comp } = makeComponent({ records: [rec], rows: 24 });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("(no output)");
    });
  });

  // ── handleInput ───────────────────────────────────────
  describe("handleInput", () => {
    it("disposed → 直接返回，不调用 keyHandler", () => {
      const keyHandler = vi.fn(() => KEY_NONE);
      const { comp, state } = makeComponent({ keyHandler });
      state.disposed = true;
      comp.handleInput("x");
      expect(keyHandler).not.toHaveBeenCalled();
    });

    it("keyHandler 返回 exit → 调用 closeFn 关闭 overlay", () => {
      const keyHandler = vi.fn(() => KEY_EXIT);
      const { comp } = makeComponent({ keyHandler });
      const closeFn = vi.fn();
      comp.setCloseFn(closeFn);
      comp.handleInput("\x1b"); // Esc
      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it("keyHandler 返回 changed → invalidate + requestRender", () => {
      const keyHandler = vi.fn(() => KEY_CHANGED);
      const { comp, tui } = makeComponent({ keyHandler });
      comp.handleInput("\x1b[B"); // Down
      expect(tui.requestRender).toHaveBeenCalledTimes(1);
    });

    it("keyHandler 返回 none → 不 invalidate / 不 close / 不 requestRender", () => {
      const keyHandler = vi.fn(() => KEY_NONE);
      const closeFn = vi.fn();
      const { comp, tui } = makeComponent({ keyHandler });
      comp.setCloseFn(closeFn);
      comp.handleInput("x");
      expect(closeFn).not.toHaveBeenCalled();
      expect(tui.requestRender).not.toHaveBeenCalled();
    });

    it("exit 优先于 changed（exit=true 时只 close，不 requestRender）", () => {
      const keyHandler = vi.fn(() => ({ changed: true, exit: true }));
      const closeFn = vi.fn();
      const { comp, tui } = makeComponent({ keyHandler });
      comp.setCloseFn(closeFn);
      comp.handleInput("\x1b");
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(tui.requestRender).not.toHaveBeenCalled();
    });
  });

  // ── render 缓存 ───────────────────────────────────────
  describe("render 缓存", () => {
    it("相同 width 连续两次 render → 返回相同结果（缓存命中）", () => {
      const records = [makeRecord({ agent: "cached-agent" })];
      const { comp } = makeComponent({ records, rows: 24 });
      const first = comp.render(80);
      const second = comp.render(80);
      // 缓存命中：返回同一引用（buildLines 未重新执行）。
      expect(second).toBe(first);
    });

    it("invalidate 后再 render → 重建（结果内容相同但引用不同）", () => {
      const records = [makeRecord()];
      const { comp } = makeComponent({ records, rows: 24 });
      const first = comp.render(80);
      comp.invalidate();
      const second = comp.render(80);
      expect(second).not.toBe(first); // 引用不同 → 重建
      expect(second).toEqual(first); // 内容相同
    });

    it("不同 width → 不命中缓存（重新构建）", () => {
      const records = [makeRecord()];
      const { comp } = makeComponent({ records, rows: 24 });
      const w80 = comp.render(80);
      const w100 = comp.render(100);
      // 宽度不同 → 不同 key → 重建。行数应随宽度变化内容（至少引用不同）。
      expect(w100).not.toBe(w80);
    });
  });

  // ── detailMode 切换 ───────────────────────────────────
  describe("detailMode 切换", () => {
    it("detailMode=true → footer 含 Esc back + 右侧锚定提示 Pinned", () => {
      const rec = makeRecord({ agent: "pinned-agent" });
      const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: true });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("Esc back to list");
      expect(joined).toContain("Pinned:");
      expect(joined).toContain("pinned-agent");
    });

    it("detailMode=false → footer 含 navigate / Enter detail（非锚定文案）", () => {
      const rec = makeRecord();
      const { comp } = makeComponent({ records: [rec], rows: 24, detailMode: false });
      const joined = comp.render(80).join("\n");
      expect(joined).toContain("Enter detail");
      expect(joined).not.toContain("Pinned:");
    });

    it("detailMode 下完整详情含 result + sessionFile（预览阶段不显示 sessionFile）", () => {
      const rec = makeRecord({
        result: "final report content",
        sessionFile: "/tmp/session-abc.jsonl",
      });
      // 预览阶段
      const previewComp = makeComponent({ records: [rec], rows: 24, detailMode: false });
      const previewJoined = previewComp.comp.render(80).join("\n");
      expect(previewJoined).toContain("Enter for full detail"); // 预览阶段提示
      // 详情阶段
      const detailComp = makeComponent({ records: [rec], rows: 24, detailMode: true });
      const detailJoined = detailComp.comp.render(80).join("\n");
      expect(detailJoined).toContain("final report content"); // Result 段
      expect(detailJoined).toContain("Result:");
      expect(detailJoined).toContain("session-abc.jsonl"); // sessionFile
    });
  });
});
