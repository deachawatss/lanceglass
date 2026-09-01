import { describe, expect, test } from "bun:test";
import { historyGroupRange, sortHistoryGroups, sortHistoryRecords, sortHistorySessions, type SortableHistoryGroup } from "./history-sort";

const groups: SortableHistoryGroup[] = [
  {
    source: "claude",
    project: "alpha-oracle",
    folder: "/alpha",
    event_count: 4,
    session_count: 1,
    sessions: [{ started_at: "2026-08-31T02:00:00.000Z", ended_at: "2026-08-31T03:00:00.000Z" }],
  },
  {
    source: "claude",
    project: "beta-oracle",
    folder: "/beta",
    event_count: 12,
    session_count: 2,
    sessions: [
      { started_at: "2026-08-31T01:00:00.000Z", ended_at: "2026-08-31T01:30:00.000Z" },
      { started_at: "2026-08-31T04:00:00.000Z", ended_at: "2026-08-31T05:00:00.000Z" },
    ],
  },
];

describe("history group ordering", () => {
  test("derives the first and latest observed event across sessions", () => {
    expect(historyGroupRange(groups[1]!)).toEqual({
      startedAt: "2026-08-31T01:00:00.000Z",
      updatedAt: "2026-08-31T05:00:00.000Z",
    });
  });

  test("defaults naturally to latest activity while supporting other useful orders", () => {
    expect(sortHistoryGroups(groups, "latest").map((group) => group.project)).toEqual(["beta-oracle", "alpha-oracle"]);
    expect(sortHistoryGroups(groups, "earliest").map((group) => group.project)).toEqual(["beta-oracle", "alpha-oracle"]);
    expect(sortHistoryGroups([...groups].reverse(), "project").map((group) => group.project)).toEqual(["alpha-oracle", "beta-oracle"]);
    expect(sortHistoryGroups(groups, "events").map((group) => group.project)).toEqual(["beta-oracle", "alpha-oracle"]);
    expect(sortHistoryGroups(groups, "sessions").map((group) => group.project)).toEqual(["beta-oracle", "alpha-oracle"]);
  });

  test("keeps session drill-down aligned with the selected activity order", () => {
    const sessions = groups[1]!.sessions.map((session, index) => ({ ...session, session_id: String(index) }));
    expect(sortHistorySessions(sessions, "latest").map((session) => session.session_id)).toEqual(["1", "0"]);
    expect(sortHistorySessions([...sessions].reverse(), "earliest").map((session) => session.session_id)).toEqual(["0", "1"]);
  });

  test("sorts the dense session ledger by the session being read", () => {
    const records = [
      {
        group: groups[0]!,
        session: { session_id: "alpha", started_at: "2026-08-31T02:00:00.000Z", ended_at: "2026-08-31T03:00:00.000Z", event_count: 4 },
      },
      {
        group: groups[1]!,
        session: { session_id: "beta-early", started_at: "2026-08-31T01:00:00.000Z", ended_at: "2026-08-31T01:30:00.000Z", event_count: 3 },
      },
      {
        group: groups[1]!,
        session: { session_id: "beta-late", started_at: "2026-08-31T04:00:00.000Z", ended_at: "2026-08-31T05:00:00.000Z", event_count: 9 },
      },
    ];

    expect(sortHistoryRecords(records, "latest").map((record) => record.session.session_id)).toEqual(["beta-late", "alpha", "beta-early"]);
    expect(sortHistoryRecords(records, "earliest").map((record) => record.session.session_id)).toEqual(["beta-early", "alpha", "beta-late"]);
    expect(sortHistoryRecords(records, "events").map((record) => record.session.session_id)).toEqual(["beta-late", "alpha", "beta-early"]);
    expect(sortHistoryRecords(records, "project").map((record) => record.session.session_id)).toEqual(["alpha", "beta-late", "beta-early"]);
  });

  test("keeps malformed timestamps last and puts newest Oracle sessions first", () => {
    const records = [
      {
        group: groups[1]!,
        session: { session_id: "beta-old", started_at: "2026-08-31T01:00:00.000Z", ended_at: "2026-08-31T01:30:00.000Z", event_count: 1 },
      },
      {
        group: groups[1]!,
        session: { session_id: "beta-new", started_at: "2026-08-31T06:00:00.000Z", ended_at: "2026-08-31T07:00:00.000Z", event_count: 1 },
      },
      {
        group: groups[1]!,
        session: { session_id: "beta-invalid", started_at: "not-a-time", ended_at: "not-a-time", event_count: 1 },
      },
    ];

    expect(sortHistoryRecords(records, "project").map((record) => record.session.session_id)).toEqual(["beta-new", "beta-old", "beta-invalid"]);
    expect(sortHistoryRecords(records, "earliest").map((record) => record.session.session_id)).toEqual(["beta-old", "beta-new", "beta-invalid"]);
  });
});
