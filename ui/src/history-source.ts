/**
 * Assign a short, stable display number from the complete source catalogue.
 *
 * The catalogue comes from the status endpoint rather than the currently
 * filtered history response, so Claude does not become `02` or `01` merely
 * because the viewer changes its date, source, or folder filter.
 */
export function historySourceNumbers(sourceIds: readonly string[]) {
  const ordered = [...new Set(sourceIds.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
  return new Map(ordered.map((source, index) => [source, String(index + 1).padStart(2, "0")]));
}
