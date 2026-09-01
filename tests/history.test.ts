import { describe, expect, test } from "bun:test";
import {
  buildHistory,
  buildHistorySession,
  historyWindow,
  parseDateKey,
  parseHistoryPeriod,
  makeHistorySessionSpanKey,
  UNKNOWN_PROVENANCE_FOLDER,
} from "../src/history";
import type { EventRow, EventSourceRow, SemanticRole } from "../src/types";

function event(
  id: string,
  timestamp: string,
  session_id = "session-a",
  source = "claude",
  project = "sample-oracle",
  semantic_role: SemanticRole = "assistant_answer",
  text = id,
  block_index = 0,
): EventRow {
  return {
    id,
    event_uuid: id.split("#")[0],
    block_index,
    session_id,
    parent_uuid: "",
    timestamp,
    project,
    envelope_type: "message",
    block_type: "text",
    semantic_role,
    tool_name: "",
    tool_use_id: "",
    is_error: false,
    text,
    text_hash: `hash-${id}`,
    source,
  };
}

function occurrence(id: string, event_id: string, file_path: string, source = "claude"): EventSourceRow {
  return {
    id,
    event_id,
    source,
    file_path,
    file_hash: "file-hash",
    source_line: 1,
    observed_text_hash: `hash-${event_id}`,
  };
}

const filters = { source: "", project: "", folder: "" };

describe("history calendar", () => {
  test("zero-fills an empty elapsed week", () => {
    const result = buildHistory([], [], {
      ...filters,
      period: "week",
      date: "2026-08-26",
      today: "2026-08-26",
    });
    expect(result.start).toBe("2026-08-24");
    expect(result.end).toBe("2026-08-26");
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26",
    ]);
    expect(result.days.every((day) => day.event_count === 0 && day.groups.length === 0)).toBe(true);
    expect(result.totals).toEqual({
      days: 3, active_days: 0, events: 0, sessions: 0, sources: 0, projects: 0, folders: 0,
    });
  });

  test("uses selected day, Monday-Sunday week, and calendar month boundaries", () => {
    expect(historyWindow("day", "2026-08-30", "2026-09-10")).toEqual({
      start: "2026-08-30", end: "2026-08-30",
    });
    expect(historyWindow("week", "2026-08-30", "2026-09-10")).toEqual({
      start: "2026-08-24", end: "2026-08-30",
    });
    expect(historyWindow("week", "2026-08-31", "2026-09-02")).toEqual({
      start: "2026-08-31", end: "2026-09-02",
    });
    expect(historyWindow("month", "2026-07-14", "2026-09-10")).toEqual({
      start: "2026-07-01", end: "2026-07-31",
    });
    expect(historyWindow("month", "2026-09-01", "2026-09-10")).toEqual({
      start: "2026-09-01", end: "2026-09-10",
    });
  });

  test("assigns events at the Bangkok midnight boundary", () => {
    const rows = [
      event("before#0", "2026-08-30T16:59:59.999Z"),
      event("after#0", "2026-08-30T17:00:00.000Z"),
    ];
    const occurrences = rows.map((row, index) =>
      occurrence(`o-${index}`, row.id, `/archive/neo/${row.session_id}.jsonl`)
    );
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "month",
      date: "2026-08-31",
      today: "2026-08-31",
    });
    expect(result.days.find((day) => day.date === "2026-08-30")?.event_count).toBe(1);
    expect(result.days.find((day) => day.date === "2026-08-31")?.event_count).toBe(1);
  });
});

