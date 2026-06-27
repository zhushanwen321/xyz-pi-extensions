import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import systemPromptLoader from "../src/index.ts";

/**
 * W5 src/index.ts 验证测试（覆盖 UC-1 index 编排 + UC-2 注入时序）。
 *
 * index.ts 是 Adapter 入口（Pi API/事件契约）。通过 default export 注册 session_start/before_agent_start
 * 两 handler。handlers 内部非导出，故通过 public API surface 测：调 systemPromptLoader(mockPi)
 * 捕获 handler 注册，再用 mock ctx/event 触发。
 *
 * index.ts 骨架已完整实现（CA-12 时序翻转、safeNotify、resolveNativeRealPaths）。纯验证测试，不改 index.ts。
 *
 * 隔离策略：用受控 process.env.HOME 让 handleSessionStart 的 homedir() 指向 tmpdir，
 * 写真实 config.json + 规则文件，mock ExtensionAPI（捕获 pi.on 注册）+ ExtensionContext（notify spy）。
 * 这比 vi.mock config/discovery/engine 更真实地验 CA-12 编排闭环（config/discovery/engine 已各层单测覆盖）。
 *
 * 覆盖 AC / 用例：
 * - T1.11 / SV-3（缓存写入：session_start 完成→cached 闭包赋值，before_agent_start 能读到）
 * - T1.12 / SV-3（闭包无竞态：写一次读多次，单 session 线性）
 * - T1.15 / AC-6.4 + NFR-AC-7 + BC-14（notify 文案 "N collected"，>0 notify / =0 不 notify）
 * - T1.19 / AC-6.5 + BC-10（safeNotify stale-context 容错：stale 吞，非 stale 重抛）
 * - T2.1 / AC-6.2 + BC-13（有规则→返回含 systemPrompt 对象）
 * - T2.2 / AC-6.2 + BC-13（无规则→void 零副作用）
 * - T2.5 / AC-6.1 + NFR-AC-5（contextFile realPath 排除，CA-12 在 before_agent_start）
 * - T2.6 / AC-6.1 + NFR-AC-6（contextFile realpath 失败保守不纳入排除集）
 * - T1.3 端到端 / AC-6.6 + NFR-AC-1（JSON 失败→safeNotify 警告+降级空配置，session 不中断）
 * - T1.4 端到端 / AC-6.7 + NFR-AC-2（source 校验失败→safeNotify 跳过该 source，其余正常）
 * - AC-6.3（两阶段时序 BC-8：session_start 收集+缓存，before_agent_start 排除+build）
 * - AC-6.8（tsc 跨模块类型最终验收——W7 复核）
 * - AC-6.9（LOC ≤ ~75——wc 复核 W7；CA-12 后职责增，行为正确为准）
 */

/** config.json 在 home 下的固定路径（与 handleSessionStart 一致）。 */
function configPath(home: string): string {
  return path.join(
    home,
    ".pi",
    "agent",
    "extensions",
    "system-prompt-loader",
    "config.json",
  );
}

/**
 * tmpdir fixture：构造 fake home + 可写 config.json。
 * 受控 process.env.HOME 让 handleSessionStart 的 homedir() 指向 fake home。
 * 提供 mock ExtensionAPI（捕获 pi.on 注册）+ ExtensionContext（notify spy）。
 */
function useExtensionFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spl-idx-home-"));
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  const notifyCalls: Array<{ msg: string; type: string }> = [];
  let notifyImpl: (msg: string, type?: "info" | "warning" | "error") => void = (
    msg,
    type = "info",
  ) => {
    notifyCalls.push({ msg, type });
  };

  /** 捕获的 handler（精确事件类型，避免 as never 抹类型）。 */
  const sessionStartHandler = vi.fn();
  const beforeAgentStartHandler = vi.fn();
  // mock pi：仅实现 .on（捕获注册），用 Pick 子集单次断言（命名类型，非 unknown 双断言）。
  const pi = {
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      if (event === "session_start") sessionStartHandler.mockImplementation(handler);
      if (event === "before_agent_start") beforeAgentStartHandler.mockImplementation(handler);
    },
  };
  // 实例化扩展（注册 handler）——ExtensionAPI 有 30+ 方法，测试只用到 .on；
  // 单次 as 命名类型断言（taste/no-unsafe-cast 仅拦 as never/any/unknown as，不拦单次命名断言）。
  systemPromptLoader(pi as unknown as ExtensionAPI);

  /** mock ctx：仅 ui.notify + cwd（ExtensionContext 必填字段）。notify 委托到可替换的 notifyImpl。 */
  const ctx = {
    ui: { notify: (msg: string, type?: "info" | "warning" | "error") => notifyImpl(msg, type) },
    cwd: home,
  } as unknown as ExtensionContext;

  const triggerSessionStart = (reason: SessionStartEvent["reason"] = "startup") => {
    sessionStartHandler({ type: "session_start", reason }, ctx);
  };

  const triggerBeforeAgentStart = (
    systemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"],
    basePrompt = "BASE",
  ): BeforeAgentStartEventResult | void =>
    beforeAgentStartHandler(
      {
        type: "before_agent_start",
        prompt: "test",
        systemPrompt: basePrompt,
        systemPromptOptions,
      },
      ctx,
    ) as BeforeAgentStartEventResult | void;

  const writeConfig = (sources: unknown[]): void => {
    fs.writeFileSync(
      configPath(home),
      JSON.stringify({ "system-prompt-loader": { sources } }),
    );
  };
  const writeRawConfig = (content: string): void => {
    fs.writeFileSync(configPath(home), content);
  };
  const writeRule = (rel: string, body: string): string => {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };
  /** 替换 notify 实现（用于 T1.19 让 notify 抛错）。 */
  const setNotifyImpl = (fn: (msg: string, type?: "info" | "warning" | "error") => void) => {
    notifyImpl = fn;
  };

  return {
    home,
    notifyCalls,
    pi,
    ctx,
    triggerSessionStart,
    triggerBeforeAgentStart,
    writeConfig,
    writeRawConfig,
    writeRule,
    setNotifyImpl,
    cleanup: () => {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("T1.11 / SV-3 缓存写入：session_start 完成→cached 闭包赋值", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("session_start 收集规则后，before_agent_start 能读到缓存（返回含 systemPrompt 对象）", () => {
    const rule = fx.writeRule("rule.md", "CACHED RULE BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);

    fx.triggerSessionStart(); // 写缓存
    const result = fx.triggerBeforeAgentStart({ cwd: fx.home }); // 读缓存

    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain("CACHED RULE BODY"); // 缓存生效
  });
});

describe("T1.12 / SV-3 闭包无竞态：写一次读多次", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("单次 session_start 后多次 before_agent_start 读取同一缓存，结果一致（线性无竞态）", () => {
    const rule = fx.writeRule("stable.md", "STABLE BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);
    fx.triggerSessionStart();

    const r1 = fx.triggerBeforeAgentStart({ cwd: fx.home });
    const r2 = fx.triggerBeforeAgentStart({ cwd: fx.home });
    const r3 = fx.triggerBeforeAgentStart({ cwd: fx.home });

    // 三次读取结果一致（缓存未变）
    expect(r1?.systemPrompt).toBe(r2?.systemPrompt);
    expect(r2?.systemPrompt).toBe(r3?.systemPrompt);
    expect(r1?.systemPrompt).toContain("STABLE BODY");
  });
});

describe("T1.15 / AC-6.4 + BC-14 notify 文案", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("collected>0 → notify \"System prompt loader: N collected\"（N=实际收集数）", () => {
    fx.writeRule("a.md", "a body");
    fx.writeRule("b.md", "b body");
    fx.writeConfig([
      { kind: "explicit", path: path.join(fx.home, "a.md") },
      { kind: "explicit", path: path.join(fx.home, "b.md") },
    ]);
    fx.triggerSessionStart();
    expect(fx.notifyCalls).toContainEqual({
      msg: "System prompt loader: 2 collected",
      type: "info",
    });
  });

  it("collected=0（空配置）→ 不 notify（NFR-AC-7）", () => {
    fx.writeConfig([]); // 零 source → 零收集
    fx.triggerSessionStart();
    expect(fx.notifyCalls).toHaveLength(0);
  });

  it("collected=0（配置缺失 ENOENT）→ 不 notify", () => {
    // 不写 config.json → loadConfig ENOENT → 空配置
    fx.triggerSessionStart();
    expect(fx.notifyCalls).toHaveLength(0);
  });
});

describe("T1.19 / AC-6.5 + BC-10 safeNotify stale-context 容错", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("stale context 错误（\"Extension context no longer active\"）被吞，session 不中断", () => {
    // 让 notify 抛 stale 错误；触发 notify 需有规则（collected>0）
    fx.writeRule("r.md", "body");
    fx.writeConfig([{ kind: "explicit", path: path.join(fx.home, "r.md") }]);
    fx.setNotifyImpl(() => {
      throw new Error("Extension context no longer active");
    });
    // 不应重抛
    expect(() => fx.triggerSessionStart()).not.toThrow();
  });

  it("非 stale 错误重抛（不吞）", () => {
    fx.writeRule("r.md", "body");
    fx.writeConfig([{ kind: "explicit", path: path.join(fx.home, "r.md") }]);
    fx.setNotifyImpl(() => {
      throw new Error("some other UI error");
    });
    expect(() => fx.triggerSessionStart()).toThrow("some other UI error");
  });
});

