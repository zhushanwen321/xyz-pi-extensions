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

/** mock host：捕获所有 sendMessage 调用 + 控制 hasRunningBackground。 */
function makeMockHost(): NotifierHost & {
	sendMessageCalls: { message: unknown; options: unknown }[];
	hasRunningBackground: ReturnType<typeof vi.fn>;
} {
	const sendMessageCalls: { message: unknown; options: unknown }[] = [];
	const hasRunningBackground = vi.fn(() => false);
	return {
		sendMessageCalls,
		hasRunningBackground,
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