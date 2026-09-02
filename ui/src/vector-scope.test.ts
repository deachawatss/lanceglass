import { describe, expect, test } from "bun:test";
import {
  normalizeVectorBreadth,
  VECTOR_BREADTH_LIMIT,
  VECTOR_BREADTHS,
  widenVectorScope,
} from "./vector-scope";
import { MAX_HISTORY_VECTOR_POINTS } from "../../src/history-vectors";

const scope = {
  date: "2026-08-31",
  source: "claude",
  project: "gale-oracle",
  folder: "/home/wind/.claude/projects/-gale-oracle",
  session_id: "e17b8fa9",
};

describe("vector scope breadth", () => {
  test("session breadth changes nothing", () => {
    expect(widenVectorScope(scope, "session")).toEqual(scope);
  });

  test("project breadth clears only the session", () => {
    expect(widenVectorScope(scope, "project")).toEqual({ ...scope, session_id: "" });
  });

  test("day breadth clears session, project and folder", () => {
    expect(widenVectorScope(scope, "day")).toEqual({
      ...scope,
      session_id: "",
      project: "",
      folder: "",
    });
  });

  test("date and source survive every breadth", () => {
    // A map that mixed days or agents would compare things never asked for together.
    for (const breadth of VECTOR_BREADTHS) {
      const widened = widenVectorScope(scope, breadth);
      expect(widened.date).toBe("2026-08-31");
      expect(widened.source).toBe("claude");
    }
  });

  test("widening never mutates the scope it was given", () => {
    const original = { ...scope };
    widenVectorScope(scope, "day");
    expect(scope).toEqual(original);
  });

  test("an unknown or missing breadth falls back to session", () => {
    expect(normalizeVectorBreadth("everything")).toBe("session");
    expect(normalizeVectorBreadth(null)).toBe("session");
    expect(normalizeVectorBreadth(undefined)).toBe("session");
    expect(normalizeVectorBreadth("day")).toBe("day");
  });

  test("a URL saved before breadth existed still means session scope", () => {
    // Backward compatibility: an old shared link carries no vector_breadth, and must keep
    // showing exactly the one session it was captured from.
    const legacy = new URLSearchParams(
      "operate=vectors&vector_view=3d&vector_date=2026-08-31&vector_source=claude" +
      "&vector_project=gale-oracle&vector_folder=%2Farchive&vector_session=e17b8fa9",
    );
    const breadth = normalizeVectorBreadth(legacy.get("vector_breadth"));
    expect(breadth).toBe("session");
    expect(widenVectorScope(scope, breadth)).toEqual(scope);
  });

  test("every breadth requests fewer points than the server accepts", () => {
    // The neighbour graph is O(n^2); a limit above the cap would be rejected outright.
    for (const breadth of VECTOR_BREADTHS) {
      expect(VECTOR_BREADTH_LIMIT[breadth]).toBeLessThanOrEqual(MAX_HISTORY_VECTOR_POINTS);
      expect(VECTOR_BREADTH_LIMIT[breadth]).toBeGreaterThan(0);
    }
  });
});
