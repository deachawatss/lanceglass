import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ErrorInfo, ReactNode, Ref } from "react";
import { nextHistoryDate, shiftHistoryDate } from "./history-date";
import { sortHistoryRecords, type HistoryGroupOrder } from "./history-sort";
import { historySourceNumbers } from "./history-source";
import { createLatestRequestRunner } from "./latest-request";
import { ProjectCombobox } from "./ProjectCombobox";
import {
  readWorkspaceLocation,
  VECTOR_ACTORS,
  VECTOR_PROVIDERS,
  type HistoryPeriod,
  type VectorActor,
  type VectorProvider,
  type VectorView,
} from "./location";
import {
  getVectorVisualization,
  VECTOR_VISUALIZATIONS,
} from "./vector-visualizations";
import {
  type VectorVisualizationConfig,
  type VectorVisualizationEdge,
  type VectorVisualizationPlugin,
  type VectorVisualizationPoint,
  type VectorVisualizationProps,
} from "./vector-visualization";
import {
  VECTOR_BREADTH_LABEL,
  VECTOR_BREADTH_LIMIT,
  VECTOR_BREADTHS,
  widenVectorScope,
  type VectorBreadth,
} from "./vector-scope";

export { pointCoordinates } from "./vector-visualization";

const VECTOR_VISUALIZATION_COMPONENTS = Object.fromEntries(
  VECTOR_VISUALIZATIONS.map((plugin) => [plugin.id, lazy(plugin.load)]),
) as unknown as Record<VectorView, ComponentType<VectorVisualizationProps>>;

type CountFacet = { value: string; count: number };
type FolderFacet = CountFacet & { label: string };

type HistorySession = {
  session_id: string;
  source: string;
  project: string;
  folder: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  preview: string;
  continues_before: boolean;
  continues_after: boolean;
};

type HistoryGroup = {
  source: string;
  project: string;
  folder: string;
  event_count: number;
  session_count: number;
  sessions: HistorySession[];
};

type HistoryDay = {
  date: string;
  event_count: number;
  session_count: number;
  groups: HistoryGroup[];
};

type HistoryRecord = {
  group: HistoryGroup;
  session: HistorySession;
  sourceNumber: string;
};

type HistoryDisplayDay = HistoryDay & { records: HistoryRecord[] };

type HistoryResponse = {
  time_zone: "Asia/Bangkok";
  period: HistoryPeriod;
  date: string;
  anchor: string;
  start: string;
  end: string;
  source: string;
  project: string;
  folder: string;
  totals: {
    days: number;
    active_days: number;
    events: number;
    sessions: number;
    sources: number;
    projects: number;
    folders: number;
  };
  days: HistoryDay[];
};

type HistoryEvent = {
  id: string;
  timestamp: string;
  block_index: number;
  block_type: string;
  semantic_role: string;
  tool_name: string;
  text: string;
};

type SessionResponse = {
  time_zone: "Asia/Bangkok";
  date: string;
  source: string;
  project: string;
  folder: string;
  session_id: string;
  offset: number;
  limit: number;
  total: number;
  selected_day_events: number;
  next_offset: number | null;
  events: HistoryEvent[];
};

type SessionState = {
  loading: boolean;
  error: string;
  total: number;
  selectedDayEvents: number;
  nextOffset: number | null;
  events: HistoryEvent[];
};

export type HistoryVectorScope = {
  date: string;
  source: string;
  project: string;
  folder: string;
  session_id: string;
};

type VectorPoint = VectorVisualizationPoint & {
  event_id: string;
  timestamp: string;
  block_type: string;
  semantic_role: string;
  tool_name: string;
  text_preview: string;
};

type VectorMapResponse = {
  available: boolean;
  deployment: string;
  space: {
    id: string;
    provider: string;
    model: string;
    revision: string;
    dimension: number;
    distance: string;
    text_policy: string;
  } | null;
  scope: HistoryVectorScope & { actors: VectorActor[] };
  coverage: { eligible: number; embedded: number; missing: number; sampled: number };
  projection: { method: string; explained_variance: number | null };
  points: VectorPoint[];
  // Neighbour graph over `points`, computed server-side from the raw vectors.
  // Optional so an older server that predates it still deserializes.
  edges?: VectorVisualizationEdge[];
  error?: string;
};

type VectorProviderState = {
  loading: boolean;
  error: string;
  response: VectorMapResponse | null;
};

type VectorMapState = {
  scope: HistoryVectorScope;
  breadth: VectorBreadth;
  providers: VectorProvider[];
  actors: VectorActor[];
  view: VectorView;
  maps: Partial<Record<VectorProvider, VectorProviderState>>;
  selectedEventId: string;
};

type Props = {
  period: HistoryPeriod;
  date: string;
  source: string;
  project: string;
  folder: string;
  sources: string[];
  projectFacets: CountFacet[];
  folderFacets: FolderFacet[];
  projectShortcut: string;
  projectRef?: Ref<HTMLInputElement>;
  onPeriodChange: (period: HistoryPeriod) => void;
  onDateChange: (date: string) => void;
  onSourceChange: (source: string) => void;
  onProjectChange: (project: string) => void;
  onFolderChange: (folder: string) => void;
  vectorOperation?: "vectors" | "";
  vectorProviders?: VectorProvider[];
  vectorActors?: VectorActor[];
  vectorView?: VectorView;
  vectorBreadth?: VectorBreadth;
  vectorDate?: string;
  vectorSource?: string;
  vectorProject?: string;
  vectorFolder?: string;
  vectorSession?: string;
  onVectorOpen?: (scope: HistoryVectorScope) => void;
  onVectorClose?: () => void;
  onVectorProvidersChange?: (providers: VectorProvider[]) => void;
  onVectorActorsChange?: (actors: VectorActor[]) => void;
  onVectorViewChange?: (view: VectorView) => void;
  onVectorBreadthChange?: (breadth: VectorBreadth) => void;
};

const nf = new Intl.NumberFormat("en-GB");
const dateLong = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const dateShort = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const dateCompact = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
});
const timeCompact = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const eventDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const PERIOD_LABEL: Record<HistoryPeriod, string> = {
  day: "day",
  week: "week",
  month: "month",
};
const UNKNOWN_PROVENANCE_FOLDER = "[unknown provenance]";

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function todayBangkok() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function prettyDate(value: string, formatter = dateShort) {
  const date = dateFromKey(value);
  return Number.isNaN(date.valueOf()) ? value : formatter.format(date);
}

function prettyCompactTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : timeCompact.format(date);
}

function prettyEventDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : eventDateTime.format(date);
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${nf.format(count)} ${count === 1 ? singular : plural}`;
}

function compactFolderLabel(value: string) {
  if (!value) return "unknown folder";
  if (value === UNKNOWN_PROVENANCE_FOLDER) return "Unknown provenance";
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 3) return value;
  const tail = parts.at(-2) === "projects" ? parts.slice(-1) : parts.slice(-2);
  return `…/${tail.join("/")}`;
}

function sourceLabel(value: string) {
  if (value === "claude") return "Claude Code";
  if (value === "codex") return "Codex";
  if (value === "fixture") return "Fixture";
  return value || "unknown";
}

function folderLabel(path: string) {
  if (path === UNKNOWN_PROVENANCE_FOLDER) return "Unknown provenance";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path || "unknown folder";
}

function sessionKey(day: string, session: HistorySession) {
  return JSON.stringify([day, session.source, session.project, session.folder, session.session_id]);
}

function vectorScopeKey(scope: HistoryVectorScope) {
  return JSON.stringify([scope.date, scope.source, scope.project, scope.folder, scope.session_id]);
}

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

export function buildHistoryVectorQuery(
  scope: HistoryVectorScope,
  provider: VectorProvider,
  actors: readonly VectorActor[] = VECTOR_ACTORS,
  breadth: VectorBreadth = "session",
) {
  // The stored scope always names the session the map was opened from; breadth decides how
  // much of it to keep. Widening clears axes, because the server reads an empty axis as
  // "every value".
  const widened = widenVectorScope(scope, breadth);
  const query = new URLSearchParams({
    deployment: provider,
    date: widened.date,
    source: widened.source,
    project: widened.project,
    folder: widened.folder,
    session_id: widened.session_id,
    limit: String(VECTOR_BREADTH_LIMIT[breadth]),
  });
  for (const actor of actors) query.append("actor", actor);
  return query;
}

function canonicalSelection<T extends string>(
  selected: readonly T[] | undefined,
  options: readonly T[],
  fallback: readonly T[],
) {
  const selectedSet = new Set(selected);
  const normalized = options.filter((option) => selectedSet.has(option));
  return normalized.length ? normalized : [...fallback];
}

function providerStates(providers: readonly VectorProvider[], loading: boolean) {
  return Object.fromEntries(providers.map((provider) => [provider, {
    loading,
    error: "",
    response: null,
  }])) as Partial<Record<VectorProvider, VectorProviderState>>;
}

function readVectorMapFromLocation(): Pick<VectorMapState, "scope" | "providers" | "actors" | "view"> & { breadth: VectorBreadth } | null {
  const location = readWorkspaceLocation(window.location);
  if (location.vectorOperation !== "vectors" || !location.vectorSession) return null;
  return {
    providers: location.vectorProviders ?? ["dual-4090"],
    actors: location.vectorActors ?? [...VECTOR_ACTORS],
    view: location.vectorView ?? "3d",
    breadth: location.vectorBreadth ?? "session",
    scope: {
      date: location.vectorDate ?? "",
      source: location.vectorSource ?? "",
      project: location.vectorProject ?? "",
      folder: location.vectorFolder ?? "",
      session_id: location.vectorSession,
    },
  };
}

function writeVectorMapLocation(
  state: Pick<VectorMapState, "scope" | "providers" | "actors" | "view" | "breadth"> | null,
) {
  const url = new URL(window.location.href);
  for (const key of ["operate", "vector_provider", "vector_actor", "vector_view", "vector_breadth", "vector_date", "vector_source", "vector_project", "vector_folder", "vector_session"]) {
    url.searchParams.delete(key);
  }
  if (state) {
    url.searchParams.set("operate", "vectors");
    for (const provider of state.providers) url.searchParams.append("vector_provider", provider);
    for (const actor of state.actors) url.searchParams.append("vector_actor", actor);
    url.searchParams.set("vector_view", state.view);
    url.searchParams.set("vector_breadth", state.breadth);
    url.searchParams.set("vector_date", state.scope.date);
    url.searchParams.set("vector_source", state.scope.source);
    url.searchParams.set("vector_project", state.scope.project);
    url.searchParams.set("vector_folder", state.scope.folder);
    url.searchParams.set("vector_session", state.scope.session_id);
  }
  window.history.replaceState(window.history.state, "", url);
}

export function vectorActorForRole(role: string): VectorActor | null {
  if (role === "human_intent") return "human";
  return ["assistant_answer", "summary", "tool_action", "tool_evidence"].includes(role)
    ? "agent"
    : null;
}

export function nextEvidenceIndex(
  key: string,
  current: number,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(current + 1, length - 1);
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(current - 1, 0);
  return null;
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reducedMotion;
}

function initialVisualizationConfigs(): Record<VectorView, VectorVisualizationConfig> {
  return Object.fromEntries(
    VECTOR_VISUALIZATIONS.map((plugin) => [plugin.id, { ...plugin.defaultConfig }]),
  ) as Record<VectorView, VectorVisualizationConfig>;
}

class VisualizationErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  onError: (message: string) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error.message || "Visualization plugin failed to render.");
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed
      ? <div className="vector-state" role="status"><strong>Switching to a safe visualization…</strong></div>
      : this.props.children;
  }
}

export function mergeVectorEvidence<T extends Pick<VectorPoint, "event_id" | "timestamp">>(
  providers: readonly VectorProvider[],
  pointsByProvider: Partial<Record<VectorProvider, readonly T[]>>,
) {
  const unique = new Map<string, T>();
  for (const provider of providers) {
    for (const point of pointsByProvider[provider] ?? []) {
      if (!unique.has(point.event_id)) unique.set(point.event_id, point);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) || left.event_id.localeCompare(right.event_id)
  );
}

export function HistoryWorkspace({
  period,
  date,
  source,
  project,
  folder,
  sources,
  projectFacets,
  folderFacets,
  projectShortcut,
  projectRef,
  onPeriodChange,
  onDateChange,
  onSourceChange,
  onProjectChange,
  onFolderChange,
  vectorOperation,
  vectorProviders,
  vectorActors,
  vectorView,
  vectorBreadth,
  vectorDate = "",
  vectorSource = "",
  vectorProject = "",
  vectorFolder = "",
  vectorSession = "",
  onVectorOpen,
  onVectorClose,
  onVectorProvidersChange,
  onVectorActorsChange,
  onVectorViewChange,
  onVectorBreadthChange,
}: Props) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const [copied, setCopied] = useState("");
  const [groupOrder, setGroupOrder] = useState<HistoryGroupOrder>("latest");
  const [vectorRefreshCycle, setVectorRefreshCycle] = useState(0);
  const [vectorMap, setVectorMap] = useState<VectorMapState | null>(() => {
    if (vectorOperation !== undefined) return null;
    const saved = readVectorMapFromLocation();
    return saved ? { ...saved, maps: providerStates(saved.providers, true), selectedEventId: "" } : null;
  });
  const vectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const vectorWasOpenRef = useRef(Boolean(vectorMap));
  const vectorRequestRef = useRef(0);
  const sessionRequestsRef = useRef<ReturnType<typeof createLatestRequestRunner> | null>(null);
  if (sessionRequestsRef.current === null) sessionRequestsRef.current = createLatestRequestRunner();
  const sessionRequests = sessionRequestsRef.current;
  const requestedProviders = canonicalSelection(vectorProviders, VECTOR_PROVIDERS, ["dual-4090"]);
  const requestedActors = canonicalSelection(vectorActors, VECTOR_ACTORS, VECTOR_ACTORS);
  const requestedView = vectorView ?? "3d";
  const requestedBreadth = vectorBreadth ?? "session";
  const requestedProvidersKey = requestedProviders.join(",");
  const requestedActorsKey = requestedActors.join(",");

  useEffect(() => {
    if (vectorOperation === undefined) return;
    if (vectorOperation !== "vectors" || !vectorSession) {
      setVectorMap(null);
      return;
    }
    setVectorMap((current) => {
      const scope = {
        date: vectorDate,
        source: vectorSource,
        project: vectorProject,
        folder: vectorFolder,
        session_id: vectorSession,
      };
      const sameScope = current && vectorScopeKey(scope) === vectorScopeKey(current.scope);
      const sameProviders = current?.providers.join(",") === requestedProvidersKey;
      const sameActors = current?.actors.join(",") === requestedActorsKey;
      // Breadth changes which events the server returns, so it invalidates cached maps
      // exactly like a scope change does.
      const sameBreadth = current?.breadth === requestedBreadth;
      if (sameScope && sameProviders && sameActors && sameBreadth && current.view === requestedView) {
        return current;
      }
      const reusable = sameScope && sameProviders && sameActors && sameBreadth;
      return {
        scope,
        breadth: requestedBreadth,
        providers: requestedProviders,
        actors: requestedActors,
        view: requestedView,
        maps: reusable ? current.maps : providerStates(requestedProviders, true),
        selectedEventId: sameScope && sameActors && sameBreadth ? current.selectedEventId : "",
      };
    });
  }, [requestedActorsKey, requestedProvidersKey, requestedView, vectorDate, vectorFolder, vectorOperation, vectorProject, vectorSession, vectorSource]);

  useEffect(() => {
    if (vectorMap) {
      vectorWasOpenRef.current = true;
      return;
    }
    if (!vectorWasOpenRef.current) return;
    vectorWasOpenRef.current = false;
    window.requestAnimationFrame(() => vectorTriggerRef.current?.focus());
  }, [vectorMap]);

  useEffect(() => {
    if (!vectorMap) return;
    const requestId = ++vectorRequestRef.current;
    const controllers = vectorMap.providers.map(() => new AbortController());
    const providers = vectorMap.providers;
    const actors = vectorMap.actors;
    setVectorMap((current) => current ? {
      ...current,
      maps: {
        ...current.maps,
        ...providerStates(providers, true),
      },
    } : current);
    providers.forEach((provider, index) => {
      const query = buildHistoryVectorQuery(vectorMap.scope, provider, actors, vectorMap.breadth);
      void json<VectorMapResponse>(`/api/vectors/visualize?${query}`, controllers[index]!.signal)
        .then((response) => setVectorMap((current) => {
          if (!current || vectorRequestRef.current !== requestId || !current.providers.includes(provider)) return current;
          return {
            ...current,
            maps: {
              ...current.maps,
              [provider]: { loading: false, error: "", response },
            },
          };
        }))
        .catch((reason) => {
          if (!(reason instanceof DOMException && reason.name === "AbortError")) {
            setVectorMap((current) => {
              if (!current || vectorRequestRef.current !== requestId || !current.providers.includes(provider)) return current;
              return {
                ...current,
                maps: {
                  ...current.maps,
                  [provider]: {
                    loading: false,
                    error: reason instanceof Error ? reason.message : String(reason),
                    response: null,
                  },
                },
              };
            });
          }
        });
    });
    return () => controllers.forEach((controller) => controller.abort());
  }, [vectorMap?.actors.join(","), vectorMap?.providers.join(","), vectorMap?.scope.date, vectorMap?.scope.folder, vectorMap?.scope.project, vectorMap?.scope.session_id, vectorMap?.scope.source, vectorRefreshCycle]);

  const openVectorMap = (day: string, session: HistorySession, trigger: HTMLButtonElement) => {
    const scope = {
      date: day,
      source: session.source,
      project: session.project,
      folder: session.folder,
      session_id: session.session_id,
    };
    const providers = requestedProviders;
    const actors = requestedActors;
    const view = requestedView;
    vectorTriggerRef.current = trigger;
    const breadth = requestedBreadth;
    if (!onVectorOpen) writeVectorMapLocation({ scope, providers, actors, view, breadth });
    setVectorMap({
      scope,
      breadth,
      providers,
      actors,
      view,
      maps: providerStates(providers, true),
      selectedEventId: "",
    });
    onVectorOpen?.(scope);
  };

  const closeVectorMap = () => {
    if (!onVectorClose) writeVectorMapLocation(null);
    setVectorMap(null);
    onVectorClose?.();
  };

  const changeVectorProviders = (providers: VectorProvider[]) => {
    const nextProviders = canonicalSelection(providers, VECTOR_PROVIDERS, ["dual-4090"]);
    setVectorMap((current) => {
      if (!current) return current;
      const next = { ...current, providers: nextProviders, maps: providerStates(nextProviders, true) };
      if (!onVectorProvidersChange) writeVectorMapLocation(next);
      return next;
    });
    onVectorProvidersChange?.(nextProviders);
  };

  const changeVectorActors = (actors: VectorActor[]) => {
    const nextActors = canonicalSelection(actors, VECTOR_ACTORS, VECTOR_ACTORS);
    setVectorMap((current) => {
      if (!current) return current;
      const next = {
        ...current,
        actors: nextActors,
        maps: providerStates(current.providers, true),
        selectedEventId: "",
      };
      if (!onVectorActorsChange) writeVectorMapLocation(next);
      return next;
    });
    onVectorActorsChange?.(nextActors);
  };

  const changeVectorView = (view: VectorView) => {
    setVectorMap((current) => {
      if (!current) return current;
      const next = { ...current, view };
      if (!onVectorViewChange) writeVectorMapLocation(next);
      return next;
    });
    onVectorViewChange?.(view);
  };

  const changeVectorBreadth = (breadth: VectorBreadth) => {
    setVectorMap((current) => {
      if (!current) return current;
      const next = { ...current, breadth };
      if (!onVectorBreadthChange) writeVectorMapLocation(next);
      return next;
    });
    onVectorBreadthChange?.(breadth);
  };

  const clearSessionDetails = useCallback(() => {
    sessionRequests.invalidate();
    setExpandedSessions(new Set());
    setSessionStates({});
  }, [sessionRequests]);

  const loadHistory = useCallback(() => {
    clearSessionDetails();
    setRefreshCycle((current) => current + 1);
  }, [clearSessionDetails]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ period });
    if (date) query.set("date", date);
    if (source) query.set("source", source);
    if (project) query.set("project", project);
    if (folder) query.set("folder", folder);

    clearSessionDetails();
    setBusy(true);
    setError("");
    void json<HistoryResponse>(`/api/history?${query}`, controller.signal)
      .then((next) => {
        clearSessionDetails();
        setHistory(next);
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      sessionRequests.invalidate();
    };
  }, [clearSessionDetails, date, folder, period, project, refreshCycle, sessionRequests, source]);

  const fetchSession = useCallback(async (
    day: string,
    session: HistorySession,
    append = false,
  ) => {
    const key = sessionKey(day, session);
    const previous = sessionStates[key];
    const offset = append ? previous?.nextOffset ?? 0 : 0;
    setSessionStates((current) => ({
      ...current,
      [key]: {
        loading: true,
        error: "",
        total: append ? current[key]?.total ?? 0 : 0,
        selectedDayEvents: append ? current[key]?.selectedDayEvents ?? 0 : 0,
        nextOffset: append ? current[key]?.nextOffset ?? 0 : 0,
        events: append ? current[key]?.events ?? [] : [],
      },
    }));
    const query = new URLSearchParams({
      date: day,
      source: session.source,
      project: session.project,
      folder: session.folder,
      session_id: session.session_id,
      offset: String(offset),
      limit: "200",
    });
    await sessionRequests.run(
      key,
      (signal) => json<SessionResponse>(`/api/history/session?${query}`, signal),
      (next) => {
        setSessionStates((current) => ({
          ...current,
          [key]: {
            loading: false,
            error: "",
            total: next.total,
            selectedDayEvents: next.selected_day_events,
            nextOffset: next.next_offset,
            events: append ? [...(current[key]?.events ?? []), ...next.events] : next.events,
          },
        }));
      },
      (reason) => {
        setSessionStates((current) => ({
          ...current,
          [key]: {
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            total: current[key]?.total ?? 0,
            selectedDayEvents: current[key]?.selectedDayEvents ?? 0,
            nextOffset: current[key]?.nextOffset ?? null,
            events: current[key]?.events ?? [],
          },
        }));
      },
    );
  }, [sessionRequests, sessionStates]);

  const toggleSession = (day: string, session: HistorySession) => {
    const key = sessionKey(day, session);
    const opening = !expandedSessions.has(key);
    setExpandedSessions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening && !sessionStates[key]) void fetchSession(day, session);
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1_500);
    } catch {
      setCopied("");
    }
  };

  const currentDate = date || history?.date || todayBangkok();
  const today = todayBangkok();
  const nextDisabled = !history || history.end >= today;
  const rangeLabel = useMemo(() => {
    if (!history) return prettyDate(currentDate);
    if (history.start === history.end) return prettyDate(history.start);
    return `${prettyDate(history.start)} – ${prettyDate(history.end)}`;
  }, [currentDate, history]);
  const visibleDays = useMemo<HistoryDisplayDay[]>(() => {
    const days = history?.days ?? [];
    // `sources` is the whole database catalogue from /api/status. Do not
    // renumber a source from the current history filter or date window.
    const sourceNumbers = historySourceNumbers([
      ...sources,
      ...days.flatMap((day) => day.groups.map((group) => group.source)),
    ]);
    return [...days].reverse().map((day) => ({
      ...day,
      records: sortHistoryRecords(
        day.groups.flatMap((group) => group.sessions.map((session) => ({
          group,
          session,
          sourceNumber: sourceNumbers.get(group.source) ?? "00",
        }))),
        groupOrder,
      ),
    }));
  }, [groupOrder, history, sources]);

  return (
    <section className="history-pane" aria-labelledby="history-heading" aria-busy={busy}>
      <header className="history-toolbar">
        <div className="history-title">
          <h1 id="history-heading">Work history</h1>
          <p>{history ? `${rangeLabel} · ${history.time_zone} (GMT+7) · ${nf.format(history.totals.sessions)} sessions` : "Daily evidence from imported conversation events"}</p>
        </div>
        <div className="history-period" role="group" aria-label="History period">
          {(["day", "week", "month"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => onPeriodChange(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <div className="history-date-nav" aria-label="History date navigation">
          <button
            className="button-quiet"
            type="button"
            aria-label={`Previous ${PERIOD_LABEL[period]}`}
            onClick={() => onDateChange(shiftHistoryDate(currentDate, period, -1))}
          >
            Previous
          </button>
          <label className="field-label history-date-input">
            <span>Date</span>
            <input
              type="date"
              max={today}
              value={currentDate}
              onChange={(event) => onDateChange(event.target.value)}
            />
          </label>
          <button
            className="button-quiet"
            type="button"
            aria-label={`Next ${PERIOD_LABEL[period]}`}
            disabled={nextDisabled}
            onClick={() => onDateChange(nextHistoryDate(currentDate, period, today))}
          >
            Next
          </button>
          <button className="button-secondary" type="button" onClick={() => onDateChange("")}>
            Today
          </button>
        </div>
        <div className="history-filters" aria-label="History filters">
          <label className="field-label">
            <span>Who / Source</span>
            <select
              value={source}
              onChange={(event) => {
                onSourceChange(event.target.value);
                onProjectChange("");
                onFolderChange("");
              }}
            >
              <option value="">all sources</option>
              {sources.map((value) => <option key={value} value={value}>{sourceLabel(value)}</option>)}
            </select>
          </label>
          <ProjectCombobox
            ref={projectRef}
            facets={projectFacets}
            value={project}
            onChange={onProjectChange}
            shortcut={projectShortcut}
          />
          <label className="field-label">
            <span>Directory / JSONL folder</span>
            <select value={folder} onChange={(event) => onFolderChange(event.target.value)}>
              <option value="">all folders</option>
              {folderFacets.map((facet) => (
                <option key={facet.value} value={facet.value} title={facet.value}>
                  {folderLabel(facet.value)} · {nf.format(facet.count)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label history-sort-control">
            <span>Order</span>
            <select value={groupOrder} onChange={(event) => setGroupOrder(event.target.value as HistoryGroupOrder)}>
              <option value="latest">Latest activity</option>
              <option value="earliest">Earliest activity</option>
              <option value="project">Oracle A–Z</option>
              <option value="events">Most events</option>
              <option value="sessions">Most sessions</option>
            </select>
          </label>
          <button className="button-secondary refresh-button" type="button" disabled={busy} onClick={loadHistory}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {!busy && history ? `Loaded ${history.totals.days} days with ${history.totals.sessions} sessions.` : ""}
      </span>
      {busy && !history && <div className="loading-rule" aria-hidden="true" />}
      {error && (
        <div className="app-alert history-alert" role="alert">
          <span><strong>History unavailable.</strong> {error}</span>
          <button className="button-quiet" type="button" onClick={loadHistory}>Retry</button>
        </div>
      )}

      {history && (
        <>
          <dl className="history-summary" aria-label="History range totals">
            <div><dt>Active days</dt><dd>{nf.format(history.totals.active_days)} / {nf.format(history.totals.days)}</dd></div>
            <div><dt>Distinct sessions</dt><dd title="Unique source and session IDs in this range">{nf.format(history.totals.sessions)}</dd></div>
            <div><dt>Who / sources</dt><dd>{nf.format(history.totals.sources)}</dd></div>
            <div><dt>Oracles / projects</dt><dd>{nf.format(history.totals.projects)}</dd></div>
            <div><dt>Directories</dt><dd>{nf.format(history.totals.folders)}</dd></div>
            <div><dt>Canonical events (unique)</dt><dd>{nf.format(history.totals.events)}</dd></div>
          </dl>
          <p className="history-count-note">
            Canonical totals are unique. Directory counts are overlapping provenance views and must not be added together.
          </p>

          <div className="history-ledger" data-testid="history-ledger">
            {visibleDays.map((day) => {
              const sourceCount = new Set(day.groups.map((group) => group.source)).size;
              const projectCount = new Set(day.groups.map((group) => group.project)).size;
              const folderCount = new Set(day.groups.map((group) => group.folder)).size;
              return (
                <section
                  className={`history-day ${day.event_count ? "is-active" : "is-empty"} ${day.date === today ? "is-today" : ""}`}
                  aria-labelledby={`history-day-${day.date}`}
                  key={day.date}
                >
                  <header>
                    <h2 id={`history-day-${day.date}`}>
                      <time dateTime={day.date}>{prettyDate(day.date, dateLong)}</time>
                      {day.date === today && <span>Today</span>}
                    </h2>
                    <p>
                      {day.event_count
                        ? [
                            countLabel(day.event_count, "canonical event"),
                            countLabel(day.session_count, "session"),
                            source ? null : countLabel(sourceCount, "source"),
                            countLabel(projectCount, "oracle"),
                            countLabel(folderCount, "directory", "directories"),
                          ].filter(Boolean).join(" · ")
                        : "0 sessions"}
                    </p>
                  </header>

                  {!day.groups.length ? (
                    <div className="history-zero">— No indexed work in this scope</div>
                  ) : (
                    <>
                      <div className="history-record-columns" aria-hidden="true">
                        <span>Date / time</span>
                        <span>Src #</span>
                        <span>Oracle / folder</span>
                        <span>Session</span>
                        <span>Daily events</span>
                        <span>Evidence preview</span>
                        <span>Continuation</span>
                        <span>Open</span>
                      </div>
                      <ul className="history-records" aria-label={`Sessions for ${day.date}`}>
                        {day.records.map(({ group, session, sourceNumber }) => {
                          const skey = sessionKey(day.date, session);
                          const sessionOpen = expandedSessions.has(skey);
                          const state = sessionStates[skey];
                          const sessionPanel = `history-session-${Math.abs(hashCode(skey))}`;
                          const continuation = [
                            session.continues_before ? "from previous day" : "",
                            session.continues_after ? "into next day" : "",
                          ].filter(Boolean).join(" · ");
                          return (
                            <li key={skey}>
                              <div className="history-record-row">
                                <button
                                  className="history-record-main"
                                  type="button"
                                  aria-expanded={sessionOpen}
                                  aria-controls={sessionPanel}
                                  aria-label={`${sessionOpen ? "Hide" : "View"} whole contents. ${prettyDate(day.date, dateLong)}, ${prettyCompactTime(session.started_at)} to ${prettyCompactTime(session.ended_at)}. Source ${sourceNumber}, ${sourceLabel(group.source)}. ${group.project || "unknown project"}; ${group.folder || "unknown folder"}. Session ${session.session_id}. ${nf.format(session.event_count)} daily events. ${session.preview ? `Evidence: ${session.preview}.` : "No text preview."}${continuation ? ` Continues ${continuation}.` : ""}`}
                                  onClick={() => toggleSession(day.date, session)}
                                >
                                  <span className="history-record-time" title={`${prettyDate(day.date, dateLong)} · activity observed from ${prettyCompactTime(session.started_at)} through ${prettyCompactTime(session.ended_at)}`}>
                                    <small className="history-cell-label">Date / time</small>
                                    <time dateTime={day.date}>{prettyDate(day.date, dateCompact)}</time>
                                    <span aria-hidden="true"> · </span>
                                    <time dateTime={session.started_at}>{prettyCompactTime(session.started_at)}</time>
                                    <span aria-hidden="true">–</span>
                                    <time dateTime={session.ended_at}>{prettyCompactTime(session.ended_at)}</time>
                                  </span>
                                  <span className="history-record-source" title={sourceLabel(group.source)} aria-label={`Source ${sourceNumber}: ${sourceLabel(group.source)}`}>
                                    <small className="history-cell-label">Source number</small>
                                    <strong>{sourceNumber}</strong>
                                  </span>
                                  <span className="history-record-context" title={`${group.project || "unknown project"} · ${group.folder || "unknown folder"}`}>
                                    <small className="history-cell-label">Oracle / JSONL folder</small>
                                    <strong>{group.project || "?"}</strong>
                                    <span aria-hidden="true"> · </span>
                                    <span className="history-record-folder">{compactFolderLabel(group.folder)}</span>
                                  </span>
                                  <span className="history-record-id" title={session.session_id}>
                                    <small className="history-cell-label">Session</small>
                                    {session.session_id}
                                  </span>
                                  <strong className="history-record-count" title="Canonical events observed in this directory on the selected day">
                                    <small className="history-cell-label">Daily events</small>
                                    {nf.format(session.event_count)} events
                                  </strong>
                                  <span className="history-record-preview" title={session.preview || "No text preview"}>
                                    <small className="history-cell-label">Evidence preview</small>
                                    {session.preview || "No text preview"}
                                  </span>
                                  <small className="history-record-continuation" title={continuation || undefined} aria-hidden={!continuation}>
                                    {continuation}
                                  </small>
                                  <span className="history-record-action">
                                    {sessionOpen ? "Hide contents" : "View contents"} <i aria-hidden="true">{sessionOpen ? "▾" : "›"}</i>
                                  </span>
                                </button>
                                <button
                                  className="history-vector-action"
                                  type="button"
                                  aria-controls="history-vector-inspector"
                                  aria-haspopup="dialog"
                                  aria-label={`Open vector map for ${group.project || "unknown project"}, session ${session.session_id}`}
                                  onClick={(event) => openVectorMap(day.date, session, event.currentTarget)}
                                >
                                  Vector map
                                </button>
                                <button
                                  className="history-copy"
                                  type="button"
                                  aria-label={`Copy session ID ${session.session_id}`}
                                  onClick={() => void copy(session.session_id, `${skey}:session`)}
                                >
                                  {copied === `${skey}:session` ? "Copied" : "Copy ID"}
                                </button>
                              </div>
                              {sessionOpen && (
                                <div className="history-session-events" id={sessionPanel}>
                                  <div className="history-session-scope">
                                    <strong>Whole session</strong>
                                    <span>
                                      {state?.loading && !state.events.length
                                        ? "Loading canonical contents…"
                                        : `${nf.format(state?.total ?? 0)} events in this directory · ${nf.format(state?.selectedDayEvents ?? session.event_count)} on ${prettyDate(day.date)}`}
                                    </span>
                                  </div>
                                  {state?.error && (
                                    <div className="event-error" role="alert">
                                      <strong>Session unavailable.</strong> {state.error}
                                      <button className="button-quiet" type="button" onClick={() => void fetchSession(day.date, session)}>Retry</button>
                                    </div>
                                  )}
                                  {state?.events.map((event) => (
                                    <article className={`history-event role-${event.semantic_role}`} key={event.id}>
                                      <time dateTime={event.timestamp}>{prettyEventDateTime(event.timestamp)}</time>
                                      <div>
                                        <strong>{event.block_type || "unknown"}</strong>
                                        <span>{event.semantic_role || "unknown"}{event.tool_name ? ` · ${event.tool_name}` : ""}</span>
                                      </div>
                                      {event.text.length > 280 ? (
                                        <details>
                                          <summary>{event.text.slice(0, 280)}… <small>expand full block</small></summary>
                                          <pre>{event.text}</pre>
                                        </details>
                                      ) : <p>{event.text || "—"}</p>}
                                    </article>
                                  ))}
                                  {state?.loading && <div className="loading-rule" aria-hidden="true" />}
                                  {state && state.nextOffset !== null && !state.loading && (
                                    <button className="history-load-more button-quiet" type="button" onClick={() => void fetchSession(day.date, session, true)}>
                                      Load more · {nf.format(state.events.length)} of {nf.format(state.total)} events
                                    </button>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
      {vectorMap && (
        <VectorInspector
          state={vectorMap}
          onClose={closeVectorMap}
          onProvidersChange={changeVectorProviders}
          onActorsChange={changeVectorActors}
          onViewChange={changeVectorView}
          onBreadthChange={changeVectorBreadth}
          onRetry={() => setVectorRefreshCycle((cycle) => cycle + 1)}
          onSelect={(selectedEventId) => setVectorMap((current) => current ? { ...current, selectedEventId } : current)}
        />
      )}
    </section>
  );
}

const VECTOR_PROVIDER_LABEL: Record<VectorProvider, { title: string; detail: string }> = {
  "dual-4090": { title: "Dual 4090", detail: "local" },
  cloudflare: { title: "Cloudflare", detail: "managed" },
};

const VECTOR_ACTOR_LABEL: Record<VectorActor, { title: string; detail: string }> = {
  human: { title: "Human", detail: "intent" },
  agent: { title: "Agent", detail: "answers + summaries" },
};

function VectorInspector({
  state,
  onClose,
  onProvidersChange,
  onActorsChange,
  onViewChange,
  onBreadthChange,
  onRetry,
  onSelect,
}: {
  state: VectorMapState;
  onClose: () => void;
  onProvidersChange: (providers: VectorProvider[]) => void;
  onActorsChange: (actors: VectorActor[]) => void;
  onViewChange: (view: VectorView) => void;
  onBreadthChange: (breadth: VectorBreadth) => void;
  onRetry: () => void;
  onSelect: (eventId: string) => void;
}) {
  const [isMobileDialog, setIsMobileDialog] = useState(() => window.matchMedia("(max-width: 600px)").matches);
  const [visualizationConfigs, setVisualizationConfigs] = useState(initialVisualizationConfigs);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const evidenceRefs = useRef(new Map<string, HTMLLIElement>());
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !isMobileDialog || !inspectorRef.current) return;
      const focusable = [...inspectorRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        inspectorRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === inspectorRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKey);
    return () => window.removeEventListener("keydown", handleDialogKey);
  }, [isMobileDialog, onClose]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px)");
    const update = () => setIsMobileDialog(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!isMobileDialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileDialog]);
  const points = useMemo(() => {
    const pointsByProvider = Object.fromEntries(state.providers.map((provider) => [
      provider,
      state.maps[provider]?.response?.points ?? [],
    ])) as Partial<Record<VectorProvider, readonly VectorPoint[]>>;
    return mergeVectorEvidence(state.providers, pointsByProvider);
  }, [state.maps, state.providers]);
  const allProvidersSettled = state.providers.every((provider) =>
    state.maps[provider] !== undefined && !state.maps[provider]?.loading
  );
  const selected = points.find((point) => point.event_id === state.selectedEventId) ?? null;
  const actorCounts = useMemo(() => {
    const counts: Record<VectorActor, number> = { human: 0, agent: 0 };
    for (const point of points) {
      const actor = vectorActorForRole(point.semantic_role);
      if (actor) counts[actor] += 1;
    }
    return counts;
  }, [points]);
  const activePlugin: VectorVisualizationPlugin = getVectorVisualization(state.view);
  const activeConfig = visualizationConfigs[state.view];
  useEffect(() => {
    if (!allProvidersSettled) return;
    const nextSelected = selected?.event_id ?? points[0]?.event_id ?? "";
    if (nextSelected !== state.selectedEventId) onSelect(nextSelected);
  }, [allProvidersSettled, onSelect, points, selected?.event_id, state.selectedEventId]);
  const toggleProvider = (provider: VectorProvider) => {
    const checked = state.providers.includes(provider);
    if (checked && state.providers.length === 1) return;
    onProvidersChange(checked
      ? state.providers.filter((value) => value !== provider)
      : VECTOR_PROVIDERS.filter((value) => state.providers.includes(value) || value === provider));
  };
  const toggleActor = (actor: VectorActor) => {
    const checked = state.actors.includes(actor);
    if (checked && state.actors.length === 1) return;
    onActorsChange(checked
      ? state.actors.filter((value) => value !== actor)
      : VECTOR_ACTORS.filter((value) => state.actors.includes(value) || value === actor));
  };
  const changeVisualizationConfig = (key: string, value: boolean | number | string) => {
    setVisualizationConfigs((current) => ({
      ...current,
      [state.view]: { ...current[state.view], [key]: value },
    }));
  };
  const selectEvidenceFromKey = (event: React.KeyboardEvent<HTMLLIElement>, index: number) => {
    const nextIndex = nextEvidenceIndex(event.key, index, points.length);
    if (nextIndex !== null) {
      event.preventDefault();
      const point = points[nextIndex];
      if (!point) return;
      onSelect(point.event_id);
      evidenceRefs.current.get(point.event_id)?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const point = points[index];
      if (point) onSelect(point.event_id);
    }
  };
  const compare = state.providers.length > 1;
  const shortSession = state.scope.session_id.slice(0, 8);
  return (
    <aside ref={inspectorRef} id="history-vector-inspector" className={`vector-inspector ${compare ? "is-compare" : ""}`} role="dialog" aria-modal={isMobileDialog} aria-labelledby="vector-inspector-title" data-testid="vector-inspector" tabIndex={-1}>
      <header className="vector-inspector-header">
        <div>
          <h2 id="vector-inspector-title">{compare ? "Compare vector maps" : `${VECTOR_BREADTH_LABEL[state.breadth].title} vector map`}</h2>
          <p>
            {/* Only name the axes this breadth actually pins. Naming a session while
                showing every session on the day would misdescribe what is on screen. */}
            <time dateTime={state.scope.date}>{prettyDate(state.scope.date)}</time> · {sourceLabel(state.scope.source)}
            {state.breadth !== "day" && <> · {state.scope.project || "Unknown project"} · {compactFolderLabel(state.scope.folder)}</>}
            {state.breadth === "session" && <> · #{shortSession}</>}
            {state.breadth !== "session" && <> · {VECTOR_BREADTH_LABEL[state.breadth].hint}</>}
          </p>
        </div>
        <button className="button-quiet" type="button" autoFocus onClick={onClose}>Close</button>
      </header>
      <div className="vector-inspector-controls">
        <fieldset className="vector-choice-group">
          <legend>Vector indexes</legend>
          <div className="vector-checks">
            {VECTOR_PROVIDERS.map((provider) => {
              const checked = state.providers.includes(provider);
              const lastSelected = checked && state.providers.length === 1;
              return (
                <label key={provider} className={lastSelected ? "is-required" : ""} title={lastSelected ? "At least one vector index must remain selected" : undefined}>
                  <input type="checkbox" checked={checked} disabled={lastSelected} onChange={() => toggleProvider(provider)} />
                  <span>{VECTOR_PROVIDER_LABEL[provider].title}<small>{VECTOR_PROVIDER_LABEL[provider].detail}</small></span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="vector-choice-group">
          <legend>Show evidence</legend>
          <div className="vector-checks">
            {VECTOR_ACTORS.map((actor) => {
              const checked = state.actors.includes(actor);
              const lastSelected = checked && state.actors.length === 1;
              return (
                <label key={actor} className={lastSelected ? "is-required" : ""} title={lastSelected ? "At least one evidence group must remain selected" : undefined}>
                  <input type="checkbox" checked={checked} disabled={lastSelected} onChange={() => toggleActor(actor)} />
                  <span>{VECTOR_ACTOR_LABEL[actor].title}{checked && <> <b>{nf.format(actorCounts[actor])}</b></>}<small>{VECTOR_ACTOR_LABEL[actor].detail}</small></span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="vector-choice-group vector-view-choice">
          <legend>Scope</legend>
          <div className="vector-view-toggle" role="group" aria-label="Vector map scope">
            {VECTOR_BREADTHS.map((breadth) => (
              <button
                key={breadth}
                type="button"
                aria-pressed={state.breadth === breadth}
                onClick={() => onBreadthChange(breadth)}
                title={`Map ${VECTOR_BREADTH_LABEL[breadth].hint}, up to ${VECTOR_BREADTH_LIMIT[breadth]} points`}
              >
                <strong>{VECTOR_BREADTH_LABEL[breadth].title}</strong>
                <small>{VECTOR_BREADTH_LABEL[breadth].hint}</small>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="vector-choice-group vector-view-choice">
          <legend>Visualizer</legend>
          <div className="vector-view-toggle" role="group" aria-label="Vector visualization plugin">
            {VECTOR_VISUALIZATIONS.map((plugin) => (
              <button key={plugin.id} type="button" aria-pressed={state.view === plugin.id} onClick={() => onViewChange(plugin.id)} title={plugin.description}>
                <strong>{plugin.label}</strong>
                <small>{plugin.dimension}D plugin</small>
              </button>
            ))}
          </div>
          {activePlugin.configControls.length > 0 && (
            <div className="vector-plugin-config" aria-label={`${activePlugin.label} settings`}>
              {activePlugin.configControls.map((control) => {
                const value = activeConfig[control.key];
                if (control.type === "toggle") {
                  return (
                    <label key={control.key} title={control.description}>
                      <input type="checkbox" checked={value === true} disabled={reducedMotion && control.key === "spin"} onChange={(event) => changeVisualizationConfig(control.key, event.target.checked)} />
                      <span>{control.label}</span>
                    </label>
                  );
                }
                if (control.type === "range") {
                  return (
                    <label key={control.key} title={control.description}>
                      <span>{control.label}</span>
                      <input type="range" min={control.min} max={control.max} step={control.step} value={typeof value === "number" ? value : control.min} onChange={(event) => changeVisualizationConfig(control.key, event.target.valueAsNumber)} />
                    </label>
                  );
                }
                return (
                  <label key={control.key} title={control.description}>
                    <span>{control.label}</span>
                    <select value={typeof value === "string" ? value : control.options[0]?.value ?? ""} onChange={(event) => changeVisualizationConfig(control.key, event.target.value)}>
                      {control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                );
              })}
              {reducedMotion && activePlugin.configControls.some(({ key }) => key === "spin") && <small>Motion is reduced by your system setting.</small>}
            </div>
          )}
        </fieldset>
      </div>
      <div className="vector-inspector-body">
        <div className="vector-maps">
          {state.providers.map((provider) => (
            <VectorProviderMap
              key={provider}
              provider={provider}
              state={state.maps[provider] ?? { loading: true, error: "", response: null }}
              view={state.view}
              config={activeConfig}
              reducedMotion={reducedMotion}
              reserveStatus={compare}
              selectedEventId={state.selectedEventId}
              onConfigChange={(config) => setVisualizationConfigs((current) => ({ ...current, [state.view]: config }))}
              onRetry={onRetry}
              onSelect={onSelect}
            />
          ))}
        </div>
        {selected && (
          <article className="vector-selected-evidence" aria-live="polite">
            <time dateTime={selected.timestamp}>{prettyEventDateTime(selected.timestamp)}</time>
            <strong>{selected.semantic_role || selected.block_type || "Evidence"}</strong>
            <p>{selected.text_preview || "No text preview"}</p>
            <span className="vector-space-badges" aria-label="Available vector indexes">
              {state.providers.filter((provider) => state.maps[provider]?.response?.points.some((point) => point.event_id === selected.event_id)).map((provider) => (
                <abbr key={provider} title={VECTOR_PROVIDER_LABEL[provider].title}>{provider === "dual-4090" ? "4090" : "CF"}</abbr>
              ))}
            </span>
          </article>
        )}
        {points.length > 0 && (
          <ol className="vector-evidence-list" role="listbox" aria-label="Vector evidence points">
            {points.map((point, index) => (
              <li
                key={point.event_id}
                ref={(node) => {
                  if (node) evidenceRefs.current.set(point.event_id, node);
                  else evidenceRefs.current.delete(point.event_id);
                }}
                role="option"
                aria-selected={point.event_id === state.selectedEventId}
                tabIndex={point.event_id === state.selectedEventId || (!state.selectedEventId && index === 0) ? 0 : -1}
                onClick={() => onSelect(point.event_id)}
                onKeyDown={(event) => selectEvidenceFromKey(event, index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{point.semantic_role || point.block_type || "evidence"}</strong>
                <small>{point.text_preview || "No text preview"}</small>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function VectorProviderMap({
  provider,
  state,
  view,
  config,
  reducedMotion,
  reserveStatus,
  selectedEventId,
  onConfigChange,
  onRetry,
  onSelect,
}: {
  provider: VectorProvider;
  state: VectorProviderState;
  view: VectorView;
  config: VectorVisualizationConfig;
  reducedMotion: boolean;
  reserveStatus: boolean;
  selectedEventId: string;
  onConfigChange: (config: VectorVisualizationConfig) => void;
  onRetry: () => void;
  onSelect: (eventId: string) => void;
}) {
  const [unavailableReason, setUnavailableReason] = useState("");
  const points = state.response?.points ?? [];
  const edges = state.response?.edges ?? [];
  const coverage = state.response?.coverage;
  const partial = Boolean(coverage && coverage.embedded > 0 && coverage.missing > 0);
  const sampled = Boolean(coverage && coverage.sampled < coverage.embedded);
  const requestedPlugin = getVectorVisualization(view);
  // Any plugin can report itself unavailable (missing WebGL, for example), not
  // just the 3D atlas, so the fallback keys off the declared dimension rather
  // than a hardcoded id.
  const effectivePlugin = unavailableReason && requestedPlugin.dimension === 3
    ? getVectorVisualization("2d")
    : requestedPlugin;
  const Visualization = VECTOR_VISUALIZATION_COMPONENTS[effectivePlugin.id];
  useEffect(() => setUnavailableReason(""), [view, state.response?.space?.id]);
  return (
    <section className={`vector-provider-map is-${provider}`} aria-labelledby={`vector-provider-${provider}`}>
      <header className="vector-provider-header">
        <div>
          <h3 id={`vector-provider-${provider}`}>{VECTOR_PROVIDER_LABEL[provider].title}</h3>
          <p>{state.response?.space
            ? `${state.response.space.model} · ${nf.format(state.response.space.dimension)}d · ${state.response.space.distance}`
            : VECTOR_PROVIDER_LABEL[provider].detail}</p>
        </div>
        {coverage && (
          <dl aria-label={`${VECTOR_PROVIDER_LABEL[provider].title} vector coverage`}>
            <div><dt>Embedded</dt><dd>{nf.format(coverage.embedded)}</dd></div>
            <div><dt>Mapped</dt><dd>{nf.format(coverage.sampled)}</dd></div>
            <div><dt>Eligible</dt><dd>{nf.format(coverage.eligible)}</dd></div>
            <div><dt>Missing</dt><dd>{nf.format(coverage.missing)}</dd></div>
          </dl>
        )}
      </header>
      {state.loading && (
        <div className="vector-state" role="status">
          <strong>Projecting {VECTOR_PROVIDER_LABEL[provider].title} vectors…</strong>
          <span>Reading the {VECTOR_PROVIDER_LABEL[provider].detail} index without crossing vector spaces.</span>
          <div className="loading-rule" aria-hidden="true" />
        </div>
      )}
      {!state.loading && state.error && (
        <div className="vector-state is-error" role="alert">
          <strong>{VECTOR_PROVIDER_LABEL[provider].title} map unavailable.</strong>
          <span>{state.error}</span>
          <button className="button-quiet" type="button" onClick={onRetry}>Retry maps</button>
        </div>
      )}
      {!state.loading && !state.error && state.response && !state.response.available && (
        <div className="vector-state" role="status">
          <strong>This vector index is not available.</strong>
          <span>{state.response.error || `No ${provider} store is connected. Choose another index.`}</span>
        </div>
      )}
      {!state.loading && !state.error && state.response?.available && !points.length && (
        <div className="vector-state" role="status">
          <strong>No vectors for the selected evidence.</strong>
          <span>{coverage?.missing
            ? `${nf.format(coverage.missing)} eligible events still need embedding.`
            : `No ${state.response.scope.actors.join(" or ")} evidence is eligible in this session scope.`}</span>
        </div>
      )}
      {!state.loading && !state.error && state.response?.available && points.length > 0 && (
        <>
          {(partial || sampled || reserveStatus) && (
            <p className={`vector-partial ${partial || sampled ? "" : "is-empty"}`} role={partial || sampled ? "status" : undefined} aria-hidden={partial || sampled ? undefined : true}>
              {sampled && `Showing a deterministic spread of ${nf.format(coverage!.sampled)} of ${nf.format(coverage!.embedded)} embedded events.`}
              {sampled && partial && " "}
              {partial && `${nf.format(coverage!.missing)} of ${nf.format(coverage!.eligible)} eligible events still need embedding.`}
              {!partial && !sampled && "Coverage is complete."}
            </p>
          )}
          {unavailableReason && effectivePlugin.id === "2d" && requestedPlugin.id !== effectivePlugin.id && (
            <p className="vector-fallback" role="status">
              <strong>Atlas 3D unavailable.</strong> {unavailableReason.slice(0, 240)} Showing Flat 2D in this index only.
            </p>
          )}
          <div className={`vector-map-frame is-${effectivePlugin.id}`}>
            <VisualizationErrorBoundary
              resetKey={`${provider}:${effectivePlugin.id}:${points.length}`}
              onError={setUnavailableReason}
            >
              <Suspense fallback={<div className="vector-state" role="status"><strong>Loading {effectivePlugin.label}…</strong></div>}>
                <Visualization
                  className={effectivePlugin.dimension === 3 ? "vector-map-3d" : "vector-map-2d"}
                  points={points}
                  edges={edges}
                  selectedEventId={selectedEventId}
                  onSelect={onSelect}
                  config={effectivePlugin.id === view ? config : effectivePlugin.defaultConfig}
                  onConfigChange={onConfigChange}
                  reducedMotion={reducedMotion}
                  onUnavailable={setUnavailableReason}
                  ariaLabel={`${VECTOR_PROVIDER_LABEL[provider].title} ${effectivePlugin.label} vector projection with ${nf.format(points.length)} evidence points. Use the evidence list for keyboard navigation.`}
                />
              </Suspense>
            </VisualizationErrorBoundary>
            <p>{state.response.projection.method} · {state.response.space?.dimension ?? "?"}D → {effectivePlugin.label} · spaces never blur</p>
          </div>
        </>
      )}
    </section>
  );
}

function hashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}
