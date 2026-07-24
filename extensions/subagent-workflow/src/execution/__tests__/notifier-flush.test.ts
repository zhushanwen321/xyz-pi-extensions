/**
 * BgNotifier flushPendingNotifications — deliverAs 契约（FR-3/AC-3）。
 *
 * 修复：deliverAs 从 'followUp' 改为 'steer'，确保 subagent 完成通知在主 agent
 * 处于 processing 状态（如轮询 loop）时也能立即抢占下一个 turn。
 *
 * 修复背景：commit d214d0d83 已验证 steer 能避免 'Agent is already processing'；
 * workflow helpers.ts:151 已在同语义下用 steer。
 *
 * 测试方法：mock NotifierHost，捕获 sendMessage 调用参数，断言 deliverAs === 'steer'。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgNotifier, type NotifierHost } from "../notifier.ts";

/** mock host：捕获所有 sendMessage 调用 + 控制 hasRunningBackground + isIdle。 */
function makeMockHost(): NotifierHost & {
	sendMessageCalls: { message: unknown; options: unknown }[];
	hasRunningBackground: ReturnType<typeof vi.fn>;
	isIdle: ReturnType<typeof vi.fn>;
} {
	const sendMessageCalls: { message: unknown; options: unknown }[] = [];
	const hasRunningBackground = vi.fn(() => false);
	const isIdle = vi.fn(() => true);
	return {
		sendMessageCalls,
		hasRunningBackground,
		isIdle,
		sendMessage(message, options) {
			sendMessageCalls.push({ message, options });
		},
	};
}

describe("BgNotifier.flushPendingNotifications — deliverAs 契约", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		host = makeMockHost();
		notifier = new BgNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
	});

	it("flush 时调 sendMessage 的 options.deliverAs === 'steer'（FR-3/AC-3）", () => {
		notifier.notify({
			id: "bg-test-1",
			status: "done",
			agent: "explorer",
			result: "done",
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
		});

		// hasRunningBackground=false → notify 立即 flush
		expect(host.sendMessageCalls).toHaveLength(1);
		const call = host.sendMessageCalls[0];
		expect(call.options).toMatchObject({ deliverAs: "steer" });
	});

	it("flush 时 triggerTurn 也必须为 true（让父 agent 立即唤醒）", () => {
		notifier.notify({
			id: "bg-test-2",
			status: "failed",
			agent: "worker",
			error: "boom",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		expect(host.sendMessageCalls).toHaveLength(1);
		expect(host.sendMessageCalls[0].options).toMatchObject({
			triggerTurn: true,
			deliverAs: "steer",
		});
	});
});

describe("BgNotifier — isIdle gate 竞态修复", () => {
	let host: ReturnType<typeof makeMockHost>;
	let notifier: BgNotifier;

	beforeEach(() => {
		vi.useFakeTimers();
		host = makeMockHost();
		notifier = new BgNotifier(host);
	});

	afterEach(() => {
		notifier.dispose();
		vi.useRealTimers();
	});

	it("主 agent busy 时 flush 退避，idle 后才 sendMessage（规避 agent_end→finishRun 竞态窗口）", () => {
		// 模拟竞态：notify 时主 agent 仍 streaming（isIdle=false）
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-race-1",
			status: "done",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		// busy 退避：未发送
		expect(host.sendMessageCalls).toHaveLength(0);
		expect(host.isIdle).toHaveBeenCalled();

		// 推进 1 个退避间隔（100ms）——仍 busy，继续退避
		vi.advanceTimersByTime(100);
		expect(host.sendMessageCalls).toHaveLength(0);

		// 主 agent 变 idle
		host.isIdle.mockReturnValue(true);
		vi.advanceTimersByTime(100);

		// idle 后发送，deliverAs=steer + triggerTurn=true
		expect(host.sendMessageCalls).toHaveLength(1);
		expect(host.sendMessageCalls[0].options).toMatchObject({
			triggerTurn: true,
			deliverAs: "steer",
		});
	});

	it("主 agent 持续 busy 达退避上限后强制发送（防通知饿死）", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-starve-1",
			status: "done",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		expect(host.sendMessageCalls).toHaveLength(0);
		// 推进超过退避上限（50 × 100ms = 5s）
		vi.advanceTimersByTime(10_000);

		// 达上限后 fallthrough 强制发送（至少不丢消息）
		expect(host.sendMessageCalls).toHaveLength(1);
	});

	it("未注入 isIdle 时不 gate，保持原立即发送行为（向后兼容）", () => {
		// 重建无 isIdle 的 host（模拟旧调用方/测试 host）
		const legacyHost: NotifierHost = {
			sendMessage: (message, options) => host.sendMessage(message, options),
			hasRunningBackground: () => false,
		};
		const legacyNotifier = new BgNotifier(legacyHost);
		legacyNotifier.notify({
			id: "bg-legacy-1",
			status: "done",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		// 无 isIdle gate → 立即发送
		expect(host.sendMessageCalls).toHaveLength(1);
		legacyNotifier.dispose();
	});

	it("dispose 后退避 timer 不再触发发送", () => {
		host.isIdle.mockReturnValue(false);
		notifier.notify({
			id: "bg-dispose-1",
			status: "done",
			agent: "worker",
			result: "ok",
			startedAt: Date.now(),
			endedAt: Date.now(),
		});

		notifier.dispose();
		// 推进足够久，退避 timer 若未清会触发
		vi.advanceTimersByTime(10_000);
		expect(host.sendMessageCalls).toHaveLength(0);
	});
});