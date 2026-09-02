import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VectorVisualizationProps } from "./vector-visualization";

// Force-directed neighbour layout.
//
// The atlas plots PCA coordinates, which answer "where does this point fall on
// the three highest-variance axes". This view answers a different question:
// which points are genuinely near each other in the full embedding space. The
// host supplies that as an edge list computed from the raw vectors, and the
// positions here come from relaxing those edges — connected points pull
// together, everything else drifts apart, and the shape of the conversation
// falls out of the simulation rather than out of a projection.
//
// Deliberately Canvas 2D, not WebGL: this plugin must never fail to render, so
// it avoids the one dependency that can be missing.

const SPRING = 0.012;
const REPULSION = 0.55;
const DAMPING = 0.86;
const SETTLE_STEPS = 260;
const REDUCED_MOTION_STEPS = 40;
const REPULSION_SAMPLES = 6;
const REPULSION_CUTOFF = 0.25;

type Node = { x: number; y: number; vx: number; vy: number };

/** Deterministic PRNG so a given session always lays out identically. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function initialNodes(count: number): Node[] {
  const random = seededRandom(42);
  return Array.from({ length: count }, () => {
    // Seed on a disc rather than a square; a square's corners bias the first
    // few iterations toward the diagonals.
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 0.4;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  });
}

export function VectorHologram({
  points,
  edges = [],
  selectedEventId,
  onSelect,
  config,
  reducedMotion = false,
  ariaLabel,
  className,
}: VectorVisualizationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState(-1);
  const showLinks = config?.links !== false;
  const glow = config?.glow !== false;

  const selectedIndex = useMemo(
    () => points.findIndex((point) => point.event_id === selectedEventId),
    [points, selectedEventId],
  );

  // Run the simulation to rest once per data change, then draw from the result.
  // Settling up front (rather than animating) keeps this cheap and makes the
  // output deterministic, which in turn makes it testable.
  const layout = useMemo(() => {
    const count = points.length;
    if (count === 0) return { nodes: [] as Node[], degree: [] as number[] };
    const nodes = initialNodes(count);
    const degree = new Array<number>(count).fill(0);
    for (const edge of edges) {
      if (edge.s < count && edge.t < count) {
        degree[edge.s]! += 1;
        degree[edge.t]! += 1;
      }
    }
    const random = seededRandom(7);
    const steps = reducedMotion ? REDUCED_MOTION_STEPS : SETTLE_STEPS;
    for (let step = 0; step < steps; step++) {
      for (const edge of edges) {
        const a = nodes[edge.s];
        const b = nodes[edge.t];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 0.001;
        // Semantically closer neighbours settle to a shorter rest length.
        const rest = 0.07 + edge.d * 0.5;
        const force = (SPRING * (length - rest)) / length;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
      // Monte-Carlo repulsion: sampling a handful of partners per node per step
      // approximates all-pairs at a fraction of the cost, and the error washes
      // out over hundreds of iterations.
      for (let index = 0; index < count; index++) {
        const node = nodes[index]!;
        for (let sample = 0; sample < REPULSION_SAMPLES; sample++) {
          const other = nodes[Math.floor(random() * count)]!;
          if (other === node) continue;
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const squared = dx * dx + dy * dy;
          if (squared > REPULSION_CUTOFF || squared === 0) continue;
          const push = REPULSION / (squared + 0.01);
          node.vx += dx * push * 0.0005;
          node.vy += dy * push * 0.0005;
        }
      }
      for (const node of nodes) {
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
      }
    }
    return { nodes, degree };
  }, [points, edges, reducedMotion]);

  // Fit the settled layout into the viewport regardless of how far it spread.
  const projected = useMemo(() => {
    const { nodes } = layout;
    if (!nodes.length) return [] as { x: number; y: number }[];
    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const span = Math.max(spanX, spanY);
    return nodes.map((node) => ({
      x: 0.5 + (node.x - (minX + maxX) / 2) / span * 0.9,
      y: 0.5 + (node.y - (minY + maxY) / 2) / span * 0.9,
    }));
  }, [layout]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.clientWidth || 720;
    const height = canvas.clientHeight || 400;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const at = (index: number) => {
      const point = projected[index];
      return point ? { x: point.x * width, y: point.y * height } : null;
    };

    if (showLinks) {
      for (const edge of edges) {
        const from = at(edge.s);
        const to = at(edge.t);
        if (!from || !to) continue;
        const focused = selectedIndex === edge.s || selectedIndex === edge.t
          || hovered === edge.s || hovered === edge.t;
        context.strokeStyle = focused
          ? "rgba(150,190,250,0.55)"
          : `rgba(120,160,220,${0.06 + (1 - edge.d) * 0.1})`;
        context.lineWidth = focused ? 1.4 : 0.7;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }
    }

    points.forEach((point, index) => {
      const position = at(index);
      if (!position) return;
      const isSelected = index === selectedIndex;
      const isHovered = index === hovered;
      const connections = layout.degree[index] ?? 0;
      const radius = 2 + Math.min(4, connections * 0.45) + (isSelected ? 3 : 0);
      // Colour by actor, so a human turn is distinguishable from an agent one.
      const human = point.semantic_role === "human_intent";
      const [r, g, b] = human ? [123, 178, 245] : [240, 196, 116];
      const alpha = isSelected ? 1 : isHovered ? 0.95 : 0.75;
      if (glow) {
        const gradient = context.createRadialGradient(
          position.x, position.y, 0, position.x, position.y, radius * 3,
        );
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(0.3, `rgba(${r},${g},${b},${alpha * 0.8})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(position.x, position.y, radius * 3, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      context.beginPath();
      context.arc(position.x, position.y, radius, 0, Math.PI * 2);
      context.fill();
      if (isSelected) {
        context.strokeStyle = "rgba(255,255,255,0.9)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(position.x, position.y, radius + 3, 0, Math.PI * 2);
        context.stroke();
      }
    });
  }, [points, edges, projected, selectedIndex, hovered, showLinks, glow, layout]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  const locate = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    let best = -1;
    let bestDistance = 18;
    projected.forEach((point, index) => {
      const distance = Math.hypot(point.x * bounds.width - x, point.y * bounds.height - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }, [projected]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
      onMouseMove={(event) => setHovered(locate(event))}
      onMouseLeave={() => setHovered(-1)}
      onClick={(event) => {
        const index = locate(event);
        const point = index >= 0 ? points[index] : undefined;
        if (point) onSelect(point.event_id);
      }}
    />
  );
}

export default VectorHologram;
