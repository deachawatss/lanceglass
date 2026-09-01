import { describe, expect, test } from "bun:test";
import { buildVectorEdges } from "../src/vector-edges";

/** Unit vector on a circle, so expected cosine distances are known by hand. */
function onCircle(degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), 0];
}

describe("buildVectorEdges", () => {
  test("returns no edges for fewer than two vectors", () => {
    expect(buildVectorEdges([])).toEqual([]);
    expect(buildVectorEdges([[1, 0, 0]])).toEqual([]);
  });

  test("connects the only possible pair", () => {
    const edges = buildVectorEdges([[1, 0, 0], [0, 1, 0]]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.s).toBe(0);
    expect(edges[0]!.t).toBe(1);
  });

  test("links the two members of each tight cluster", () => {
    // Two clusters 90 degrees apart; within a cluster the points are 2 degrees apart.
    const vectors = [onCircle(0), onCircle(2), onCircle(90), onCircle(92)];
    const edges = buildVectorEdges(vectors, 1);
    const pairs = edges.map((edge) => `${edge.s}-${edge.t}`);
    // Expected from the geometry, not from the implementation: 0's nearest is 1
    // and 2's nearest is 3, so both intra-cluster pairs are mutual.
    expect(pairs).toContain("0-1");
    expect(pairs).toContain("2-3");
  });

  test("keeps the graph connected even when clusters are far apart", () => {
    const vectors = [onCircle(0), onCircle(1), onCircle(170), onCircle(171)];
    const edges = buildVectorEdges(vectors, 1);
    // Walk the graph from node 0; every node must be reachable via the spanning tree.
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      adjacency.set(edge.s, [...(adjacency.get(edge.s) ?? []), edge.t]);
      adjacency.set(edge.t, [...(adjacency.get(edge.t) ?? []), edge.s]);
    }
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(vectors.length);
  });

  test("normalizes distance to the 0..1 range", () => {
    const vectors = [onCircle(0), onCircle(10), onCircle(60), onCircle(140)];
    const edges = buildVectorEdges(vectors, 2);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.d).toBeGreaterThanOrEqual(0);
      expect(edge.d).toBeLessThanOrEqual(1);
    }
    expect(Math.min(...edges.map((edge) => edge.d))).toBe(0);
    expect(Math.max(...edges.map((edge) => edge.d))).toBe(1);
  });

  test("orders a closer pair below a farther pair", () => {
    // 0-1 are 5 degrees apart, 2-3 are 80 degrees apart. cos(5°) > cos(80°),
    // so the 0-1 cosine distance is strictly smaller.
    const vectors = [onCircle(0), onCircle(5), onCircle(180), onCircle(260)];
    const edges = buildVectorEdges(vectors, 1);
    const near = edges.find((edge) => edge.s === 0 && edge.t === 1);
    const far = edges.find((edge) => edge.s === 2 && edge.t === 3);
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    expect(near!.d).toBeLessThan(far!.d);
  });

  test("emits each undirected pair once", () => {
    const vectors = Array.from({ length: 12 }, (_unused, index) => onCircle(index * 30));
    const edges = buildVectorEdges(vectors, 4);
    const seen = new Set(edges.map((edge) => `${edge.s}:${edge.t}`));
    expect(seen.size).toBe(edges.length);
    for (const edge of edges) expect(edge.s).toBeLessThan(edge.t);
  });

  test("treats a zero vector as maximally distant instead of dividing by zero", () => {
    const edges = buildVectorEdges([[0, 0, 0], [1, 0, 0], [0.99, 0.14, 0]], 1);
    for (const edge of edges) expect(Number.isFinite(edge.d)).toBe(true);
  });
});
