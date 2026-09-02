import type { HistoryVectorScope } from "./HistoryWorkspace";

// How wide a net the vector map casts.
//
// The map was originally always session-scoped, which answers "what happened inside this
// one conversation". That is a useful question, but it is not the one a map is best at:
// with a few dozen points there is no shape to see. Widening the scope is what turns the
// map into a picture of how work relates across a day.
//
// The server treats an empty project / folder / session_id as "every value on that axis",
// so widening is expressed by clearing fields rather than by a separate parameter.

export const VECTOR_BREADTHS = ["session", "project", "day"] as const;
export type VectorBreadth = (typeof VECTOR_BREADTHS)[number];

export const VECTOR_BREADTH_LABEL: Record<VectorBreadth, { title: string; hint: string }> = {
  session: { title: "Session", hint: "this conversation" },
  project: { title: "Project", hint: "every session in it" },
  day: { title: "Day", hint: "everything on this date" },
};

/// Wider scopes cover more events, so they sample more points to keep the shape readable.
/// Kept well inside MAX_HISTORY_VECTOR_POINTS: the neighbour graph is O(n²), so the cap is
/// a real cost ceiling rather than a formality.
export const VECTOR_BREADTH_LIMIT: Record<VectorBreadth, number> = {
  session: 200,
  project: 600,
  day: 600,
};

export function normalizeVectorBreadth(value: string | null | undefined): VectorBreadth {
  return (VECTOR_BREADTHS as readonly string[]).includes(value as VectorBreadth)
    ? (value as VectorBreadth)
    : "session";
}

/**
 * Clear the scope axes a breadth does not pin.
 *
 * `date` and `source` always survive — a map that mixed days or mixed agents would compare
 * things the user never asked to see together.
 */
export function widenVectorScope(
  scope: HistoryVectorScope,
  breadth: VectorBreadth,
): HistoryVectorScope {
  if (breadth === "session") return scope;
  if (breadth === "project") return { ...scope, session_id: "" };
  return { ...scope, session_id: "", project: "", folder: "" };
}
