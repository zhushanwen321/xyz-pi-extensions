/**
 * skill-registry 测试 — 直接 import extractSkillNames / isValidSkillName。
 *
 * 覆盖：<available_skills> 解析、<skill> 父元素限定（不误抓 tool/agent）、
 *       XML 反转义、fail-open 语义。
 */
import { describe, expect,it } from "vitest";

import { extractSkillNames, isValidSkillName } from "../trackers/skill-registry.js";

const SAMPLE_PROMPT = `
The following skills provide specialized instructions.
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Review code changes.</description>
    <location>/path/code-review/SKILL.md</location>
  </skill>
  <skill>
    <name>pull-request</name>
    <description>Submit PR.</description>
    <location>/path/pull-request/SKILL.md</location>
  </skill>
</available_skills>
`;

describe("extractSkillNames", () => {
  it("解析 <available_skills> 块中的所有 skill 名称", () => {
    const names = extractSkillNames(SAMPLE_PROMPT);
    expect(names.has("code-review")).toBe(true);
    expect(names.has("pull-request")).toBe(true);
    expect(names.size).toBe(2);
  });

  it("限定在 <skill> 父元素内，不误抓 tool/agent 的 <name> 标签", () => {
    const promptWithTools = `
<available_skills>
  <skill>
    <name>real-skill</name>
    <description>x</description>
  </skill>
</available_skills>
<available_tools>
  <tool>
    <name>read</name>
    <name>delegate</name>
  </tool>
</available_tools>
<available_agents>
  <agent>
    <name>planner</name>
  </agent>
</available_agents>`;
    const names = extractSkillNames(promptWithTools);
    expect(names.has("real-skill")).toBe(true);
    // tool/agent 的 name 不应被误判为 skill
    expect(names.has("read")).toBe(false);
    expect(names.has("delegate")).toBe(false);
    expect(names.has("planner")).toBe(false);
    expect(names.size).toBe(1);
  });

  it("XML 反转义：skill 名含 &amp; 等转义字符", () => {
    const prompt = `<available_skills>
  <skill>
    <name>a&amp;b</name>
    <description>x</description>
  </skill>
</available_skills>`;
    const names = extractSkillNames(prompt);
    expect(names.has("a&b")).toBe(true);
  });

  it("空 prompt 返回空集合", () => {
    expect(extractSkillNames("").size).toBe(0);
  });

  it("无 <available_skills> 块返回空集合", () => {
    expect(extractSkillNames("no skills here").size).toBe(0);
  });
});

describe("isValidSkillName", () => {
  it("在 available_skills 中的名称返回 true", () => {
    expect(isValidSkillName("code-review", SAMPLE_PROMPT)).toBe(true);
    expect(isValidSkillName("pull-request", SAMPLE_PROMPT)).toBe(true);
  });

  it("不在 available_skills 中的名称返回 false", () => {
    expect(isValidSkillName("nonexistent", SAMPLE_PROMPT)).toBe(false);
    expect(isValidSkillName("read", SAMPLE_PROMPT)).toBe(false);
  });

  it("fail-open：systemPrompt 为空时返回 true（交由后续行为兜底）", () => {
    expect(isValidSkillName("anything", undefined)).toBe(true);
    expect(isValidSkillName("anything", "")).toBe(true);
  });

  it("fail-open：非空 prompt 但解析出 0 个 skill 时返回 true（格式漂移兑底）", () => {
    // Pi 升级改 prompt 格式 / execute 时机 prompt 不含 skills 块时，解析为空集。
    // 此时应 fail-open 放行，避免所有合法 skill 的 start 被误杀。
    expect(isValidSkillName("anything", "some prompt without skill blocks")).toBe(true);
    expect(isValidSkillName("anything", "<available_tools><tool><name>read</name></tool></available_tools>")).toBe(true);
  });

  it("空 name 返回 false", () => {
    expect(isValidSkillName("", SAMPLE_PROMPT)).toBe(false);
  });
});