describe("T2.1 / AC-6.2 + BC-13 有规则→返回含 systemPrompt 对象", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("cached 有规则 → buildSuffix 非 null → 返回 { systemPrompt: base + suffix }", () => {
    fx.writeRule("inject.md", "INJECT BODY");
    fx.writeConfig([{ kind: "explicit", path: path.join(fx.home, "inject.md") }]);
    fx.triggerSessionStart();

    const result = fx.triggerBeforeAgentStart({ cwd: fx.home }, "BASE PROMPT");
    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain("BASE PROMPT"); // 原始 systemPrompt 保留
    expect(result?.systemPrompt).toContain("INJECT BODY"); // suffix 追加
    // 以 base + 分隔 + suffix 形式拼接
    expect(result?.systemPrompt?.startsWith("BASE PROMPT")).toBe(true);
  });
});

describe("T2.2 / AC-6.2 + BC-13 无规则→void 零副作用", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("cached 空 → buildSuffix null → 返回 void", () => {
    fx.triggerSessionStart(); // 空配置 → cached.rules=[]
    const result = fx.triggerBeforeAgentStart({ cwd: fx.home }, "BASE");
    expect(result).toBeUndefined(); // void 零副作用
  });
});

describe("T2.5 / AC-6.1 + NFR-AC-5 contextFile realPath 排除", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("RuleFile realPath ∈ nativeRealPaths → 从输出排除（CA-12 在 before_agent_start）", () => {
    const rule = fx.writeRule("dup.md", "DUP BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);
    fx.triggerSessionStart();

    // 把同一规则文件作为 contextFile 传入 → realpath 命中 → 排除 → void
    const result = fx.triggerBeforeAgentStart({
      cwd: fx.home,
      contextFiles: [{ path: rule, content: "DUP BODY" }],
    });
    expect(result).toBeUndefined(); // 被排除，零注入
  });

  it("非 contextFile 的规则正常注入（排除只针对命中 realPath 的）", () => {
    const rule = fx.writeRule("keep.md", "KEEP BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);
    fx.triggerSessionStart();
    // contextFile 是另一个不存在的文件 → 不命中 → 规则正常注入
    const result = fx.triggerBeforeAgentStart({
      cwd: fx.home,
      contextFiles: [{ path: path.join(fx.home, "other.md"), content: "x" }],
    });
    expect(result?.systemPrompt).toContain("KEEP BODY");
  });
});

describe("T2.6 / AC-6.1 + NFR-AC-6 contextFile realpath 失败保守", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("contextFile realpath 失败（ENOENT/断链）→ 不纳入排除集 → 规则正常注入（保守）", () => {
    const rule = fx.writeRule("safe.md", "SAFE BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);
    fx.triggerSessionStart();
    // 不存在的 contextFile → realpathSync 失败 → 不纳入排除集
    const result = fx.triggerBeforeAgentStart({
      cwd: fx.home,
      contextFiles: [{ path: "/definitely/nonexistent/missing.md", content: "x" }],
    });
    expect(result?.systemPrompt).toContain("SAFE BODY"); // 规则未被误排除
  });
});

describe("T1.3 端到端 / AC-6.6 + NFR-AC-1 JSON 失败 safeNotify 降级", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("config.json 非法 JSON → safeNotify 警告 + 降级空配置，session 不中断", () => {
    fx.writeRawConfig("{invalid json"); // 非法 JSON
    // 不 throw（safeNotify 降级闭环）
    expect(() => fx.triggerSessionStart()).not.toThrow();
    // warning notify 触发
    const warning = fx.notifyCalls.find((c) => c.type === "warning");
    expect(warning).toBeDefined();
    expect(warning?.msg).toContain("配置 JSON 解析失败");
    // 降级为空配置 → before_agent_start void
    expect(fx.triggerBeforeAgentStart({ cwd: fx.home })).toBeUndefined();
  });
});

