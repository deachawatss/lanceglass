import { describe, expect, test } from "bun:test";
import {
  buildHistoryVectorQuery,
  mergeVectorEvidence,
  nextEvidenceIndex,
  pointCoordinates,
  vectorActorForRole,
  type HistoryVectorScope,
} from "./HistoryWorkspace";

const scope: HistoryVectorScope = {
  date: "2026-08-31",
  source: "claude",
  project: "sample-oracle",
  folder: "/Users/example/.claude/projects/sample oracle",
  session_id: "session/42",
};

describe("History vector map request", () => {
  test("scopes every request to the exact History row", () => {
    const query = buildHistoryVectorQuery(scope, "dual-4090", ["human", "agent"]);

    expect(query.get("deployment")).toBe("dual-4090");
    expect(query.get("date")).toBe(scope.date);
    expect(query.get("source")).toBe(scope.source);
    expect(query.get("project")).toBe(scope.project);
    expect(query.get("folder")).toBe(scope.folder);
    expect(query.get("session_id")).toBe(scope.session_id);
    expect(query.get("limit")).toBe("200");
    expect(query.getAll("actor")).toEqual(["human", "agent"]);
  });

  test("switches indexes without weakening the row scope", () => {
    const query = buildHistoryVectorQuery(scope, "cloudflare", ["agent"]);
    expect(query.get("deployment")).toBe("cloudflare");
    expect(query.get("session_id")).toBe("session/42");
    expect(query.getAll("actor")).toEqual(["agent"]);
  });

  test("groups canonical semantic roles into human and agent evidence", () => {
    expect(vectorActorForRole("human_intent")).toBe("human");
    for (const role of ["assistant_answer", "summary", "tool_action", "tool_evidence"]) {
      expect(vectorActorForRole(role)).toBe("agent");
    }
    expect(vectorActorForRole("future_role")).toBeNull();
  });

  test("merges provider evidence deterministically regardless of response completion order", () => {
    const cloudflare = [
      { event_id: "shared", timestamp: "2026-08-31T00:00:02Z", source: "cloudflare" },
      { event_id: "earliest", timestamp: "2026-08-31T00:00:01Z", source: "cloudflare" },
    ];
    const dual4090 = [
      { event_id: "shared", timestamp: "2026-08-31T00:00:02Z", source: "dual-4090" },
      { event_id: "latest", timestamp: "2026-08-31T00:00:03Z", source: "dual-4090" },
    ];

    const merged = mergeVectorEvidence(
      ["dual-4090", "cloudflare"],
      { cloudflare, "dual-4090": dual4090 },
    );

    expect(merged.map((point) => point.event_id)).toEqual(["earliest", "shared", "latest"]);
    expect(merged.find((point) => point.event_id === "shared")?.source).toBe("dual-4090");
  });

  test("keeps a zero or degenerate projection centered in the map", () => {
    expect(pointCoordinates([{ event_id: "zero", x: 0, y: 0 }]).get("zero"))
      .toEqual({ x: 360, y: 200 });
    expect(pointCoordinates([{ event_id: "bounded", x: 9, y: -9 }]).get("bounded"))
      .toEqual({ x: 690, y: 370 });
  });

  test("moves a roving evidence option without leaving the list", () => {
    expect(nextEvidenceIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextEvidenceIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextEvidenceIndex("ArrowUp", 0, 3)).toBe(0);
    expect(nextEvidenceIndex("Home", 2, 3)).toBe(0);
    expect(nextEvidenceIndex("End", 0, 3)).toBe(2);
    expect(nextEvidenceIndex("Enter", 1, 3)).toBeNull();
    expect(nextEvidenceIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
