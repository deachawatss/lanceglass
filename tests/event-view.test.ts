import { describe, expect, test } from "bun:test";
import { buildEventView } from "../src/event-view";
import type { EventRow, EventSourceRow } from "../src/types";

function event(id: string, source: string, project: string, timestamp: string): EventRow {
  return {
    id,
    event_uuid: id,
    block_index: 0,
    session_id: `${source}-session`,
    parent_uuid: "",
    timestamp,
    project,
    envelope_type: "message",
    block_type: "text",
    semantic_role: "assistant_answer",
    tool_name: "",
    tool_use_id: "",
    is_error: false,
    text: `${source}:${id}`,
    text_hash: `${source}-hash`,
    source,
  };
}

function occurrence(id: string, eventId: string, source: string, filePath: string): EventSourceRow {
  return {
    id,
    event_id: eventId,
    source,
    file_path: filePath,
    file_hash: `${source}-file-hash`,
    source_line: 1,
    observed_text_hash: `${source}-text-hash`,
  };
}

describe("event view facets", () => {
  test("keeps all-source provenance composite and scopes folders to the selected project", () => {
    const events = [
      event("shared#0", "claude", "sample-oracle", "2026-08-31T03:00:00.000Z"),
      event("shared#0", "codex", "home-oracle", "2026-08-31T02:00:00.000Z"),
      event("other#0", "claude", "other-oracle", "2026-08-31T01:00:00.000Z"),
    ];
    const occurrences = [
      occurrence("claude-shared", "shared#0", "claude", "/archive/claude/sample/session.jsonl"),
      occurrence("codex-shared", "shared#0", "codex", "/archive/codex/home/session.jsonl"),
      occurrence("claude-other", "other#0", "claude", "/archive/claude/other/session.jsonl"),
    ];

    const neo = buildEventView(events, occurrences, "", "sample-oracle", "", 50);
    expect(neo.total).toBe(1);
    expect(neo.events[0]).toMatchObject({
      source: "claude",
      file_path: "/archive/claude/sample/session.jsonl",
      folder: "/archive/claude/sample",
    });
    expect(neo.facets.projects).toEqual([
      { value: "home-oracle", count: 1 },
      { value: "other-oracle", count: 1 },
      { value: "sample-oracle", count: 1 },
    ]);
    expect(neo.facets.folders).toEqual([
      { value: "/archive/claude/sample", label: "sample", count: 1 },
    ]);

    const exactCodexFolder = buildEventView(
      events,
      occurrences,
      "",
      "home-oracle",
      "/archive/codex/home",
      50,
    );
    expect(exactCodexFolder.total).toBe(1);
    expect(exactCodexFolder.events[0]).toMatchObject({
      source: "codex",
      file_path: "/archive/codex/home/session.jsonl",
    });
    expect(exactCodexFolder.facets.folders).toEqual([
      { value: "/archive/codex/home", label: "home", count: 1 },
    ]);
  });
});
