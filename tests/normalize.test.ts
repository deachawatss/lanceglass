import { describe, expect, test } from "bun:test";
import { createNormalizationState, normalize } from "../src/normalize";

const context = {
  source: "codex",
  filePath: "/tmp/rollout-file.jsonl",
  fileHash: "file-hash",
  line: 1,
  fallbackSession: "rollout-file",
};

function run(records: Record<string, unknown>[]) {
  const state = createNormalizationState(context.fallbackSession);
  return records.flatMap((record, index) => normalize(record, {
    ...context,
    line: index + 1,
  }, state).events);
}

describe("Codex JSONL normalization", () => {
  test("captures file session and cwd, then maps only user and assistant text", () => {
    const events = run([
      { type: "session_meta", timestamp: "t0", payload: {
        id: "rollout-session", session_id: "legacy-session", cwd: "/work/sample-oracle",
      } },
      // Compatibility metadata must not replace the unique rollout id.
      { type: "session_meta", timestamp: "t0", payload: {
        id: "legacy-session", session_id: "legacy-session", cwd: "/work/sample-oracle",
      } },
      { type: "response_item", timestamp: "t1", payload: {
        type: "message", id: "user-message", role: "user",
        content: [
          { type: "input_text", text: "What changed?" },
          { type: "input_image", image_url: "data:image/png;base64,secret" },
        ],
      } },
      { type: "turn_context", timestamp: "t2", payload: { cwd: "/work/new-oracle" } },
      { type: "response_item", timestamp: "t3", payload: {
        type: "message", id: "assistant-message", role: "assistant",
        content: [{ type: "output_text", text: "The importer changed." }],
      } },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "user-message#0", event_uuid: "user-message", session_id: "rollout-session",
      project: "sample-oracle", block_type: "input_text", semantic_role: "human_intent",
      text: "What changed?", timestamp: "t1",
    });
    expect(events[1]).toMatchObject({
      id: "assistant-message#0", session_id: "rollout-session", project: "new-oracle",
      block_type: "output_text", semantic_role: "assistant_answer",
      text: "The importer changed.", timestamp: "t3",
    });
    expect(events.some((event) => event.text.includes("data:image"))).toBe(false);
  });

  test("maps custom tool calls and outputs with stable payload identities", () => {
    const events = run([
      { type: "session_meta", payload: { id: "session", cwd: "/work/tools" } },
      { type: "response_item", timestamp: "t1", payload: {
        type: "custom_tool_call", id: "call-item", call_id: "call-7",
        name: "exec", input: "echo hello",
      } },
      { type: "response_item", timestamp: "t2", payload: {
        type: "custom_tool_call_output", id: "output-item", call_id: "call-7",
        output: [{ type: "output_text", text: "hello" }],
      } },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        id: "call-item#0", event_uuid: "call-item", block_type: "custom_tool_call",
        semantic_role: "tool_action", tool_name: "exec", tool_use_id: "call-7",
        text: "echo hello",
      }),
      expect.objectContaining({
        id: "output-item#0", event_uuid: "output-item", block_type: "custom_tool_call_output",
        semantic_role: "tool_evidence", tool_use_id: "call-7", text: "hello",
      }),
    ]);
  });

  test("maps function calls and keeps only textual function output blocks", () => {
    const events = run([
      { type: "session_meta", payload: { id: "session", cwd: "/work/tools" } },
      { type: "response_item", timestamp: "t1", payload: {
        type: "function_call", id: "call-item", call_id: "call-9",
        name: "shell", arguments: "{\"command\":\"pwd\"}",
      } },
      { type: "response_item", timestamp: "t2", payload: {
        type: "function_call_output", id: "output-item", call_id: "call-9",
        output: [
          { type: "output_text", text: "/work/tools" },
          { type: "input_image", image_url: "data:image/png;base64,private" },
          { type: "metadata", value: "not searchable" },
          { type: "text", text: "done" },
        ],
      } },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        id: "call-item#0", event_uuid: "call-item", block_type: "function_call",
        semantic_role: "tool_action", tool_name: "shell", tool_use_id: "call-9",
        text: "{\"command\":\"pwd\"}",
      }),
      expect.objectContaining({
        id: "output-item#0", event_uuid: "output-item", block_type: "function_call_output",
        semantic_role: "tool_evidence", tool_use_id: "call-9", text: "/work/tools\ndone",
      }),
    ]);
    expect(events.some((event) => event.text.includes("data:image"))).toBe(false);
    expect(events.some((event) => event.text.includes("not searchable"))).toBe(false);
  });

  test("preserves all textual Codex message block variants and ignores images", () => {
    const events = run([{ type: "response_item", payload: {
      type: "message", id: "mixed", role: "assistant", content: [
        { type: "text", text: "plain" },
        { type: "input_text", text: "input" },
        { type: "input_image", image_url: "data:image/jpeg;base64,private" },
        { type: "output_text", text: "output" },
      ],
    } }]);

    expect(events.map(({ block_type, text }) => ({ block_type, text }))).toEqual([
      { block_type: "text", text: "plain" },
      { block_type: "input_text", text: "input" },
      { block_type: "output_text", text: "output" },
    ]);
  });

  test("ignores developer/system/reasoning/lifecycle and encrypted noise", () => {
    const events = run([
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "reasoning", encrypted_content: "cipher" } },
      { type: "response_item", payload: {
        type: "message", id: "dev", role: "developer",
        content: [{ type: "input_text", text: "private instructions" }],
      } },
      { type: "response_item", payload: {
        type: "message", id: "system", role: "system",
        content: [{ type: "input_text", text: "system instructions" }],
      } },
    ]);
    expect(events).toEqual([]);
  });

  test("isolates file state and is deterministic across audit/write passes", () => {
    const first = [
      { type: "session_meta", timestamp: "t0", payload: { id: "one", cwd: "/a/one" } },
      { type: "response_item", timestamp: "t1", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "hello" }],
      } },
    ];
    const audit = run(first);
    const write = run(first);
    expect(write).toEqual(audit);
    expect(audit[0]?.session_id).toBe("one");

    const isolated = run([{ type: "response_item", timestamp: "t1", payload: {
      type: "message", id: "fresh", role: "user",
      content: [{ type: "input_text", text: "fresh" }],
    } }]);
    expect(isolated[0]).toMatchObject({ session_id: "rollout-file", project: "?" });
  });

  test("upgrades session_id fallback to payload.id without replacing the first payload.id", () => {
    const events = run([
      { type: "session_meta", payload: { session_id: "legacy", cwd: "/work/first" } },
      { type: "session_meta", payload: { id: "rollout", cwd: "/work/second" } },
      { type: "session_meta", payload: { id: "later-compatibility-id" } },
      { type: "response_item", payload: {
        type: "message", id: "message", role: "user",
        content: [{ type: "input_text", text: "hello" }],
      } },
    ]);
    expect(events[0]).toMatchObject({ session_id: "rollout", project: "second" });
  });
});

describe("Claude normalization compatibility", () => {
  test("preserves the existing Claude envelope mapping", () => {
    const rows = normalize({
      type: "assistant", uuid: "claude-event", sessionId: "claude-session",
      cwd: "/work/claude-demo", timestamp: "2026-01-01T00:00:00Z",
      message: { content: [
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
      ] },
    }, { ...context, source: "claude" });
    expect(rows.events).toEqual([
      expect.objectContaining({ id: "claude-event#0", semantic_role: "assistant_answer", text: "answer" }),
      expect.objectContaining({
        id: "claude-event#1", semantic_role: "tool_action", tool_name: "Bash",
        tool_use_id: "tool-1", text: "{\"command\":\"pwd\"}",
      }),
    ]);
  });
});
