# Vector visualization plugins

History visualizations are replaceable React components. The host keeps vector
spaces, filters, loading, errors, selection, and evidence navigation honest; a
plugin only draws the already-projected points and reports a selected
`event_id`.

## Contract

```ts
type VectorVisualizationPlugin = {
  id: string;
  label: string;
  description: string;
  dimension: 2 | 3;
  defaultConfig: Readonly<Record<string, boolean | number | string>>;
  configControls: readonly VectorVisualizationConfigControl[];
  load(): Promise<{ default: ComponentType<VectorVisualizationProps> }>;
};

type VectorVisualizationProps = {
  points: readonly VectorVisualizationPoint[];
  selectedEventId: string;
  onSelect(eventId: string): void;
  config?: VectorVisualizationConfig;
  onConfigChange?(config: VectorVisualizationConfig): void;
  reducedMotion?: boolean;
  onUnavailable?(reason: string): void;
  ariaLabel?: string;
  className?: string;
};
```

`id` is a stable kebab-case URL value. `label` and `description` are operator
copy. `dimension` declares the projected axes the renderer consumes.
`defaultConfig` supplies every key named by `configControls`; controls may be a
boolean `toggle`, numeric `range`, or string `select`. `load()` is the lazy
component boundary.

The component receives immutable projected `points`. It highlights
`selectedEventId`, calls `onSelect()` with an existing event ID, honors
`reducedMotion`, and calls `onUnavailable()` when its rendering capability is
missing. It may request a config update through `onConfigChange()`. It must
apply `ariaLabel` and `className` to its primary rendered surface.

## Host-owned invariants

- Fetch each embedding deployment from its own LanceDB directory.
- Never overlay or compare coordinates across incompatible spaces.
- Apply Human/Agent filters before coverage, sampling, and PCA.
- Coordinate panels only by stable `event_id`.
- Keep the evidence list as the keyboard-equivalent interface.
- Catch plugin failures; `Atlas 3D` falls back to `Flat 2D` inside the same
  provider panel, never to another embedding provider.

## Add a visualizer

1. Implement a component accepting `VectorVisualizationProps`.
2. Add one declarative entry to `VECTOR_VISUALIZATIONS` in
   `ui/src/vector-visualizations.ts`; use a dynamic import for heavy engines.
3. Add defaults for every declared control and keep the ID stable once shipped.
4. Extend `ui/src/vector-visualizations.test.ts` with registry, normalization,
   selection, and failure behavior.
5. Run `bun test`, `bun run typecheck`, and `bun run ui:build`.

Built-ins are `Atlas 3D` (`3d`, Three.js, lazy) and `Flat 2D` (`2d`, SVG). The
IDs retain compatibility with existing History URLs.