describe("T1.4 端到端 / AC-6.7 + NFR-AC-2 source 校验失败 safeNotify 跳过", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("某 source 校验失败 → safeNotify 该 source + 跳过，其余正常", () => {
    const good = fx.writeRule("good.md", "GOOD BODY");
    fx.writeConfig([
      // 坏 source：unknown kind（validateSource 判 {ok:false}）
      { kind: "unknown-kind" },
      // 好源
      { kind: "explicit", path: good },
    ]);
    fx.triggerSessionStart();

    // warning notify 含校验失败信息
    const warning = fx.notifyCalls.find(
      (c) => c.type === "warning" && c.msg.includes("已跳过"),
    );
    expect(warning).toBeDefined();
    // 好源仍被收集+注入（坏源被跳过）
    const result = fx.triggerBeforeAgentStart({ cwd: fx.home });
    expect(result?.systemPrompt).toContain("GOOD BODY");
  });

  it("缺必填字段的 source 被跳过（validateSource {ok:false}）", () => {
    fx.writeConfig([
      // explicit 缺 path
      { kind: "explicit" },
      { kind: "glob", patterns: ["*.md"] }, // glob 无文件但合法
    ]);
    expect(() => fx.triggerSessionStart()).not.toThrow();
    const warning = fx.notifyCalls.find((c) => c.type === "warning");
    expect(warning).toBeDefined();
  });
});

describe("AC-6.3 两阶段时序 BC-8", () => {
  let fx: ReturnType<typeof useExtensionFixture>;
  beforeEach(() => {
    fx = useExtensionFixture();
  });
  afterEach(() => fx.cleanup());

  it("session_start 只收集+缓存（不去重/不排除 contextFile）；before_agent_start 做排除+build", () => {
    const rule = fx.writeRule("seq.md", "SEQ BODY");
    fx.writeConfig([{ kind: "explicit", path: rule }]);

    // session_start 后：规则已缓存（before_agent_start 不带 contextFile 时能注入 = 缓存存在）
    fx.triggerSessionStart();
    const noExclude = fx.triggerBeforeAgentStart({ cwd: fx.home });
    expect(noExclude?.systemPrompt).toContain("SEQ BODY");

    // before_agent_start 带 contextFile（同一规则）→ 此处排除（排除逻辑在 before_agent_start）
    const withExclude = fx.triggerBeforeAgentStart({
      cwd: fx.home,
      contextFiles: [{ path: rule, content: "SEQ BODY" }],
    });
    expect(withExclude).toBeUndefined(); // 排除发生在 before_agent_start
  });
});
