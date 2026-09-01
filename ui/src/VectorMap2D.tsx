import { useId, useMemo } from "react";
import { pointCoordinates, type VectorVisualizationProps } from "./vector-visualization";

const ROLE_CLASS: Record<string, string> = {
  human_intent: "is-human",
  assistant_answer: "is-assistant",
  tool_action: "is-tool",
  tool_evidence: "is-result",
  summary: "is-assistant",
};

export function VectorMap2D({
  points,
  selectedEventId,
  onSelect,
  ariaLabel = "Interactive two-dimensional vector projection. Use the adjacent evidence list for keyboard navigation.",
  className,
}: VectorVisualizationProps) {
  const coordinates = useMemo(() => pointCoordinates(points), [points]);
  const titleId = useId();
  const descriptionId = useId();
  const selectionId = useId();
  const selected = points.find((point) => point.event_id === selectedEventId);

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        className="vector-map"
        viewBox="0 0 720 400"
        role="img"
        aria-label={ariaLabel}
        aria-describedby={selectionId}
      >
        <title id={titleId}>Flat 2D vector projection</title>
        <desc id={descriptionId}>{points.length} embedded evidence points. Select a point or use the adjacent evidence list.</desc>
        <path d="M30 370H690M30 30V370" className="vector-axis" />
        {points.map((point) => {
          const coordinate = coordinates.get(point.event_id)!;
          const active = point.event_id === selectedEventId;
          return (
            <circle
              key={point.event_id}
              className={`vector-point ${ROLE_CLASS[point.semantic_role] ?? ""} ${active ? "is-selected" : ""}`}
              cx={coordinate.x}
              cy={coordinate.y}
              r={active ? 7 : 4.5}
              onClick={() => onSelect(point.event_id)}
            >
              <title>{`${point.semantic_role || point.block_type || "evidence"}: ${point.text_preview || "No preview"}`}</title>
            </circle>
          );
        })}
      </svg>
      <span
        id={selectionId}
        aria-live="polite"
        style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}
      >
        {selected ? `Selected ${selected.semantic_role || selected.block_type || "evidence"}: ${selected.text_preview || selected.event_id}` : "No vector event selected"}
      </span>
    </div>
  );
}

export default VectorMap2D;
