import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import {
  createVectorVisualizationRegistry,
  pointCoordinates,
  type VectorVisualizationPlugin,
  type VectorVisualizationProps,
} from "./vector-visualization";
import {
  getVectorVisualization,
  normalizeVectorVisualizationId,
  VECTOR_VISUALIZATION_IDS,
  VECTOR_VISUALIZATIONS,
} from "./vector-visualizations";

const NullVisualization = (() => null) as ComponentType<VectorVisualizationProps>;
const plugin = (overrides: Partial<VectorVisualizationPlugin> = {}): VectorVisualizationPlugin => ({
  id: "test-view",
  label: "Test view",
  description: "A test visualization.",
  dimension: 2,
  defaultConfig: {},
  configControls: [],
  load: async () => ({ default: NullVisualization }),
  ...overrides,
});

describe("vector visualization registry", () => {
  test("publishes stable URL-compatible built-ins with Atlas 3D as the default", () => {
    expect(VECTOR_VISUALIZATION_IDS).toEqual(["3d", "2d", "hologram"]);
    expect(VECTOR_VISUALIZATIONS.map(({ label }) => label)).toEqual(["Atlas 3D", "Flat 2D", "Hologram"]);
    expect(normalizeVectorVisualizationId("2d")).toBe("2d");
    expect(normalizeVectorVisualizationId("future-view")).toBe("3d");
    expect(normalizeVectorVisualizationId(null)).toBe("3d");
    expect(getVectorVisualization(undefined).id).toBe("3d");
  });


  test("registers the hologram plugin with defaults for every control", () => {
    const hologram = getVectorVisualization("hologram");
    expect(hologram.id).toBe("hologram");
    expect(hologram.dimension).toBe(2);
    // The contract requires defaultConfig to supply every key configControls names.
    for (const control of hologram.configControls) {
      expect(Object.keys(hologram.defaultConfig)).toContain(control.key);
    }
    expect(hologram.defaultConfig).toEqual({ links: true, glow: true });
  });

  test("resolves hologram from a URL value and falls back for an unknown one", () => {
    expect(normalizeVectorVisualizationId("hologram")).toBe("hologram");
    expect(normalizeVectorVisualizationId("holo")).toBe("3d");
  });

  test("loads the hologram component lazily", async () => {
    const loaded = await getVectorVisualization("hologram").load();
    expect(typeof loaded.default).toBe("function");
  });

  test("rejects duplicate ids and controls without default config", () => {
    expect(() => createVectorVisualizationRegistry([plugin(), plugin()])).toThrow("Duplicate");
    expect(() => createVectorVisualizationRegistry([plugin({
      defaultConfig: {},
      configControls: [{ key: "spin", type: "toggle", label: "Spin" }],
    })])).toThrow("has no default value");
  });

  test("validates control defaults and deeply freezes registry metadata", () => {
    expect(() => createVectorVisualizationRegistry([plugin({
      defaultConfig: { spin: "yes" },
      configControls: [{ key: "spin", type: "toggle", label: "Spin" }],
    })])).toThrow("must default to a boolean");
    expect(() => createVectorVisualizationRegistry([plugin({
      defaultConfig: { density: 12 },
      configControls: [{ key: "density", type: "range", label: "Density", min: 0, max: 10 }],
    })])).toThrow("invalid default");
    expect(() => createVectorVisualizationRegistry([plugin({
      defaultConfig: { palette: "missing" },
      configControls: [{ key: "palette", type: "select", label: "Palette", options: [{ value: "calm", label: "Calm" }] }],
    })])).toThrow("invalid default");

    const options = [{ value: "calm", label: "Calm" }];
    const controls = [{ key: "palette", type: "select" as const, label: "Palette", options }];
    const [registered] = createVectorVisualizationRegistry([plugin({
      defaultConfig: { palette: "calm" },
      configControls: controls,
    })]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered!.configControls)).toBe(true);
    expect(Object.isFrozen(registered!.configControls[0])).toBe(true);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options[0])).toBe(true);
  });

  test("extracts finite clamped 2D coordinates", () => {
    expect(pointCoordinates([
      { event_id: "center", x: Number.NaN, y: Number.POSITIVE_INFINITY },
      { event_id: "edge", x: 9, y: -9 },
    ])).toEqual(new Map([
      ["center", { x: 360, y: 200 }],
      ["edge", { x: 690, y: 370 }],
    ]));
  });
});