describe("history grouping", () => {
  test("keeps same session id separate across sources and does not multiply events by occurrences", () => {
    const rows = [
      event("c1#0", "2026-08-30T01:00:00.000Z", "shared", "claude", "sample-oracle", "assistant_answer", "fallback"),
      event("c2#0", "2026-08-30T01:01:00.000Z", "shared", "claude", "sample-oracle", "human_intent", "Teach me history"),
      event("x1#0", "2026-08-30T02:00:00.000Z", "shared", "codex", "sample-oracle"),
    ];
    const occurrences = [
      occurrence("o1", "c1#0", "/archive/neo/a.jsonl"),
      occurrence("o1-duplicate-file", "c1#0", "/archive/neo/b.jsonl"),
      occurrence("o2", "c2#0", "/archive/neo/a.jsonl"),
      occurrence("o3", "x1#0", "/archive/neo/c.jsonl", "codex"),
    ];
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(result.totals.events).toBe(3);
    expect(result.totals.sessions).toBe(2);
    expect(result.days[0].groups).toHaveLength(2);
    expect(result.days[0].groups[0].sessions[0]).toMatchObject({
      source: "claude",
      event_count: 2,
      preview: "Teach me history",
    });
  });

  test("counts a source-scoped session once when a summary lacks its project", () => {
    const rows = [
      event("known#0", "2026-08-30T01:00:00.000Z", "shared", "claude", "sample-oracle"),
      event("unknown#0", "2026-08-30T01:01:00.000Z", "shared", "claude", "?", "summary"),
    ];
    const occurrences = [
      occurrence("known", "known#0", "/archive/neo/shared.jsonl"),
      occurrence("unknown", "unknown#0", "/archive/neo/shared.jsonl"),
    ];
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });

    expect(result.totals.sessions).toBe(1);
    expect(result.days[0]?.session_count).toBe(1);
  });

  test("applies exact source, project, and provenance-folder filters", () => {
    const rows = [
      event("a#0", "2026-08-30T01:00:00.000Z", "a", "claude", "sample-oracle"),
      event("b#0", "2026-08-30T02:00:00.000Z", "b", "claude", "sample-oracle-2"),
      event("c#0", "2026-08-30T03:00:00.000Z", "c", "codex", "sample-oracle"),
    ];
    const occurrences = [
      occurrence("oa", "a#0", "/archive/neo/a.jsonl"),
      occurrence("ob", "b#0", "/archive/other/b.jsonl"),
      occurrence("oc", "c#0", "/archive/neo/c.jsonl", "codex"),
    ];
    const result = buildHistory(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/neo",
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(result.totals.events).toBe(1);
    expect(result.days[0].groups[0]).toMatchObject({
      source: "claude", project: "sample-oracle", folder: "/archive/neo",
    });
  });

  test("associates one canonical event with every unique provenance directory", () => {
    const rows = [
      event("shared-event#0", "2026-08-30T01:00:00.000Z", "session", "claude", "sample-oracle"),
    ];
    const occurrences = [
      occurrence("oa", "shared-event#0", "/archive/alpha/a.jsonl"),
      occurrence("oa-duplicate-dir", "shared-event#0", "/archive/alpha/b.jsonl"),
      occurrence("ob", "shared-event#0", "/archive/beta/a.jsonl"),
    ];
    const allFolders = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(allFolders.totals.events).toBe(1);
    expect(allFolders.totals.folders).toBe(2);
    expect(allFolders.days[0].event_count).toBe(1);
    expect(allFolders.days[0].groups).toHaveLength(2);
    expect(allFolders.days[0].groups.map((group) => [group.folder, group.event_count])).toEqual([
      ["/archive/alpha", 1],
      ["/archive/beta", 1],
    ]);

    const exactFolder = buildHistory(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/beta",
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(exactFolder.totals.events).toBe(1);
    expect(exactFolder.totals.folders).toBe(1);
    expect(exactFolder.days[0].groups).toHaveLength(1);
    expect(exactFolder.days[0].groups[0].folder).toBe("/archive/beta");

    const detail = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/alpha",
      session_id: "session",
      date: "2026-08-30",
      offset: 0,
      limit: 200,
    });
    expect(detail.total).toBe(1);
    expect(detail.events.map((row) => row.id)).toEqual(["shared-event#0"]);
  });

  test("keeps canonical totals unique when provenance directories partially overlap", () => {
    const rows = [
      event("alpha-only#0", "2026-08-30T01:00:00.000Z", "s-alpha"),
      event("shared#0", "2026-08-30T02:00:00.000Z", "s-shared"),
      event("beta-only#0", "2026-08-30T03:00:00.000Z", "s-beta"),
    ];
    const occurrences = [
      occurrence("oa", "alpha-only#0", "/archive/alpha/a.jsonl"),
      occurrence("os-a", "shared#0", "/archive/alpha/shared.jsonl"),
      occurrence("os-b", "shared#0", "/archive/beta/shared.jsonl"),
      occurrence("ob", "beta-only#0", "/archive/beta/b.jsonl"),
    ];
    const allFolders = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(allFolders.totals.events).toBe(3);
    expect(allFolders.totals.sessions).toBe(3);
    expect(allFolders.days[0]).toMatchObject({ event_count: 3, session_count: 3 });
    expect(allFolders.days[0].groups.map((group) => [group.folder, group.event_count])).toEqual([
      ["/archive/alpha", 2],
      ["/archive/beta", 2],
    ]);

    const beta = buildHistory(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/beta",
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(beta.totals.events).toBe(2);
    expect(beta.days[0].groups[0].event_count).toBe(2);

    const betaDetail = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/beta",
      session_id: "s-shared",
      date: "2026-08-30",
      offset: 0,
      limit: 200,
    });
    expect(betaDetail.total).toBe(1);
    expect(betaDetail.events.map((row) => row.id)).toEqual(["shared#0"]);
  });

  test("shows orphan canonical events under explicit unknown provenance only in all-folders history", () => {
    const rows = [event("orphan#0", "2026-08-30T01:00:00.000Z", "orphan-session")];
    const allFolders = buildHistory(rows, [], {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(allFolders.totals.events).toBe(1);
    expect(allFolders.totals.folders).toBe(1);
    expect(allFolders.days[0].groups[0].folder).toBe(UNKNOWN_PROVENANCE_FOLDER);

    const realFolder = buildHistory(rows, [], {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/neo",
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(realFolder.totals.events).toBe(0);
    expect(realFolder.days[0].groups).toEqual([]);
  });

  test("matches occurrence identity by source as well as canonical event id", () => {
    const rows = [
      event("same-id#0", "2026-08-30T01:00:00.000Z", "claude-session", "claude"),
      event("same-id#0", "2026-08-30T02:00:00.000Z", "codex-session", "codex"),
    ];
    const occurrences = [
      occurrence("claude-occurrence", "same-id#0", "/archive/claude/a.jsonl", "claude"),
    ];
    const exactFolder = buildHistory(rows, occurrences, {
      source: "",
      project: "sample-oracle",
      folder: "/archive/claude",
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(exactFolder.totals.events).toBe(1);
    expect(exactFolder.days[0].groups[0].source).toBe("claude");

    const allFolders = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(allFolders.days[0].groups.map((group) => [group.source, group.folder])).toEqual([
      ["claude", "/archive/claude"],
      ["codex", UNKNOWN_PROVENANCE_FOLDER],
    ]);
  });

  test("marks a session that continues across selected day boundaries", () => {
    const rows = [
      event("before#0", "2026-08-29T16:00:00.000Z"),
      event("during#0", "2026-08-30T01:00:00.000Z"),
      event("after#0", "2026-08-30T18:00:00.000Z"),
    ];
    const occurrences = rows.map((row, index) =>
      occurrence(`o${index}`, row.id, "/archive/neo/session.jsonl")
    );
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(result.days[0].groups[0].sessions[0]).toMatchObject({
      event_count: 1,
      continues_before: true,
      continues_after: true,
    });
  });

  test("accepts explicit session spans for continuation without scanning full events", () => {
    const rows = [
      event("during#0", "2026-08-30T01:00:00.000Z", "spanned-session"),
    ];
    const occurrences = [occurrence("a", "during#0", "/archive/neo/session.jsonl")];
    const spans = new Map([
      [makeHistorySessionSpanKey("claude", "sample-oracle", "/archive/neo", "spanned-session"), {
        first: "2026-08-25",
        last: "2026-09-02",
      }],
    ]);
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-09-01",
      source: "claude",
      project: "sample-oracle",
      sessionSpans: spans,
    });
    expect(result.days[0].groups[0].sessions[0]).toMatchObject({
      session_id: "spanned-session",
      continues_before: true,
      continues_after: true,
    });
  });

  test("scopes continuation markers to source, project, folder, and session", () => {
    const rows = [
      event("alpha-before#0", "2026-08-29T01:00:00.000Z", "shared-session"),
      event("project-before#0", "2026-08-29T02:00:00.000Z", "shared-session", "claude", "other-oracle"),
      event("source-before#0", "2026-08-29T03:00:00.000Z", "shared-session", "codex"),
      event("beta-during#0", "2026-08-30T01:00:00.000Z", "shared-session"),
      event("beta-after#0", "2026-08-30T18:00:00.000Z", "shared-session"),
    ];
    const occurrences = [
      occurrence("oa", "alpha-before#0", "/archive/alpha/session.jsonl"),
      occurrence("op", "project-before#0", "/archive/beta/project.jsonl"),
      occurrence("os", "source-before#0", "/archive/beta/source.jsonl", "codex"),
      occurrence("ob", "beta-during#0", "/archive/beta/session.jsonl"),
      occurrence("oc", "beta-after#0", "/archive/beta/session.jsonl"),
    ];
    const result = buildHistory(rows, occurrences, {
      ...filters,
      period: "day",
      date: "2026-08-30",
      today: "2026-08-31",
    });
    expect(result.days[0].groups).toHaveLength(1);
    expect(result.days[0].groups[0].folder).toBe("/archive/beta");
    expect(result.days[0].groups[0].sessions[0]).toMatchObject({
      session_id: "shared-session",
      continues_before: false,
      continues_after: true,
    });
  });
});

describe("history session detail", () => {
  test("sorts canonical events and paginates without occurrence duplication", () => {
    const rows = [
      event("later#1", "2026-08-30T01:01:00.000Z", "s", "claude", "neo", "tool_action", "later", 1),
      event("same#2", "2026-08-30T01:00:00.000Z", "s", "claude", "neo", "assistant_answer", "second", 2),
      event("same#0", "2026-08-30T01:00:00.000Z", "s", "claude", "neo", "human_intent", "first", 0),
    ];
    const occurrences = [
      ...rows.map((row, index) => occurrence(`o${index}`, row.id, "/archive/neo/s.jsonl")),
      occurrence("duplicate-occurrence", "same#0", "/archive/neo/also.jsonl"),
    ];
    const first = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "neo",
      folder: "/archive/neo",
      session_id: "s",
      date: "2026-08-30",
      offset: 0,
      limit: 2,
    });
    expect(first.total).toBe(3);
    expect(first.selected_day_events).toBe(3);
    expect(first.events.map((row) => row.id)).toEqual(["same#0", "same#2"]);
    expect(first.next_offset).toBe(2);
    const second = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "neo",
      folder: "/archive/neo",
      session_id: "s",
      date: "2026-08-30",
      offset: 2,
      limit: 2,
    });
    expect(second.events.map((row) => row.id)).toEqual(["later#1"]);
    expect(second.next_offset).toBeNull();
  });

  test("paginates the whole multi-day session while preserving exact folder provenance", () => {
    const rows = [
      event("before#0", "2026-08-29T01:00:00.000Z", "multi-day"),
      event("selected#0", "2026-08-30T01:00:00.000Z", "multi-day"),
      event("other-folder#0", "2026-08-30T02:00:00.000Z", "multi-day"),
      event("after#0", "2026-08-30T18:00:00.000Z", "multi-day"),
    ];
    const occurrences = [
      occurrence("before-beta", "before#0", "/archive/beta/session.jsonl"),
      occurrence("selected-beta", "selected#0", "/archive/beta/session.jsonl"),
      occurrence("selected-alpha", "selected#0", "/archive/alpha/session.jsonl"),
      occurrence("other-alpha", "other-folder#0", "/archive/alpha/session.jsonl"),
      occurrence("after-beta", "after#0", "/archive/beta/session.jsonl"),
    ];
    const first = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/beta",
      session_id: "multi-day",
      date: "2026-08-30",
      offset: 0,
      limit: 2,
    });
    expect(first.total).toBe(3);
    expect(first.selected_day_events).toBe(1);
    expect(first.events.map((row) => row.id)).toEqual(["before#0", "selected#0"]);
    expect(first.next_offset).toBe(2);

    const second = buildHistorySession(rows, occurrences, {
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/beta",
      session_id: "multi-day",
      date: "2026-08-30",
      offset: 2,
      limit: 2,
    });
    expect(second.total).toBe(3);
    expect(second.selected_day_events).toBe(1);
    expect(second.events.map((row) => row.id)).toEqual(["after#0"]);
    expect(second.next_offset).toBeNull();
  });
});

describe("history validation", () => {
  test("rejects invalid periods, invalid dates, future dates, and bad pagination", () => {
    expect(() => parseHistoryPeriod("quarter")).toThrow("period must be day, week, or month");
    expect(() => parseDateKey("2026-02-30")).toThrow("valid calendar date");
    expect(() => historyWindow("day", "2026-09-01", "2026-08-31")).toThrow("future");
    expect(() => buildHistorySession([], [], {
      source: "claude",
      project: "neo",
      folder: "/archive/neo",
      session_id: "s",
      date: "2026-08-30",
      offset: -1,
      limit: 200,
    })).toThrow("offset");
  });
});
