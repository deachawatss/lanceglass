// Neighbour graph for force-directed visualizations.
//
// The PCA projection answers "where does this point sit on the three axes that
// explain the most variance". A force-directed layout answers a different
// question — "which points are actually near each other in the full space" —
// and the two disagree, because 1,024 dimensions do not survive a projection to
// three. Edges are therefore computed from the raw vectors, never from x/y/z.
//
// The graph is mutual kNN unioned with a minimum spanning tree. Mutual kNN
// alone fragments into islands that drift apart forever under repulsion; the
// spanning tree is the cheapest guarantee that every node stays reachable.

export type VectorEdge = {
  /** Index into the caller's point array. */
  s: number;
  /** Index into the caller's point array. */
  t: number;
  /** Cosine distance rescaled to 0..1 across the kept edges. */
  d: number;
};

export const DEFAULT_EDGE_NEIGHBORS = 6;

/** Cosine distance, guarding against a zero-length vector. */
function cosineDistance(left: ArrayLike<number>, right: ArrayLike<number>) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (magnitude === 0) return 1;
  return Math.max(0, Math.min(2, 1 - dot / magnitude));
}

function key(left: number, right: number) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

/**
 * Build a connected neighbour graph over `vectors`.
 *
 * Returns edges indexed against the input order, so a caller can zip them
 * straight onto its own point array.
 */
export function buildVectorEdges(
  vectors: readonly ArrayLike<number>[],
  neighbors: number = DEFAULT_EDGE_NEIGHBORS,
): VectorEdge[] {
  const count = vectors.length;
  if (count < 2) return [];
  const k = Math.max(1, Math.min(neighbors, count - 1));

  // Full pairwise distances. Bounded by MAX_HISTORY_VECTOR_POINTS, so this stays
  // a few hundred thousand comparisons rather than an open-ended cost.
  const distance: number[][] = Array.from({ length: count }, () => new Array<number>(count).fill(0));
  for (let left = 0; left < count; left++) {
    for (let right = left + 1; right < count; right++) {
      const value = cosineDistance(vectors[left]!, vectors[right]!);
      distance[left]![right] = value;
      distance[right]![left] = value;
    }
  }

  const nearest = Array.from({ length: count }, (_unused, index) => {
    const order = Array.from({ length: count }, (_ignored, other) => other)
      .filter((other) => other !== index)
      .sort((left, right) => distance[index]![left]! - distance[index]![right]!);
    return order.slice(0, k);
  });

  const nearestSets = nearest.map((list) => new Set(list));
  const kept = new Map<string, VectorEdge>();

  // Mutual kNN: both endpoints must agree the other is a near neighbour.
  for (let index = 0; index < count; index++) {
    for (const other of nearest[index]!) {
      if (!nearestSets[other]!.has(index)) continue;
      const id = key(index, other);
      if (kept.has(id)) continue;
      kept.set(id, { s: Math.min(index, other), t: Math.max(index, other), d: distance[index]![other]! });
    }
  }

  // Prim's minimum spanning tree, so the graph is always one connected body.
  const inTree = new Array<boolean>(count).fill(false);
  const best = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(count).fill(-1);
  best[0] = 0;
  for (let step = 0; step < count; step++) {
    let pick = -1;
    for (let index = 0; index < count; index++) {
      if (!inTree[index] && (pick === -1 || best[index]! < best[pick]!)) pick = index;
    }
    if (pick === -1) break;
    inTree[pick] = true;
    if (parent[pick]! >= 0) {
      const id = key(pick, parent[pick]!);
      if (!kept.has(id)) {
        kept.set(id, {
          s: Math.min(pick, parent[pick]!),
          t: Math.max(pick, parent[pick]!),
          d: distance[pick]![parent[pick]!]!,
        });
      }
    }
    for (let index = 0; index < count; index++) {
      if (inTree[index]) continue;
      const candidate = distance[pick]![index]!;
      if (candidate < best[index]!) {
        best[index] = candidate;
        parent[index] = pick;
      }
    }
  }

  // Rescale to 0..1 so the layout's rest-length formula behaves the same way
  // whether a session is semantically tight or spread out.
  const edges = [...kept.values()];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const edge of edges) {
    if (edge.d < low) low = edge.d;
    if (edge.d > high) high = edge.d;
  }
  const span = high - low;
  for (const edge of edges) {
    edge.d = span > 0 ? (edge.d - low) / span : 0;
  }
  edges.sort((left, right) => left.s - right.s || left.t - right.t);
  return edges;
}
