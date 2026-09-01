import type { ComponentType } from "react";

export type VectorVisualizationPoint = {
  readonly event_id: string;
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly semantic_role: string;
  readonly block_type?: string;
  readonly text_preview?: string;
};

/**
 * Neighbour relationship between two points, by index into `points`.
 * Supplied by the host for layouts that position nodes by connectivity rather
 * than by the projected coordinates. Optional: a plugin must still render when
 * the host has no edges to give it.
 */
export type VectorVisualizationEdge = {
  readonly s: number;
  readonly t: number;
  readonly d: number;
};

export type VectorVisualizationConfig = Readonly<Record<string, boolean | number | string>>;

export type VectorVisualizationConfigControl = {
  key: string;
  label: string;
  description?: string;
} & (
  | { type: "toggle" }
  | { type: "range"; min: number; max: number; step?: number }
  | { type: "select"; options: readonly { value: string; label: string }[] }
);

export type VectorVisualizationProps = {
  points: readonly Readonly<VectorVisualizationPoint>[];
  edges?: readonly Readonly<VectorVisualizationEdge>[];
  selectedEventId: string;
  onSelect: (eventId: string) => void;
  config?: VectorVisualizationConfig;
  onConfigChange?: (config: VectorVisualizationConfig) => void;
  reducedMotion?: boolean;
  onUnavailable?: (reason: string) => void;
  ariaLabel?: string;
  className?: string;
};

export type VectorVisualizationPlugin = {
  id: string;
  label: string;
  description: string;
  dimension: 2 | 3;
  defaultConfig: VectorVisualizationConfig;
  configControls: readonly VectorVisualizationConfigControl[];
  load: () => Promise<{ default: ComponentType<VectorVisualizationProps> }>;
};

function assertPlugin(plugin: VectorVisualizationPlugin): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.id)) {
    throw new Error(`Invalid vector visualization id: ${JSON.stringify(plugin.id)}`);
  }
  if (!plugin.label.trim() || !plugin.description.trim()) {
    throw new Error(`Vector visualization ${plugin.id} must have a label and description`);
  }
  if (plugin.dimension !== 2 && plugin.dimension !== 3) {
    throw new Error(`Vector visualization ${plugin.id} must have dimension 2 or 3`);
  }
  const controlKeys = new Set<string>();
  for (const control of plugin.configControls) {
    if (controlKeys.has(control.key)) {
      throw new Error(`Vector visualization ${plugin.id} has duplicate config control ${control.key}`);
    }
    controlKeys.add(control.key);
    if (!(control.key in plugin.defaultConfig)) {
      throw new Error(`Vector visualization ${plugin.id} control ${control.key} has no default value`);
    }
    if (!control.label.trim()) {
      throw new Error(`Vector visualization ${plugin.id} control ${control.key} must have a label`);
    }
    const value = plugin.defaultConfig[control.key];
    if (control.type === "toggle" && typeof value !== "boolean") {
      throw new Error(`Vector visualization ${plugin.id} toggle ${control.key} must default to a boolean`);
    }
    if (control.type === "range") {
      if (!Number.isFinite(control.min) || !Number.isFinite(control.max) || control.max < control.min) {
        throw new Error(`Vector visualization ${plugin.id} range ${control.key} has invalid bounds`);
      }
      if (control.step !== undefined && (!Number.isFinite(control.step) || control.step <= 0)) {
        throw new Error(`Vector visualization ${plugin.id} range ${control.key} has an invalid step`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < control.min || value > control.max) {
        throw new Error(`Vector visualization ${plugin.id} range ${control.key} has an invalid default`);
      }
    }
    if (control.type === "select") {
      if (!control.options.length) {
        throw new Error(`Vector visualization ${plugin.id} select ${control.key} must declare options`);
      }
      const optionValues = new Set<string>();
      for (const option of control.options) {
        if (!option.value || !option.label.trim() || optionValues.has(option.value)) {
          throw new Error(`Vector visualization ${plugin.id} select ${control.key} has invalid options`);
        }
        optionValues.add(option.value);
      }
      if (typeof value !== "string" || !optionValues.has(value)) {
        throw new Error(`Vector visualization ${plugin.id} select ${control.key} has an invalid default`);
      }
    }
  }
}

function freezeControl(control: VectorVisualizationConfigControl): void {
  if (control.type === "select") {
    for (const option of control.options) Object.freeze(option);
    Object.freeze(control.options);
  }
  Object.freeze(control);
}

/** Validate and freeze a declarative plugin list at its registration boundary. */
export function createVectorVisualizationRegistry<const T extends readonly VectorVisualizationPlugin[]>(
  plugins: T,
): T {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    assertPlugin(plugin);
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate vector visualization id: ${plugin.id}`);
    }
    ids.add(plugin.id);
    Object.freeze(plugin.defaultConfig);
    for (const control of plugin.configControls) freezeControl(control);
    Object.freeze(plugin.configControls);
    Object.freeze(plugin);
  }
  return Object.freeze([...plugins]) as unknown as T;
}

export function pointCoordinates(
  points: readonly Pick<VectorVisualizationPoint, "event_id" | "x" | "y">[],
): Map<string, { x: number; y: number }> {
  const normalized = (value: number) => Number.isFinite(value)
    ? Math.max(-1, Math.min(1, value))
    : 0;
  return new Map(points.map((point) => [point.event_id, {
    x: 30 + ((normalized(point.x) + 1) / 2) * 660,
    y: 30 + ((1 - normalized(point.y)) / 2) * 340,
  }]));
}
