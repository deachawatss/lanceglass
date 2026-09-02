import {
  normalizeVectorVisualizationId,
  type VectorView,
} from "./vector-visualizations";
import { normalizeVectorBreadth, type VectorBreadth } from "./vector-scope";

export type { VectorView } from "./vector-visualizations";

export type WorkspaceName = "events" | "history" | "jobs";
export type EventsView = "stream" | "visualize";
export type HistoryPeriod = "day" | "week" | "month";
export const VECTOR_PROVIDERS = ["dual-4090", "cloudflare"] as const;
export const VECTOR_ACTORS = ["human", "agent"] as const;
export type VectorProvider = typeof VECTOR_PROVIDERS[number];
export type VectorActor = typeof VECTOR_ACTORS[number];

const APP_HISTORY_ENTRY_KEY = "lanceglass";
const HISTORY_VECTOR_ENTRY = "history-vector";

type AppHistoryState = Record<string, unknown> & {
  [APP_HISTORY_ENTRY_KEY]?: typeof HISTORY_VECTOR_ENTRY;
};

export type WorkspaceLocation = {
  workspace: WorkspaceName;
  job: string;
  source: string | null;
  project: string;
  folder: string;
  view: EventsView;
  historyPeriod: HistoryPeriod;
  historyDate: string;
  vectorOperation?: "vectors" | "";
  vectorSession?: string;
  vectorDate?: string;
  vectorSource?: string;
  vectorProject?: string;
  vectorFolder?: string;
  vectorProviders?: VectorProvider[];
  vectorActors?: VectorActor[];
  vectorView?: VectorView;
  vectorBreadth?: VectorBreadth;
};

const ALL_SOURCES = "*";
const DEFAULT_HISTORY_PERIOD: HistoryPeriod = "week";

function historyStateRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
}

export function appOwnedHistoryVectorState(state: unknown): AppHistoryState {
  return {
    ...historyStateRecord(state),
    [APP_HISTORY_ENTRY_KEY]: HISTORY_VECTOR_ENTRY,
  };
}

export function historyVectorCloseAction(state: unknown): "back" | "replace" {
  return historyStateRecord(state)[APP_HISTORY_ENTRY_KEY] === HISTORY_VECTOR_ENTRY
    ? "back"
    : "replace";
}

function readWorkspace(value: string | null): WorkspaceName {
  return value === "history" || value === "jobs" ? value : "events";
}

function readHistoryPeriod(value: string | null): HistoryPeriod {
  return value === "day" || value === "month" ? value : DEFAULT_HISTORY_PERIOD;
}

function readHistoryDate(value: string | null): string {
  const candidate = value?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? ""
    : candidate;
}

function selectedValues<T extends string>(
  values: string[],
  options: readonly T[],
  fallback: readonly T[],
) {
  const selected = new Set(values);
  const normalized = options.filter((option) => selected.has(option));
  return normalized.length ? normalized : [...fallback];
}

export function readVectorProviders(query: URLSearchParams): VectorProvider[] {
  return selectedValues(query.getAll("vector_provider"), VECTOR_PROVIDERS, ["dual-4090"]);
}

export function readVectorActors(query: URLSearchParams): VectorActor[] {
  return selectedValues(query.getAll("vector_actor"), VECTOR_ACTORS, VECTOR_ACTORS);
}

export function readVectorBreadth(value: string | null): VectorBreadth {
  return normalizeVectorBreadth(value);
}

export function readVectorView(value: string | null): VectorView {
  return normalizeVectorVisualizationId(value);
}

export function readWorkspaceLocation(location: Pick<Location, "search">): WorkspaceLocation {
  const query = new URLSearchParams(location.search);
  const source = query.get("source");
  const workspace = readWorkspace(query.get("workspace"));
  const requestedVectorOperation = workspace === "history" && query.get("operate") === "vectors";
  const vectorSession = requestedVectorOperation ? query.get("vector_session")?.trim() ?? "" : "";
  const vectorDate = requestedVectorOperation ? readHistoryDate(query.get("vector_date")) : "";
  const vectorSource = requestedVectorOperation ? query.get("vector_source")?.trim() ?? "" : "";
  const vectorProject = requestedVectorOperation ? query.get("vector_project")?.trim() ?? "" : "";
  const vectorFolder = requestedVectorOperation ? query.get("vector_folder")?.trim() ?? "" : "";
  const vectorOperation = requestedVectorOperation && vectorSession && vectorDate && vectorSource &&
      vectorFolder && query.has("vector_project")
    ? "vectors"
    : "";
  return {
    workspace,
    job: query.get("job")?.trim() ?? "",
    source: source === null ? null : source === ALL_SOURCES ? "" : source,
    project: query.get("project")?.trim() ?? "",
    folder: query.get("folder")?.trim() ?? "",
    view: query.get("view") === "visualize" ? "visualize" : "stream",
    historyPeriod: readHistoryPeriod(query.get("period")),
    historyDate: readHistoryDate(query.get("date")),
    vectorOperation,
    vectorSession: vectorOperation ? vectorSession : "",
    vectorDate: vectorOperation ? vectorDate : "",
    vectorSource: vectorOperation ? vectorSource : "",
    vectorProject: vectorOperation ? vectorProject : "",
    vectorFolder: vectorOperation ? vectorFolder : "",
    vectorProviders: vectorOperation ? readVectorProviders(query) : ["dual-4090"],
    vectorActors: vectorOperation ? readVectorActors(query) : [...VECTOR_ACTORS],
    vectorView: vectorOperation ? readVectorView(query.get("vector_view")) : "3d",
    vectorBreadth: vectorOperation ? readVectorBreadth(query.get("vector_breadth")) : "session",
  };
}

export function workspaceHref(
  pathname: string,
  location: WorkspaceLocation,
) {
  const query = new URLSearchParams();
  query.set("workspace", location.workspace);
  if (location.workspace === "jobs" && location.job) query.set("job", location.job);
  if (location.source !== null) query.set("source", location.source || ALL_SOURCES);
  if (location.project) query.set("project", location.project);
  if (location.folder) query.set("folder", location.folder);
  query.set("view", location.view);
  query.set("period", location.historyPeriod);
  if (location.historyDate) query.set("date", location.historyDate);
  if (location.workspace === "history" && location.vectorOperation === "vectors" && location.vectorSession) {
    query.set("operate", "vectors");
    for (const provider of selectedValues(
      location.vectorProviders ?? [],
      VECTOR_PROVIDERS,
      ["dual-4090"],
    )) query.append("vector_provider", provider);
    for (const actor of selectedValues(
      location.vectorActors ?? [],
      VECTOR_ACTORS,
      VECTOR_ACTORS,
    )) query.append("vector_actor", actor);
    query.set("vector_view", location.vectorView ?? "3d");
    query.set("vector_breadth", location.vectorBreadth ?? "session");
    query.set("vector_date", location.vectorDate ?? "");
    query.set("vector_source", location.vectorSource ?? "");
    query.set("vector_project", location.vectorProject ?? "");
    query.set("vector_folder", location.vectorFolder ?? "");
    query.set("vector_session", location.vectorSession);
  }
  return `${pathname || "/"}?${query}`;
}
