import { VectorMap2D } from "./VectorMap2D";
import {
  createVectorVisualizationRegistry,
  type VectorVisualizationPlugin,
} from "./vector-visualization";

export const VECTOR_VISUALIZATIONS = createVectorVisualizationRegistry([
  {
    id: "3d",
    label: "Atlas 3D",
    description: "Explore the vector space as a rotatable three-dimensional atlas.",
    dimension: 3,
    defaultConfig: { spin: false },
    configControls: [{
      key: "spin",
      type: "toggle",
      label: "Auto rotate",
      description: "Slowly rotate the atlas while it is idle.",
    }],
    load: async () => ({ default: (await import("./VectorMap3D")).VectorMap3D }),
  },
  {
    id: "2d",
    label: "Flat 2D",
    description: "View the projection on a stable two-dimensional plane.",
    dimension: 2,
    defaultConfig: {},
    configControls: [],
    load: async () => ({ default: VectorMap2D }),
  },
] as const satisfies readonly VectorVisualizationPlugin[]);

export const VECTOR_VISUALIZATION_IDS = Object.freeze(VECTOR_VISUALIZATIONS.map(({ id }) => id));
export type VectorView = (typeof VECTOR_VISUALIZATION_IDS)[number];

export function normalizeVectorVisualizationId(value: string | null | undefined): VectorView {
  return VECTOR_VISUALIZATION_IDS.includes(value as VectorView) ? value as VectorView : "3d";
}

export function getVectorVisualization(value: string | null | undefined): (typeof VECTOR_VISUALIZATIONS)[number] {
  const id = normalizeVectorVisualizationId(value);
  return VECTOR_VISUALIZATIONS.find((plugin) => plugin.id === id)!;
}
