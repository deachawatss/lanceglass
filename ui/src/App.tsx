import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HistoryWorkspace, type HistoryVectorScope } from "./HistoryWorkspace";
import { ProjectCombobox } from "./ProjectCombobox";
import {
  appOwnedHistoryVectorState,
  historyVectorCloseAction,
  readWorkspaceLocation,
  workspaceHref,
  type HistoryPeriod,
  type VectorActor,
  type VectorProvider,
  type VectorView,
  type WorkspaceLocation,
  type WorkspaceName,
} from "./location";
import type { VectorBreadth } from "./vector-scope";

type Counts = { events: number; event_sources: number; source_files: number };
type Status = {
  demo?: {
    enabled: boolean;
    label: string;
    storage: string;
    persistence: string;
  };
  db_dir: string;
  fixture_root: string;
  source_presets: {
    id: string;
    label: string;
    root: string;
    default?: boolean;
  }[];
  tables: Counts;
  sources: Record<string, Counts>;
};
type FileState = "new" | "changed" | "unchanged" | "shrunk";
type FilePlan = {
  id: string;
  source: string;
  path: string;
  size: number;
  mtimeMs: number;
  state: FileState;
};
type Plan = {
  plan_revision: string;
  source: string;
  root: string;
  found: number;
  new: number;
  changed: number;
  unchanged: number;
  shrunk: number;
  will_parse: number;
  files: FilePlan[];
};
type Report = Omit<Plan, "files"> & {
  selected_files: number;
  remaining_files: number;
  partial: boolean;
  parsed_records: number;
  blocks: number;
  inserted: number;
  duplicates: number;
  occurrences_inserted: number;
  corrupt: number;
};
type Intake = {
  source: string;
  root: string;
  checked_at: string;
  found: number;
  new: number;
  changed: number;
  indexed: number;
  reconcile: number;
  actionable: number;
};
type EventRow = {
  id: string;
  timestamp: string;
  project: string;
  block_type: string;
  semantic_role: string;
  source: string;
  text: string;
  file_path?: string;
  folder?: string;
};
type CountFacet = { value: string; count: number };
type FolderFacet = CountFacet & { label: string };
type EventFacets = {
  projects: CountFacet[];
  folders: FolderFacet[];
};
type Events = {
  events: EventRow[];
  source: string;
  project: string;
  folder: string;
  limit: number;
  total: number;
  facets?: EventFacets;
};
type LiveEvents = Omit<Events, "facets">;
type Busy = "boot" | "plan" | "import" | "refresh" | null;
type PlanStateFilter = "all" | "actionable" | FileState;
type PlanInspectionMode = "quick" | "full";
type Filter = "all" | "actionable" | FileState;
type Theme = "dark" | "paper";
type WorkspaceView = WorkspaceName;
type HistoryVectorLocation = {
  operation: "vectors" | "";
  providers: VectorProvider[];
  actors: VectorActor[];
  view: VectorView;
  breadth: VectorBreadth;
  date: string;
  source: string;
  project: string;
  folder: string;
  session: string;
};
type Job = {
  id: string;
  name: string;
  mode: "batch" | "all";
  root: string;
  source: string;
  max_files?: number;
  running: boolean;
  state: string;
  code: number | null;
  started: string;
  ended: string | null;
  elapsed_ms: number;
  last: string;
  error?: string;
  result?: Report;
};
type LastAttempt = {
  id: string;
  state: string;
  started: string;
  error?: string;
  result?: Report;
  refreshed: boolean;
};
type JobWire = Partial<Job> & {
  id: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
};
type JobsResponse = { jobs: JobWire[]; active_id?: string | null };
type JobLogResponse = {
  offset?: number;
  from?: number;
  next: number;
  truncated: boolean;
  lines: Array<string | { offset: number; stream: string; line: string }>;
  running?: boolean;
  state?: string;
  code?: number | null;
  result?: Report;
  job?: JobWire;
};
type JobProgress = {
  jobId: string;
  current: number;
  total: number;
  records?: number;
  blocks?: number;
};
const nf = new Intl.NumberFormat();
const tf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const PAGE = 40;
const INTAKE_INTERVAL_MS = 30_000;
const JOB_LINE_LIMIT = 500;
const TRUNCATION_MARKER = "[earlier output truncated]";
const initialLocation = typeof window === "undefined"
  ? {
      workspace: "events",
      job: "",
      source: null,
      project: "",
      folder: "",
      view: "stream",
      historyPeriod: "week",
      historyDate: "",
      vectorOperation: "",
      vectorSession: "",
      vectorDate: "",
      vectorSource: "",
      vectorProject: "",
      vectorFolder: "",
      vectorProviders: ["dual-4090"],
      vectorActors: ["human", "agent"],
      vectorView: "3d",
      vectorBreadth: "session",
    } satisfies WorkspaceLocation
  : readWorkspaceLocation(window.location);
async function json<T>(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const b = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(b.error || `${r.status} ${r.statusText}`);
  return b;
}
export function eventFacetsFromWire(wire: unknown): EventFacets {
  const record = wire && typeof wire === "object"
    ? wire as Record<string, unknown>
    : {};
  const candidate = record.facets && typeof record.facets === "object"
    ? record.facets as Record<string, unknown>
    : record;
  return {
    projects: Array.isArray(candidate?.projects) ? candidate.projects : [],
    folders: Array.isArray(candidate?.folders) ? candidate.folders : [],
  };
}
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const folderLabel = (p: string) =>
  p.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || p;
const parent = (p: string) => p.replace(/[\\/][^\\/]+$/, "") || p;
const bytes = (n: number) =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const label = (s: FileState) =>
  (
    ({
      new: "new",
      changed: "changed",
      unchanged: "indexed",
      shrunk: "reconcile",
    }) as const
  )[s];
export function initialPlanFilter(plan: Pick<Plan, "new" | "changed" | "shrunk">): Filter {
  return plan.new + plan.changed + plan.shrunk > 0 ? "actionable" : "all";
}
function localTime(s: string) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : tf.format(d).replace(",", "");
}
function elapsed(ms: number) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}
function isTerminal(job: Job) {
  return !job.running && job.state !== "queued" && job.state !== "cancelling";
}
function normalizeJob(job: JobWire): Job {
  const state = job.state ?? "unknown";
  const started = job.started ?? job.started_at ?? job.created_at ?? "";
  const ended = job.ended ?? job.finished_at ?? null;
  const startedMs = new Date(started).getTime();
  const endedMs = ended ? new Date(ended).getTime() : Date.now();
  return {
    id: job.id,
    name: job.name ?? `#${job.id.slice(0, 8)} import`,
    mode: job.mode ?? "batch",
    root: job.root ?? "",
    source: job.source ?? "unknown",
    max_files: job.max_files,
    running: job.running ?? (state === "running" || state === "cancelling"),
    state,
    code: job.code ?? job.exit_code ?? null,
    started,
    ended,
    elapsed_ms: job.elapsed_ms ?? (Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0),
    last: job.last ?? job.error ?? "",
    error: job.error,
    result: job.result,
  };
}
function appendJobLines(current: string[], incoming: string[], truncated = false) {
  if (truncated) return [TRUNCATION_MARKER, ...incoming.slice(-(JOB_LINE_LIMIT - 1))];
  if (current[0] === TRUNCATION_MARKER) {
    return [TRUNCATION_MARKER, ...[...current.slice(1), ...incoming].slice(-(JOB_LINE_LIMIT - 1))];
  }
  return [...current, ...incoming].slice(-JOB_LINE_LIMIT);
}
export function latestJobProgress(jobId: string, lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(
      /\[jscan\] import (?:start|progress) (\d+)\/(\d+)(?: records=(\d+) blocks=(\d+))?/,
    );
    if (!match) continue;
    return {
      jobId,
      current: Number(match[1]),
      total: Number(match[2]),
      ...(match[3] ? { records: Number(match[3]) } : {}),
      ...(match[4] ? { blocks: Number(match[4]) } : {}),
    } satisfies JobProgress;
  }
  return null;
}
function Loading() {
  return <div className="loading-rule" aria-hidden="true" />;
}
function Bars({
  title,
  values,
}: {
  title: string;
  values: [string, number][];
}) {
  const max = Math.max(1, ...values.map((v) => v[1]));
  const id = `viz-${title.replace(/\s/g, "-")}`;
  return (
    <section className="viz-panel" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <div className="viz-bars" role="list">
        {values.map(([name, count]) => (
          <div className="viz-row" role="listitem" key={name}>
            <span>{name}</span>
            <span className="viz-track" aria-hidden="true">
              <span
                className="viz-fill"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveIntake({
  report,
  busy,
  error,
  nextScanAt,
  valid,
  paused,
  jobActive,
  actions,
  onRefresh,
}: {
  report: Intake | null;
  busy: boolean;
  error: string;
  nextScanAt: number | null;
  valid: boolean;
  paused: boolean;
  jobActive: boolean;
  actions?: ReactNode;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = nextScanAt === null
    ? null
    : Math.max(0, Math.ceil((nextScanAt - now) / 1_000));
  const state = !valid || paused || jobActive
    ? "is-paused"
    : error
      ? "is-error"
      : report?.actionable
        ? "has-new"
        : report
          ? "is-clear"
          : "is-scanning";
  const title = !valid
    ? "Polling paused"
    : jobActive
      ? "Import active"
    : paused
      ? "Polling paused"
      : busy
        ? "Scanning now"
        : error
          ? "Last scan failed"
          : report
            ? report.actionable
              ? `${report.actionable === 1 ? "file needs" : "files need"} attention`
              : "pending JSONL files"
            : "Scanning now";
  const detail = !valid
    ? "Enter root and source"
    : jobActive
      ? "Intake resumes after the writer exits"
    : paused
      ? "Resumes when this tab is visible"
      : error
        ? error
        : report?.actionable
          ? `${nf.format(report.new)} new · ${nf.format(report.changed)} changed${report.reconcile ? ` · ${nf.format(report.reconcile)} reconcile` : ""}`
          : report
            ? "Source is aligned"
            : "Checking selected root";
  const timing = jobActive
    ? "Waiting for writer"
    : paused
    ? "Interval paused"
    : busy
      ? "Reading file metadata"
      : seconds === null
        ? "Waiting to scan"
        : `Next scan in ${seconds}s`;
  const ledger = report
    ? `${nf.format(report.indexed)} known · ${nf.format(report.found)} found`
    : "No intake reading yet";
  const announcement = !valid
    ? "Live intake paused. Enter root and source."
    : jobActive
      ? "Live intake paused during the active import job."
    : paused
      ? "Live intake paused until this tab is visible."
      : error
        ? `Live intake failed. ${error}`
        : report
          ? `${report.actionable} JSONL ${report.actionable === 1 ? "file needs" : "files need"} attention: ${report.new} new, ${report.changed} changed, ${report.reconcile} reconcile. ${ledger}.`
          : "";
  return (
    <section
      className={`intake-monitor ${state}`}
      aria-labelledby="intake-heading"
      aria-busy={busy}
    >
      <header className="intake-header">
        <h3 id="intake-heading">
          <span className="intake-dot" aria-hidden="true" />
          Live intake
        </h3>
        <span>30s interval</span>
      </header>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <div className="intake-reading">
        <strong>{report ? nf.format(report.actionable) : "—"}</strong>
        <span>
          <b>{title}</b>
          <small title={error || report?.checked_at}>{detail}</small>
        </span>
      </div>
      <dl className="intake-breakdown" aria-label="Live intake file states">
        <div>
          <dt>New</dt>
          <dd>{report ? nf.format(report.new) : "—"}</dd>
        </div>
        <div>
          <dt>Changed</dt>
          <dd>{report ? nf.format(report.changed) : "—"}</dd>
        </div>
        <div>
          <dt>Known</dt>
          <dd>{report ? nf.format(report.indexed) : "—"}</dd>
        </div>
        <div>
          <dt>Reconcile</dt>
          <dd>{report ? nf.format(report.reconcile) : "—"}</dd>
        </div>
      </dl>
      <footer className="intake-footer">
        <span>
          <b>{timing}</b>
          <small>{ledger}</small>
        </span>
        <div className="intake-footer-actions">
          {actions}
          <button
            className="button-quiet refresh-button"
            type="button"
            disabled={!valid || busy || jobActive}
            onClick={onRefresh}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </footer>
    </section>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null),
    [events, setEvents] = useState<Events | null>(null),
    [eventFacets, setEventFacets] = useState<EventFacets>({ projects: [], folders: [] }),
    [plan, setPlan] = useState<Plan | null>(null),
    [report, setReport] = useState<Report | null>(null);
  const [root, setRoot] = useState(""),
    [source, setSource] = useState("claude"),
    [eventSource, setEventSource] = useState(initialLocation.source ?? ""),
    [eventProject, setEventProject] = useState(initialLocation.project),
    [eventFolder, setEventFolder] = useState(initialLocation.folder),
    [maxFiles, setMaxFiles] = useState(1);
  const [busy, setBusy] = useState<Busy>("boot"),
    [error, setError] = useState(""),
    [eventsBusy, setEventsBusy] = useState(false),
    [eventsError, setEventsError] = useState("");
  const [eventsHydrated, setEventsHydrated] = useState(false),
    [eventsReadyForIntake, setEventsReadyForIntake] = useState(false);
  const [intake, setIntake] = useState<Intake | null>(null),
    [intakeBusy, setIntakeBusy] = useState(false),
    [intakeError, setIntakeError] = useState(""),
    [nextIntakeAt, setNextIntakeAt] = useState<number | null>(null),
    [intakePaused, setIntakePaused] = useState(document.hidden),
    [intakeCycle, setIntakeCycle] = useState(0);
  const [filter, setFilter] = useState<Filter>("new"),
    [planQuery, setPlanQuery] = useState(""),
    [page, setPage] = useState(0),
    [view, setView] = useState<"stream" | "visualize">(initialLocation.view),
    [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>(initialLocation.historyPeriod),
    [historyDate, setHistoryDate] = useState(initialLocation.historyDate),
    [historyVector, setHistoryVector] = useState<HistoryVectorLocation>({
      operation: initialLocation.vectorOperation ?? "",
      providers: initialLocation.vectorProviders ?? ["dual-4090"],
      actors: initialLocation.vectorActors ?? ["human", "agent"],
      view: initialLocation.vectorView ?? "3d",
      breadth: initialLocation.vectorBreadth ?? "session",
      date: initialLocation.vectorDate ?? "",
      source: initialLocation.vectorSource ?? "",
      project: initialLocation.vectorProject ?? "",
      folder: initialLocation.vectorFolder ?? "",
      session: initialLocation.vectorSession ?? "",
    }),
    [expandedEvent, setExpandedEvent] = useState(""),
    [projectSearchRequest, setProjectSearchRequest] = useState(0);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialLocation.workspace),
    [jobs, setJobs] = useState<Job[]>([]),
    [selectedJobId, setSelectedJobId] = useState(initialLocation.job),
    [jobLines, setJobLines] = useState<string[]>([]),
    [jobProgress, setJobProgress] = useState<JobProgress | null>(null),
    [jobAnnouncement, setJobAnnouncement] = useState(""),
    [copiedJobId, setCopiedJobId] = useState(""),
    [jobActionBusy, setJobActionBusy] = useState(""),
    [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null),
    [jobsError, setJobsError] = useState(""),
    [jobsBusy, setJobsBusy] = useState(false),
    [jobsCycle, setJobsCycle] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => {
      const saved = localStorage.getItem("jsonl-core-theme");
      return saved === "paper" || saved === "dark" ? saved : "dark";
    }),
    [planOpen, setPlanOpen] = useState(false),
    [planInspectionMode, setPlanInspectionMode] = useState<PlanInspectionMode>("quick"),
    [planImportMode, setPlanImportMode] = useState<"batch" | "all" | null>(null);
  const importJobRunning = jobs.some((job) => job.running);
  const initialized = useRef(false),
    sourceHydratedFromUrl = useRef(initialLocation.source !== null),
    eventSeq = useRef(0),
    eventController = useRef<AbortController | null>(null),
    facetController = useRef<AbortController | null>(null),
    facetTimer = useRef<number | undefined>(undefined),
    intakeReadyScheduled = useRef(false),
    intakeReadyFrame = useRef<number | undefined>(undefined),
    intakeReadyTimer = useRef<number | undefined>(undefined),
    intakeSeq = useRef(0),
    intakeController = useRef<AbortController | null>(null),
    intakeImmediate = useRef(false),
    intakeSpec = useRef(""),
    planSeq = useRef(0),
    formSpec = useRef(""),
    jobCursor = useRef(0),
    jobsGeneration = useRef(0),
    liveRefreshInFlight = useRef(false),
    lastLiveRefresh = useRef(0),
    handledJobs = useRef(new Set<string>()),
    finishingJobs = useRef(new Set<string>()),
    latestAttemptStarted = useRef(0),
    workspaceRef = useRef<HTMLElement>(null),
    projectFilter = useRef<HTMLInputElement>(null),
    followJobLog = useRef(true),
    announcedJobState = useRef(""),
    planClose = useRef<HTMLButtonElement>(null),
    planDialog = useRef<HTMLElement>(null),
    planTrigger = useRef<HTMLButtonElement>(null),
    batchConfirmStart = useRef<HTMLButtonElement>(null),
    copiedTimer = useRef<number | undefined>(undefined);
  formSpec.current = `${source.trim()}\u0000${root.trim()}`;
  const refreshIntake = useCallback(() => {
    intakeImmediate.current = true;
    setIntakeCycle((cycle) => cycle + 1);
  }, []);
  const loadStatus = useCallback(async () => {
    const s = await json<Status>("/api/status");
    setStatus(s);
    if (!initialized.current) {
      const p = s.source_presets.find((x) => x.default) ?? s.source_presets[0];
      if (p) {
        setSource(p.id);
        setRoot(p.root);
        if (!sourceHydratedFromUrl.current) setEventSource(p.id);
      }
      initialized.current = true;
    }
    return s;
  }, []);
  const loadEvents = useCallback(
    async (src: string, project = "", folder = "") => {
    const seq = ++eventSeq.current;
    eventController.current?.abort();
    facetController.current?.abort();
    if (facetTimer.current !== undefined) window.clearTimeout(facetTimer.current);
    const controller = new AbortController();
    eventController.current = controller;
    setEventsBusy(true);
    setEventsError("");
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (src) query.set("source", src);
      if (project) query.set("project", project);
      if (folder) query.set("folder", folder);
      const e = await json<Events>(`/api/events?${query}`, {
        signal: controller.signal,
      });
      if (seq !== eventSeq.current) return null;
      setEvents(e);
      setEventFacets(e.facets ?? { projects: [], folders: [] });
      if (!intakeReadyScheduled.current) {
        intakeReadyScheduled.current = true;
        intakeReadyFrame.current = window.requestAnimationFrame(() => {
          intakeReadyTimer.current = window.setTimeout(
            () => setEventsReadyForIntake(true),
            0,
          );
        });
      }
      facetTimer.current = window.setTimeout(() => {
        if (seq !== eventSeq.current) return;
        const facetRequest = new AbortController();
        facetController.current = facetRequest;
        const facetQuery = new URLSearchParams();
        if (src) facetQuery.set("source", src);
        if (project) facetQuery.set("project", project);
        void json<EventFacets | { facets?: Partial<EventFacets> }>(
          `/api/events/facets?${facetQuery}`,
          { signal: facetRequest.signal },
        ).then((wire) => {
          if (seq === eventSeq.current) setEventFacets(eventFacetsFromWire(wire));
        }).catch((facetError) => {
          if (
            seq === eventSeq.current &&
            !(facetError instanceof Error && facetError.name === "AbortError")
          ) {
            setEventsError(
              `Filter options unavailable: ${facetError instanceof Error ? facetError.message : String(facetError)}`,
            );
          }
        }).finally(() => {
          if (facetController.current === facetRequest) facetController.current = null;
        });
      }, 0);
      return e;
    } catch (e) {
      if (
        seq === eventSeq.current &&
        !(e instanceof Error && e.name === "AbortError")
      )
        setEventsError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (eventController.current === controller) eventController.current = null;
      if (seq === eventSeq.current) setEventsBusy(false);
    }
    },
    [],
  );
  useEffect(() => {
    loadStatus()
      .then(() => setEventsHydrated(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }, [loadStatus]);
  useEffect(() => {
    if (eventsHydrated)
      void loadEvents(eventSource, eventProject, eventFolder);
  }, [eventFolder, eventProject, eventSource, eventsHydrated, loadEvents]);
  useEffect(() => () => {
    eventController.current?.abort();
    facetController.current?.abort();
    if (facetTimer.current !== undefined) window.clearTimeout(facetTimer.current);
    if (intakeReadyFrame.current !== undefined) window.cancelAnimationFrame(intakeReadyFrame.current);
    if (intakeReadyTimer.current !== undefined) window.clearTimeout(intakeReadyTimer.current);
  }, []);
  useEffect(() => {
    const intakeRoot = root.trim();
    const intakeSource = source.trim();
    const valid = Boolean(intakeRoot && intakeSource);
    const pollingAllowed = valid && eventsReadyForIntake && !importJobRunning;
    let disposed = false;
    let timer: number | undefined;

    const stopActiveScan = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      intakeSeq.current += 1;
      intakeController.current?.abort();
      intakeController.current = null;
      setIntakeBusy(false);
    };
    const scan = async () => {
      if (disposed || document.hidden || !pollingAllowed) return;
      const seq = ++intakeSeq.current;
      const controller = new AbortController();
      intakeController.current = controller;
      setIntakeBusy(true);
      setIntakeError("");
      setNextIntakeAt(null);
      try {
        const query = new URLSearchParams({
          root: intakeRoot,
          source: intakeSource,
        });
        const next = await json<Intake>(`/api/import/intake?${query}`, {
          signal: controller.signal,
        });
        if (!disposed && seq === intakeSeq.current) setIntake(next);
      } catch (scanError) {
        if (
          !disposed &&
          seq === intakeSeq.current &&
          !(scanError instanceof DOMException && scanError.name === "AbortError")
        ) {
          setIntakeError(
            scanError instanceof Error ? scanError.message : String(scanError),
          );
        }
      } finally {
        if (!disposed && seq === intakeSeq.current) {
          intakeController.current = null;
          setIntakeBusy(false);
          if (!document.hidden) {
            setNextIntakeAt(Date.now() + INTAKE_INTERVAL_MS);
            timer = window.setTimeout(() => void scan(), INTAKE_INTERVAL_MS);
          }
        }
      }
    };
    const start = (delay: number) => {
      if (!pollingAllowed || document.hidden) return;
      setNextIntakeAt(delay ? Date.now() + delay : null);
      timer = window.setTimeout(() => void scan(), delay);
    };
    const handleVisibility = () => {
      stopActiveScan();
      const hidden = document.hidden;
      setIntakePaused(hidden);
      setNextIntakeAt(null);
      if (!hidden && pollingAllowed) start(0);
    };

    const spec = `${intakeSource}\u0000${intakeRoot}`;
    const specChanged = spec !== intakeSpec.current;
    intakeSpec.current = spec;
    setIntakeError("");
    if (specChanged) setIntake(null);
    setIntakePaused(document.hidden);
    if (!pollingAllowed) {
      stopActiveScan();
      setNextIntakeAt(null);
    } else {
      const immediate = intakeImmediate.current;
      intakeImmediate.current = false;
      start(immediate ? 0 : 400);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      stopActiveScan();
    };
  }, [eventsReadyForIntake, importJobRunning, intakeCycle, root, source]);
  const runPlanFor = useCallback(async (
    requestedRoot: string,
    requestedSource: string,
    planState: PlanStateFilter = "actionable",
    compareMode: "full" | "metadata" = "metadata",
  ) => {
    const seq = ++planSeq.current;
    const spec = `${requestedSource}\u0000${requestedRoot}`;
    setBusy("plan");
    setError("");
    try {
      const q = new URLSearchParams({
        root: requestedRoot,
        source: requestedSource,
        plan_state: planState,
        compare: compareMode,
      });
      const next = await json<Plan>(`/api/import/plan?${q}`);
      if (seq !== planSeq.current || spec !== formSpec.current) return null;
      setPlan(next);
      setPage(0);
      setFilter(initialPlanFilter(next));
      setPlanQuery("");
      return next;
    } catch (e) {
      if (seq === planSeq.current && spec === formSpec.current)
        setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (seq === planSeq.current) setBusy(null);
    }
  }, []);
  const runPlan = useCallback(
    () => runPlanFor(root.trim(), source.trim(), "actionable", "metadata"),
    [root, runPlanFor, source],
  );
  const finishJob = useCallback(async (job: Job, result?: Report) => {
    if (handledJobs.current.has(job.id)) return;
    const attemptResult = result ?? job.result;
    const startedMs = new Date(job.started).getTime();
    const attemptTime = Number.isFinite(startedMs) ? startedMs : Date.now();
    if (attemptTime >= latestAttemptStarted.current) {
      latestAttemptStarted.current = attemptTime;
      setLastAttempt({
        id: job.id,
        state: job.state,
        started: job.started,
        error: job.error,
        result: job.state === "succeeded" ? attemptResult : undefined,
        refreshed: false,
      });
      setReport(job.state === "succeeded" && attemptResult ? attemptResult : null);
    }
    if (finishingJobs.current.has(job.id)) return;
    finishingJobs.current.add(job.id);
    try {
      refreshIntake();
      const jobSpec = `${job.source}\u0000${job.root}`;
      const matchesCurrentForm = formSpec.current === jobSpec;
      if (matchesCurrentForm) setPlan(null);
      const q = new URLSearchParams({ root: job.root, source: job.source });
      const [nextPlan, nextStatus, nextEvents] = await Promise.allSettled([
        matchesCurrentForm ? json<Plan>(`/api/import/plan?${q}`) : Promise.resolve(null),
        loadStatus(),
        loadEvents(eventSource, eventProject, eventFolder),
      ]);
      const failures: string[] = [];
      if (nextPlan.status === "rejected") failures.push(`plan: ${nextPlan.reason instanceof Error ? nextPlan.reason.message : String(nextPlan.reason)}`);
      if (nextStatus.status === "rejected") failures.push(`status: ${nextStatus.reason instanceof Error ? nextStatus.reason.message : String(nextStatus.reason)}`);
      if (nextEvents.status === "rejected") {
        failures.push(`events: ${nextEvents.reason instanceof Error ? nextEvents.reason.message : String(nextEvents.reason)}`);
      } else if (nextEvents.value === null) {
        failures.push("events: refresh failed");
      }
      if (failures.length) throw new Error(failures.join("; "));
      if (
        nextPlan.status === "fulfilled" &&
        nextPlan.value &&
        formSpec.current === jobSpec
      ) {
        setPlan(nextPlan.value);
        setPage(0);
      }
      handledJobs.current.add(job.id);
      setLastAttempt((current) => current?.id === job.id ? { ...current, refreshed: true } : current);
      setError((current) => current.startsWith(`Job ${job.state}, but completion refresh`) ? "" : current);
    } catch (refreshError) {
      setError(
        `Job ${job.state}, but completion refresh is retrying: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
    } finally {
      finishingJobs.current.delete(job.id);
    }
  }, [eventFolder, eventProject, eventSource, loadEvents, loadStatus, refreshIntake]);
  const locationState = useCallback(
    (nextWorkspace = workspaceView, nextJob = selectedJobId): WorkspaceLocation => ({
      workspace: nextWorkspace,
      job: nextJob,
      source: eventSource,
      project: eventProject,
      folder: eventFolder,
      view,
      historyPeriod,
      historyDate,
      vectorOperation: historyVector.operation,
      vectorSession: historyVector.session,
      vectorDate: historyVector.date,
      vectorSource: historyVector.source,
      vectorProject: historyVector.project,
      vectorFolder: historyVector.folder,
      vectorProviders: historyVector.providers,
      vectorActors: historyVector.actors,
      vectorView: historyVector.view,
      vectorBreadth: historyVector.breadth,
    }),
    [eventFolder, eventProject, eventSource, historyDate, historyPeriod, historyVector, selectedJobId, view, workspaceView],
  );
  const writeLocation = useCallback((
    next: WorkspaceLocation,
    push = false,
    pathname = window.location.pathname,
    historyState: unknown = push ? {} : window.history.state,
  ) => {
    const href = workspaceHref(pathname, next);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== href) {
      window.history[push ? "pushState" : "replaceState"](historyState, "", href);
    }
    document.title = next.workspace === "jobs"
      ? "Import Jobs · Lanceglass"
      : next.workspace === "history"
        ? "Work History · Lanceglass"
        : "Conversation Events · Lanceglass";
  }, []);
  const navigateWorkspace = useCallback((next: WorkspaceView, job = selectedJobId) => {
    const workspaceChanged = next !== workspaceView;
    if (next === "jobs" && job !== selectedJobId) {
      setSelectedJobId(job);
      setJobLines([]);
      setJobAnnouncement("");
      announcedJobState.current = "";
      jobCursor.current = 0;
      followJobLog.current = true;
    }
    setWorkspaceView(next);
    writeLocation(locationState(next, job), true);
    if (workspaceChanged) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
      }));
    }
  }, [locationState, selectedJobId, workspaceView, writeLocation]);
  const navigateHome = useCallback(() => {
    setWorkspaceView("events");
    writeLocation(locationState("events"), true, "/");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
    }));
  }, [locationState, writeLocation]);
  const locationWithHistoryVector = useCallback((vector: HistoryVectorLocation) => ({
    ...locationState("history"),
    vectorOperation: vector.operation,
    vectorSession: vector.session,
    vectorDate: vector.date,
    vectorSource: vector.source,
    vectorProject: vector.project,
    vectorFolder: vector.folder,
    vectorProviders: vector.providers,
    vectorActors: vector.actors,
    vectorView: vector.view,
    vectorBreadth: vector.breadth,
  }), [locationState]);
  const openHistoryVector = useCallback((scope: HistoryVectorScope) => {
    const next: HistoryVectorLocation = {
      operation: "vectors",
      breadth: historyVector.breadth,
      providers: historyVector.providers,
      actors: historyVector.actors,
      view: historyVector.view,
      date: scope.date,
      source: scope.source,
      project: scope.project,
      folder: scope.folder,
      session: scope.session_id,
    };
    setHistoryVector(next);
    writeLocation(
      locationWithHistoryVector(next),
      true,
      window.location.pathname,
      appOwnedHistoryVectorState(window.history.state),
    );
  }, [historyVector.actors, historyVector.providers, historyVector.view, locationWithHistoryVector, writeLocation]);
  const closeHistoryVector = useCallback(() => {
    if (historyVectorCloseAction(window.history.state) === "back") {
      window.history.back();
      return;
    }
    const next: HistoryVectorLocation = {
      operation: "",
      breadth: historyVector.breadth,
      providers: historyVector.providers,
      actors: historyVector.actors,
      view: historyVector.view,
      date: "",
      source: "",
      project: "",
      folder: "",
      session: "",
    };
    setHistoryVector(next);
    writeLocation(locationWithHistoryVector(next));
  }, [historyVector.actors, historyVector.providers, historyVector.view, locationWithHistoryVector, writeLocation]);
  const changeHistoryVectorProviders = useCallback((providers: VectorProvider[]) => {
    const next = { ...historyVector, providers };
    setHistoryVector(next);
    writeLocation(locationWithHistoryVector(next));
  }, [historyVector, locationWithHistoryVector, writeLocation]);
  const changeHistoryVectorActors = useCallback((actors: VectorActor[]) => {
    const next = { ...historyVector, actors };
    setHistoryVector(next);
    writeLocation(locationWithHistoryVector(next));
  }, [historyVector, locationWithHistoryVector, writeLocation]);
  const changeHistoryVectorView = useCallback((nextView: VectorView) => {
    const next = { ...historyVector, view: nextView };
    setHistoryVector(next);
    writeLocation(locationWithHistoryVector(next));
  }, [historyVector, locationWithHistoryVector, writeLocation]);
  const changeHistoryVectorBreadth = useCallback((nextBreadth: VectorBreadth) => {
    const next = { ...historyVector, breadth: nextBreadth };
    setHistoryVector(next);
    writeLocation(locationWithHistoryVector(next));
  }, [historyVector, locationWithHistoryVector, writeLocation]);
  useEffect(() => {
    writeLocation(locationState());
  }, [locationState, status, writeLocation]);
  useEffect(() => {
    const restore = () => {
      const next = readWorkspaceLocation(window.location);
      sourceHydratedFromUrl.current = next.source !== null;
      setWorkspaceView(next.workspace);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
      }));
      if (next.source !== null) setEventSource(next.source);
      setEventProject(next.project);
      setEventFolder(next.folder);
      setView(next.view);
      setHistoryPeriod(next.historyPeriod);
      setHistoryDate(next.historyDate);
      setHistoryVector({
        operation: next.vectorOperation ?? "",
        providers: next.vectorProviders ?? ["dual-4090"],
        actors: next.vectorActors ?? ["human", "agent"],
        view: next.vectorView ?? "3d",
        breadth: next.vectorBreadth ?? "session",
        date: next.vectorDate ?? "",
        source: next.vectorSource ?? "",
        project: next.vectorProject ?? "",
        folder: next.vectorFolder ?? "",
        session: next.vectorSession ?? "",
      });
      if (next.job !== selectedJobId) {
        setSelectedJobId(next.job);
        setJobLines([]);
        setJobAnnouncement("");
        announcedJobState.current = "";
        jobCursor.current = 0;
        followJobLog.current = true;
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [selectedJobId]);
  const runImport = useCallback(async (mode: "batch" | "all") => {
    if (!plan) return;
    setBusy("import");
    setError("");
    try {
      const response = await fetch("/api/jobs/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          root: root.trim(),
          source: source.trim(),
          ...(mode === "batch" ? { maxFiles } : {}),
          expectedPlanRevision: plan.plan_revision,
          expectedWillParse: plan.will_parse,
          planPolicy: "refresh",
        }),
      });
      const body = (await response.json()) as {
        started?: boolean;
        id?: string;
        error?: string;
        active_id?: string;
      };
      if (!response.ok) {
        if (response.status === 409 && body.active_id) {
          setEventSource(source.trim());
          setEventProject("");
          setEventFolder("");
          navigateWorkspace("jobs", body.active_id);
          setJobsCycle((cycle) => cycle + 1);
        }
        throw new Error(body.error || `${response.status} ${response.statusText}`);
      }
      if (body.started === false || !body.id) {
        throw new Error("Import job did not start");
      }
      setEventSource(source.trim());
      setEventProject("");
      setEventFolder("");
      navigateWorkspace("jobs", body.id);
      setJobsCycle((cycle) => cycle + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [maxFiles, navigateWorkspace, plan, root, source]);
  useEffect(() => {
    setLastAttempt(null);
    setReport(null);
    latestAttemptStarted.current = 0;
  }, [root, source]);
  const refreshLiveEvents = useCallback(async () => {
    if (eventFolder) return;
    if (liveRefreshInFlight.current) return;
    liveRefreshInFlight.current = true;
    lastLiveRefresh.current = Date.now();
    const seq = eventSeq.current;
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (eventSource) query.set("source", eventSource);
      if (eventProject) query.set("project", eventProject);
      const live = await json<LiveEvents>(`/api/events/live?${query}`);
      if (seq !== eventSeq.current) return;
      setEvents((current) => current &&
        current.source === eventSource &&
        current.project === eventProject &&
        !current.folder
          ? { ...current, events: live.events, total: live.total }
          : current);
    } catch (liveError) {
      setEventsError(`Live rows paused: ${liveError instanceof Error ? liveError.message : String(liveError)}`);
    } finally {
      liveRefreshInFlight.current = false;
    }
  }, [eventFolder, eventProject, eventSource]);
  useEffect(() => {
    const generation = ++jobsGeneration.current;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let nextDelay = workspaceView === "jobs" ? 1_000 : 5_000;
    const schedule = (delay: number) => {
      if (generation !== jobsGeneration.current || document.hidden) return;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (generation !== jobsGeneration.current || document.hidden) return;
      controller = new AbortController();
      setJobsBusy(true);
      setJobsError("");
      try {
        const listing = await json<JobsResponse>("/api/jobs", {
          signal: controller.signal,
        });
        if (generation !== jobsGeneration.current) return;
        const ordered = listing.jobs.map(normalizeJob).sort(
          (a, b) => new Date(b.started).getTime() - new Date(a.started).getTime(),
        );
        setJobs(ordered);
        const activeId = listing.active_id ?? ordered.find((candidate) => candidate.running)?.id ?? "";
        nextDelay = workspaceView === "jobs" || activeId ? 1_000 : 5_000;
        if (
          workspaceView === "events" &&
          activeId &&
          Date.now() - lastLiveRefresh.current >= 4_000
        ) {
          void refreshLiveEvents();
        }
        if (workspaceView === "events" && activeId && activeId !== selectedJobId) {
          setSelectedJobId(activeId);
          setJobLines([]);
          setJobAnnouncement("");
          jobCursor.current = 0;
          announcedJobState.current = "";
        }
        const selectedExists = ordered.some((candidate) => candidate.id === selectedJobId);
        const id = workspaceView === "jobs"
          ? selectedExists ? selectedJobId : activeId || ordered[0]?.id || ""
          : activeId || (selectedExists ? selectedJobId : "");
        if (id !== selectedJobId) {
          setSelectedJobId(id);
          setJobLines([]);
          setJobAnnouncement(selectedJobId ? "The linked job expired from bounded history; showing the newest available run." : "");
          jobCursor.current = 0;
          announcedJobState.current = "";
        }
        const job = ordered.find((candidate) => candidate.id === id);
        if (job && id === selectedJobId) {
          const log = await json<JobLogResponse>(
            `/api/jobs/${encodeURIComponent(id)}/log?from=${jobCursor.current}`,
            { signal: controller.signal },
          );
          if (generation !== jobsGeneration.current) return;
          const logJob = log.job ? normalizeJob(log.job) : job;
          const lines = log.lines.map((line) =>
            typeof line === "string" ? line : `${line.stream === "stderr" ? "! " : ""}${line.line}`,
          );
          const progress = latestJobProgress(id, lines);
          if (progress) setJobProgress(progress);
          followJobLog.current = !!workspaceRef.current &&
            workspaceRef.current.scrollHeight - workspaceRef.current.scrollTop - workspaceRef.current.clientHeight < 112;
          if (log.truncated && (log.offset ?? log.from ?? 0) > jobCursor.current) {
            setJobLines((current) => appendJobLines(current, lines, true));
          } else if (lines.length) {
            setJobLines((current) => appendJobLines(current, lines));
          }
          jobCursor.current = log.next;
          const result = log.result ?? logJob.result;
          setJobs((current) => current.map((item) => item.id === id ? logJob : item));
          if (result) {
            setJobs((current) => current.map((item) =>
              item.id === id ? { ...item, result } : item));
          }
          const running = log.running ?? logJob.running;
          const state = log.state ?? logJob.state;
          if (lines.length || state !== announcedJobState.current) {
            setJobAnnouncement(
              `${lines.length ? `${lines.length} new terminal ${lines.length === 1 ? "line" : "lines"}. ` : ""}Job ${state}.`,
            );
            announcedJobState.current = state;
          }
          if (!running && state !== "queued" && state !== "cancelling") {
            void finishJob(logJob, result);
          }
        } else if (job && isTerminal(job)) {
          void finishJob(job);
        }
      } catch (pollError) {
        if (!(pollError instanceof DOMException && pollError.name === "AbortError")) {
          setJobsError(pollError instanceof Error ? pollError.message : String(pollError));
        }
      } finally {
        if (generation === jobsGeneration.current) {
          setJobsBusy(false);
          schedule(nextDelay);
        }
      }
    };
    const visibility = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      if (!document.hidden) schedule(0);
    };
    document.addEventListener("visibilitychange", visibility);
    schedule(0);
    return () => {
      jobsGeneration.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [finishJob, jobsCycle, refreshLiveEvents, selectedJobId, workspaceView]);
  useEffect(() => {
    if (workspaceView === "jobs" && followJobLog.current && workspaceRef.current) {
      workspaceRef.current.scrollTop = workspaceRef.current.scrollHeight;
    }
  }, [jobLines, workspaceView]);
  useLayoutEffect(() => {
    if (workspaceView === "events" && workspaceRef.current) {
      workspaceRef.current.scrollTop = 0;
    }
  }, [workspaceView]);
  const refresh = useCallback(async () => {
    setBusy("refresh");
    setError("");
    try {
      await loadStatus();
      if (eventsHydrated) {
        await loadEvents(eventSource, eventProject, eventFolder);
      } else {
        // The filter effect performs the first rows request after status has
        // initialized the default source. Keeping this sequential prevents a
        // failed boot retry from issuing an accidental all-source scan.
        setEventsHydrated(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [eventFolder, eventProject, eventSource, eventsHydrated, loadEvents, loadStatus]);
  const inspectPlan = useCallback(async () => {
    const next = await runPlan();
    if (next) {
      setPlanInspectionMode("quick");
      setPlanImportMode(null);
      setPlanOpen(true);
    }
  }, [runPlan]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("jsonl-core-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!planOpen) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    planClose.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPlanImportMode(null);
        setPlanOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        planDialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      (returnFocus?.isConnected ? returnFocus : planTrigger.current)?.focus();
    };
  }, [planOpen]);
  useEffect(() => {
    const quickProjectSearch = (event: KeyboardEvent) => {
      if (
        planOpen ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLocaleLowerCase() !== "k"
      ) return;
      const target = event.target as HTMLElement | null;
      const editingElsewhere = target &&
        target !== projectFilter.current &&
        target.dataset.testid !== "project-filter" && (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      );
      if (editingElsewhere) return;
      event.preventDefault();
      navigateWorkspace(workspaceView === "history" ? "history" : "events");
      setProjectSearchRequest((request) => request + 1);
    };
    window.addEventListener("keydown", quickProjectSearch);
    return () => window.removeEventListener("keydown", quickProjectSearch);
  }, [navigateWorkspace, planOpen, workspaceView]);
  useEffect(() => {
    if (!projectSearchRequest || (workspaceView !== "events" && workspaceView !== "history")) return;
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
    const target = projectFilter.current;
    target?.focus();
    target?.select();
    target?.click();
  }, [projectSearchRequest, workspaceView]);
  useEffect(() => () => {
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
  }, []);
  const sources = useMemo(
    () => {
      const known = Object.keys(status?.sources ?? {});
      if (eventSource && !known.includes(eventSource)) known.push(eventSource);
      return known.sort();
    },
    [eventSource, status],
  );
  const projectFacets = eventFacets.projects;
  const projectShortcut = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  const folderFacets = eventFacets.folders;
  const eventScope = [
    eventSource || "all sources",
    eventProject && `oracle ${eventProject}`,
    eventFolder && folderLabel(eventFolder),
  ]
    .filter(Boolean)
    .join(" · ");
  const files = useMemo(
    () => {
      const query = planQuery.trim().toLocaleLowerCase();
      return (
        plan?.files.filter(
          (file) =>
            (filter === "all" ||
              (filter === "actionable"
                ? file.state !== "unchanged"
                : file.state === filter)) &&
            (!query || file.path.toLocaleLowerCase().includes(query)),
        ) ?? []
      );
    },
    [filter, plan, planQuery],
  );
  const pages = Math.max(1, Math.ceil(files.length / PAGE)),
    visible = files.slice(page * PAGE, (page + 1) * PAGE),
    done = plan?.unchanged ?? 0,
    total = plan?.found ?? 0,
    pct = total ? Math.round((done / total) * 100) : 0;
  const canImport = !!(
    plan &&
    plan.will_parse > 0 &&
    !plan.shrunk &&
    !jobs.some((job) => job.running) &&
    busy === null
  );
  const canPrepareBatch = !!(
    root.trim() &&
    source.trim() &&
    !jobs.some((job) => job.running) &&
    busy === null
  );
  useEffect(() => {
    if (planOpen && planImportMode) batchConfirmStart.current?.focus();
  }, [planImportMode, planOpen]);
  const activeJob = jobs.find((job) => job.running) ?? null;
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const fullInspectionRoot = selectedJob?.root ?? root;
  const fullInspectionSource = selectedJob?.source ?? source;
  const selectJob = (id: string) => {
    navigateWorkspace("jobs", id);
  };
  const inspectFullPlan = async (
    requestedRoot: string,
    requestedSource: string,
    actionKey = "plan:full",
  ) => {
    const nextRoot = requestedRoot.trim();
    const nextSource = requestedSource.trim();
    if (!nextRoot || !nextSource) return;
    setJobActionBusy(actionKey);
    setSource(nextSource);
    setRoot(nextRoot);
    setPlan(null);
    setReport(null);
    formSpec.current = `${nextSource}\u0000${nextRoot}`;
    try {
      const next = await runPlanFor(nextRoot, nextSource, "all", "full");
      if (next) {
        setPlanInspectionMode("full");
        setPlanImportMode(null);
        setPlanOpen(true);
      }
    } finally {
      setJobActionBusy("");
    }
  };
  const cancelJob = async (id: string) => {
    setJobActionBusy(`cancel:${id}`);
    try {
      await json(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setJobsCycle((cycle) => cycle + 1);
    } catch (cancelError) {
      setJobsError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setJobActionBusy("");
    }
  };
  const copyJobLog = async (job: Job) => {
    const output = jobLines.length
      ? jobLines.join("\n")
      : job.last || (job.running ? "Waiting for output…" : "No terminal output captured.");
    try {
      await navigator.clipboard.writeText(output);
      setCopiedJobId(job.id);
      setJobAnnouncement("Job terminal output copied to the clipboard.");
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedJobId(""), 1_600);
    } catch (copyError) {
      setJobsError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };
  const viewJobEvents = (job: Job) => {
    setSource(job.source);
    setRoot(job.root);
    setEventSource(job.source);
    setEventProject("");
    setEventFolder("");
    setView("stream");
    navigateWorkspace("events");
  };
  const reviewJobPlan = async (job: Job) => {
    await inspectFullPlan(job.root, job.source, `plan:${job.id}`);
  };
  const chooseSourcePreset = (preset: Status["source_presets"][number]) => {
    planSeq.current += 1;
    if (busy === "plan") setBusy(null);
    setSource(preset.id);
    setRoot(preset.root);
    setPlan(null);
    setReport(null);
    setPage(0);
  };
  const disabled = jobs.some((job) => job.running)
    ? "Wait for the active import job to finish."
    : busy
      ? "Wait for the current operation to finish."
      : plan?.shrunk
      ? "Reconcile shrunk source files before importing."
      : plan && plan.will_parse === 0
        ? "Nothing is pending for import."
        : !root.trim() || !source.trim()
          ? "Enter a root and source before importing."
          : "A current plan will be checked before confirmation.";
  const liveProgress = activeJob && jobProgress?.jobId === activeJob.id ? jobProgress : null;
  const liveProgressPct = liveProgress?.total
    ? Math.min(100, Math.round((liveProgress.current / liveProgress.total) * 100))
    : 0;
  const viz = useMemo(() => {
    const rows = events?.events ?? [];
    const dist = (value: (row: EventRow) => string) =>
      Array.from(
        rows.reduce((m, r) => {
          const k = value(r) || "unknown";
          m.set(k, (m.get(k) ?? 0) + 1);
          return m;
        }, new Map<string, number>()),
      ).sort((a, b) => b[1] - a[1]) as [string, number][];
    const ts = rows
        .map((r) => new Date(r.timestamp).getTime())
        .filter(Number.isFinite),
      min = ts.length ? Math.min(...ts) : 0,
      max = ts.length ? Math.max(...ts) : 0,
      buckets = Array(12).fill(0) as number[];
    ts.forEach(
      (t) =>
        buckets[
          max === min
            ? 11
            : Math.min(11, Math.floor(((t - min) / (max - min)) * 12))
        ]++,
    );
    return {
      blocks: dist((row) => row.block_type),
      roles: dist((row) => row.semantic_role),
      projects: dist((row) => row.project).slice(0, 12),
      folders: dist((row) =>
        row.folder ? folderLabel(row.folder) : "unknown",
      ).slice(0, 12),
      buckets,
      peak: Math.max(1, ...buckets),
    };
  }, [events]);
  return (
    <div className={`app-shell ${planOpen ? "has-modal" : ""}`}>
      <header className="command-bar" inert={planOpen}>
        <button
          className="brand"
          type="button"
          onClick={navigateHome}
          aria-label={`Home · Lanceglass · build ${__BUILD_VERSION__}`}
          title={`Lanceglass · v${__BUILD_VERSION__} · built ${__BUILD_TIME__}`}
        >
          <span aria-hidden="true">↖</span>
          <strong>LANCE</strong>
          <span>glass</span>
          <small>v{__BUILD_VERSION__}</small>
        </button>
        <div className="theme-switch" role="group" aria-label="Color theme">
          <button
            type="button"
            className={theme === "dark" ? "is-active" : ""}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme("dark")}
          >
            Dark
          </button>
          <button
            type="button"
            className={theme === "paper" ? "is-active" : ""}
            aria-pressed={theme === "paper"}
            onClick={() => setTheme("paper")}
          >
            Paper
          </button>
        </div>
        <nav className="workspace-switch" aria-label="Workspace">
          <button
            type="button"
            aria-current={workspaceView === "events" ? "page" : undefined}
            onClick={() => navigateWorkspace("events")}
          >
            Events
          </button>
          <button
            type="button"
            aria-current={workspaceView === "history" ? "page" : undefined}
            onClick={() => navigateWorkspace("history")}
          >
            History
          </button>
          <button
            type="button"
            aria-current={workspaceView === "jobs" ? "page" : undefined}
            onClick={() => navigateWorkspace("jobs")}
          >
            Jobs{jobs.some((job) => job.running) ? " · live" : ""}
          </button>
        </nav>
        <div className="connection">
          <span
            className={`connection-dot ${status ? "is-ready" : ""}`}
            aria-hidden="true"
          />
          <span>
            <strong>
              {status?.demo?.enabled
                ? status.demo.label
                : status
                  ? "LanceDB connected"
                  : "Connecting to LanceDB"}
            </strong>
            <small title={status?.db_dir}>
              {status?.demo?.enabled
                ? "bundled data · no KV · no D1 · no persistence"
                : status?.db_dir ?? "localhost · port 4320"}
            </small>
          </span>
        </div>
      </header>
      {error && (
        <div className="app-alert" role="alert">
          <strong>{error}</strong>
          <span>Review the inputs or retry the operation.</span>
        </div>
      )}
      <main
        ref={workspaceRef}
        className="workspace"
        aria-hidden={planOpen || undefined}
        inert={planOpen}
      >
        {workspaceView === "events" && (
        <aside className="control-rail">
          <section className="rail-section" aria-labelledby="import-heading">
            <header className="rail-heading">
              <h2 id="import-heading">Import</h2>
              <span>bounded JSONL batch</span>
            </header>
            <form
              id="import-form"
              className="field-grid"
              onSubmit={(e) => {
                e.preventDefault();
                void inspectPlan();
              }}
            >
              <fieldset className="source-preset-field">
                <legend>Import source</legend>
                <div className="source-preset-switch">
                  {status?.source_presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={source === preset.id && root === preset.root}
                      onClick={() => chooseSourcePreset(preset)}
                    >
                      {preset.id === "fixture" ? "Fixture" : preset.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="field-label">
                <span>JSONL root</span>
                <input
                  value={root}
                  onChange={(e) => {
                    planSeq.current += 1;
                    if (busy === "plan") setBusy(null);
                    setRoot(e.target.value);
                    setPlan(null);
                    setReport(null);
                    setPage(0);
                  }}
                  required
                  spellCheck={false}
                />
              </label>
              <label className="field-label">
                <span>Source</span>
                <input
                  list="source-presets"
                  value={source}
                  onChange={(e) => {
                    planSeq.current += 1;
                    if (busy === "plan") setBusy(null);
                    const s = e.target.value;
                    setSource(s);
                    const p = status?.source_presets.find((x) => x.id === s);
                    if (p) setRoot(p.root);
                    setPlan(null);
                    setReport(null);
                    setPage(0);
                  }}
                  required
                  spellCheck={false}
                />
                <datalist id="source-presets">
                  {status?.source_presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </datalist>
              </label>
              {(!canPrepareBatch || !plan || plan.shrunk > 0 || plan.will_parse === 0) && (
                <p className="disabled-reason">{disabled}</p>
              )}
            </form>
            <LiveIntake
              report={intake}
              busy={intakeBusy}
              error={intakeError}
              nextScanAt={nextIntakeAt}
              valid={Boolean(root.trim() && source.trim())}
              paused={intakePaused}
              jobActive={importJobRunning}
              actions={(
                <button
                  ref={planTrigger}
                  className={intake?.actionable ? "button-primary" : "button-quiet"}
                  type="submit"
                  form="import-form"
                  disabled={busy !== null || !root.trim() || !source.trim()}
                >
                  {busy === "plan"
                    ? "Inspecting…"
                    : intake?.actionable
                      ? `Inspect ${nf.format(intake.actionable)} pending`
                      : "Inspect plan"}
                </button>
              )}
              onRefresh={refreshIntake}
            />
          </section>
          <section className="rail-section" aria-labelledby="ledger-heading">
            <header className="rail-heading">
              <h2 id="ledger-heading">Ledger</h2>
              <span>stored rows</span>
            </header>
            <dl className="metric-list">
              <div>
                <dt>events</dt>
                <dd>{status ? nf.format(status.tables.events) : "—"}</dd>
              </div>
              <div>
                <dt>provenance</dt>
                <dd>{status ? nf.format(status.tables.event_sources) : "—"}</dd>
              </div>
              <div>
                <dt>source files</dt>
                <dd>{status ? nf.format(status.tables.source_files) : "—"}</dd>
              </div>
            </dl>
          </section>
          <section className="rail-section" aria-labelledby="report-heading">
            <header className="rail-heading">
              <h2 id="report-heading">Last import</h2>
              <span>
                {lastAttempt
                  ? `${lastAttempt.state}${lastAttempt.result?.partial ? " · partial" : ""}`
                  : "no write this session"}
              </span>
            </header>
            {lastAttempt?.state === "succeeded" && report ? (
              <dl className="metric-list">
                <div>
                  <dt>selected / remaining</dt>
                  <dd>
                    {report.selected_files} / {report.remaining_files}
                  </dd>
                </div>
                <div>
                  <dt>inserted / duplicates</dt>
                  <dd>
                    {report.inserted} / {report.duplicates}
                  </dd>
                </div>
                <div>
                  <dt>corrupt</dt>
                  <dd>{report.corrupt}</dd>
                </div>
              </dl>
            ) : lastAttempt ? (
              <div className={`attempt-note state-${lastAttempt.state}`}>
                <strong>
                  {lastAttempt.state === "succeeded"
                    ? "Import succeeded without captured metrics."
                    : `Import ${lastAttempt.state}.`}
                </strong>
                {lastAttempt.error && <span>{lastAttempt.error}</span>}
                <span>
                  {lastAttempt.state === "succeeded"
                    ? lastAttempt.refreshed
                      ? "The ledger was refreshed."
                      : "Ledger refresh is retrying."
                    : `Partial idempotent batches may have committed before termination. ${lastAttempt.refreshed ? "The ledger was refreshed; retrying is safe." : "Ledger refresh is retrying; retrying the import is safe."}`}
                </span>
              </div>
            ) : (
              <p className="empty-state">Inspecting is read-only.</p>
            )}
          </section>
          <section className="rail-section" aria-labelledby="cli-heading">
            <header className="rail-heading">
              <h2 id="cli-heading">CLI twin</h2>
            </header>
            <code className="cli-command">
              maw jscan import --root {root || "…"} --source {source || "…"}{" "}
              --max-files {maxFiles}
            </code>
          </section>
          <section className="rail-section" aria-labelledby="plan-heading">
            <header className="rail-heading">
              <h2 id="plan-heading">Import plan</h2>
              <span>{plan ? `${plan.will_parse} pending` : "read-only"}</span>
            </header>
            {busy === "plan" && <Loading />}
            <div className="plan-summary">
              <span>
                {plan ? `${done}/${total} indexed` : "No plan inspected"}
              </span>
              <strong>{plan ? `${pct}%` : "—"}</strong>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label={
                plan
                  ? `${pct}% of source files indexed`
                  : "Import progress unavailable until a plan is inspected"
              }
              aria-valuemin={0}
              aria-valuemax={100}
              {...(plan ? { "aria-valuenow": pct } : {})}
            >
              <span style={{ transform: `scaleX(${pct / 100})` }} />
            </div>
            {plan && (
              <button
                className="button-secondary"
                type="button"
                onClick={() => {
                  setPlanImportMode(null);
                  setPlanOpen(true);
                }}
              >
                View plan
              </button>
            )}
          </section>
        </aside>
        )}
        {workspaceView === "events" ? (
        <section className="events-pane" aria-labelledby="events-heading">
          <header className="events-toolbar">
            <div className="events-title">
              <h1 id="events-heading">Imported conversation events</h1>
              <p className="events-status">
                {events
                  ? `Showing ${events.events.length} of ${nf.format(events.total)} normalized blocks · ${eventScope}${activeJob ? eventFolder ? " · live import; folder scope syncs on completion" : " · live import; bounded rows refreshing" : ""}`
                  : "Waiting for event data"}
              </p>
              <div
                className={`events-live-strip ${activeJob ? "is-importing" : ""}`}
                aria-label={activeJob ? "Live import progress" : "Live intake file states"}
              >
                <div className="events-live-head">
                  <span><i aria-hidden="true" />{activeJob ? "Live import" : "Live intake"}</span>
                  <strong>{activeJob?.source ?? intake?.source ?? source}</strong>
                  <small>
                    {activeJob
                      ? liveProgress
                        ? `${nf.format(liveProgress.current)} / ${nf.format(liveProgress.total)} files · ${liveProgressPct}%${liveProgress.records ? ` · ${nf.format(liveProgress.records)} records` : ""}`
                        : "Waiting for first progress line"
                      : intake
                        ? `${nf.format(intake.indexed)} / ${nf.format(intake.found)} known`
                        : "Reading source state"}
                  </small>
                </div>
                <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  {activeJob
                    ? `Import running for ${activeJob.source}. ${eventFolder ? "The folder-filtered event scope will synchronize when the job completes." : "A bounded event window refreshes during the import; facets and paths synchronize when it completes."}`
                    : jobAnnouncement}
                </span>
                {!activeJob && (
                  <dl className="events-live-metrics">
                    <div className="is-new"><dt>New</dt><dd>{intake ? nf.format(intake.new) : "—"}</dd></div>
                    <div className="is-changed"><dt>Changed</dt><dd>{intake ? nf.format(intake.changed) : "—"}</dd></div>
                    <div className="is-indexed"><dt>Known</dt><dd>{intake ? nf.format(intake.indexed) : "—"}</dd></div>
                    <div className="is-reconcile"><dt>Reconcile</dt><dd>{intake ? nf.format(intake.reconcile) : "—"}</dd></div>
                  </dl>
                )}
                <span
                  className="events-live-track"
                  role={activeJob ? "progressbar" : undefined}
                  aria-label={activeJob ? "Import files processed" : undefined}
                  aria-valuemin={activeJob ? 0 : undefined}
                  aria-valuemax={activeJob ? 100 : undefined}
                  aria-valuenow={activeJob ? liveProgressPct : undefined}
                  aria-hidden={activeJob ? undefined : true}
                >
                  <span style={{ transform: `scaleX(${activeJob ? liveProgressPct / 100 : intake?.found ? intake.indexed / intake.found : 0})` }} />
                </span>
              </div>
            </div>
            <div className="events-controls" aria-label="Event filters">
              <label className="field-label events-view-control">
                <span>View</span>
                <span className="view-switch" aria-label="Events view">
                  <button
                    type="button"
                    aria-pressed={view === "stream"}
                    onClick={() => setView("stream")}
                  >
                    Stream
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "visualize"}
                    onClick={() => setView("visualize")}
                  >
                    Visualize
                  </button>
                </span>
              </label>
              <label className="field-label">
                <span>Source</span>
                <select
                  data-testid="source-filter"
                  value={eventSource}
                  onChange={(event) => {
                    setEventSource(event.target.value);
                    setEventProject("");
                    setEventFolder("");
                  }}
                >
                  <option value="">all sources</option>
                  {sources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <ProjectCombobox
                ref={projectFilter}
                facets={projectFacets}
                value={eventProject}
                onChange={setEventProject}
                shortcut={projectShortcut}
              />
              <label className="field-label">
                <span>Directory / Folder</span>
                <select
                  data-testid="folder-filter"
                  value={eventFolder}
                  onChange={(event) => setEventFolder(event.target.value)}
                >
                  <option value="">all folders</option>
                  {folderFacets.map((facet) => (
                    <option
                      key={facet.value}
                      value={facet.value}
                      title={facet.value}
                    >
                      {folderLabel(facet.value)} · {nf.format(facet.count)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button-secondary refresh-button"
                type="button"
                onClick={() => void refresh()}
                disabled={busy !== null || eventsBusy}
              >
                {busy === "refresh" ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </header>
          {eventsError && (
            <div className="app-alert" role="alert">
              <span>{eventsError}</span>
              <button
                className="button-quiet"
                type="button"
                onClick={() =>
                  void loadEvents(eventSource, eventProject, eventFolder)
                }
              >
                Retry events
              </button>
            </div>
          )}
          {eventsBusy && <Loading />}
          {view === "visualize" ? (
            <div className="visualization-grid">
              <section className="viz-panel wide">
                <h3>Activity pulse</h3>
                <p className="viz-legend">
                  12 chronological buckets · visible window only
                </p>
                <div
                  className="viz-timeline"
                  role="list"
                  aria-label="Event activity by time bucket"
                >
                  {viz.buckets.map((n, i) => (
                    <div
                      className="viz-bucket"
                      role="listitem"
                      key={i}
                      title={`Bucket ${i + 1}: ${n} events`}
                    >
                      <span
                        style={{
                          height: `${Math.max(4, (n / viz.peak) * 100)}%`,
                        }}
                      />
                      <small>{n}</small>
                    </div>
                  ))}
                </div>
              </section>
              <Bars title="Block type" values={viz.blocks} />
              <Bars title="Semantic role" values={viz.roles} />
              <Bars title="Project / Oracle" values={viz.projects} />
              <Bars title="Directory / Folder" values={viz.folders} />
            </div>
          ) : (
            <div
              className="event-stream"
              data-testid="event-list"
              role="list"
              aria-busy={eventsBusy}
            >
              <div className="event-columns" aria-hidden="true">
                <span>time</span>
                <span>source / type</span>
                <span>project / role / folder</span>
                <span>canonical text</span>
              </div>
              {events?.events.map((r) => {
                const expanded = expandedEvent === r.id;
                return (
                  <article
                    className={`event-row kind-${r.block_type || "unknown"} role-${r.semantic_role || "unknown"} ${expanded ? "is-expanded" : ""}`}
                    data-testid="event-row"
                    data-source={r.source}
                    role="listitem"
                    key={r.id}
                  >
                    <time
                      dateTime={r.timestamp}
                      title={r.timestamp || undefined}
                    >
                      {localTime(r.timestamp)}
                    </time>
                    <div className="event-kind">
                      <strong>{r.source || "—"}</strong>
                      <span>{r.block_type || "unknown"}</span>
                    </div>
                    <div className="event-meta">
                      <strong>{r.project || "—"}</strong>
                      <span>{r.semantic_role || "unknown"}</span>
                      {r.folder && (
                        <small title={r.folder}>{folderLabel(r.folder)}</small>
                      )}
                    </div>
                    <button
                      className="event-copy"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedEvent(expanded ? "" : r.id)}
                    >
                      <span>{r.text || "—"}</span>
                      {r.text.length > 280 && (
                        <small>
                          {expanded ? "collapse" : "expand full block"}
                        </small>
                      )}
                    </button>
                  </article>
                );
              })}
              {events && !events.events.length && (
                <div className="empty-state">
                  <strong>No imported events</strong>
                  <span>
                    Inspect a JSONL plan, then import one bounded batch.
                  </span>
                </div>
              )}
            </div>
          )}
        </section>
        ) : workspaceView === "history" ? (
          <HistoryWorkspace
            period={historyPeriod}
            date={historyDate}
            source={eventSource}
            project={eventProject}
            folder={eventFolder}
            sources={sources}
            projectFacets={projectFacets}
            folderFacets={folderFacets}
            projectShortcut={projectShortcut}
            projectRef={projectFilter}
            onPeriodChange={setHistoryPeriod}
            onDateChange={setHistoryDate}
            onSourceChange={setEventSource}
            onProjectChange={setEventProject}
            onFolderChange={setEventFolder}
            vectorOperation={historyVector.operation}
            vectorProviders={historyVector.providers}
            vectorActors={historyVector.actors}
            vectorView={historyVector.view}
            vectorBreadth={historyVector.breadth}
            vectorDate={historyVector.date}
            vectorSource={historyVector.source}
            vectorProject={historyVector.project}
            vectorFolder={historyVector.folder}
            vectorSession={historyVector.session}
            onVectorOpen={openHistoryVector}
            onVectorClose={closeHistoryVector}
            onVectorProvidersChange={changeHistoryVectorProviders}
            onVectorActorsChange={changeHistoryVectorActors}
            onVectorViewChange={changeHistoryVectorView}
            onVectorBreadthChange={changeHistoryVectorBreadth}
          />
        ) : (
          <section className="jobs-pane" aria-labelledby="jobs-heading">
            <header className="jobs-toolbar">
              <div>
                <h1 id="jobs-heading">Import jobs</h1>
                <p>{jobs.length ? `${nf.format(jobs.length)} recorded runs · newest first` : "Background imports and terminal output"} · full inspection verifies content hashes</p>
              </div>
              <div className="jobs-toolbar-actions">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={busy !== null || importJobRunning || !fullInspectionRoot.trim() || !fullInspectionSource.trim()}
                  title={`Inspect every file in ${fullInspectionRoot || "the current source"}`}
                  onClick={() => void inspectFullPlan(fullInspectionRoot, fullInspectionSource)}
                >
                  {jobActionBusy === "plan:full" ? "Inspecting all files…" : "Full inspection"}
                </button>
                <button className="button-secondary refresh-button" type="button" disabled={jobsBusy} onClick={() => setJobsCycle((cycle) => cycle + 1)}>
                  {jobsBusy ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </header>
            {jobsError && (
              <div className="event-error" role="alert">
                <strong>Jobs unavailable.</strong> {jobsError}
              </div>
            )}
            <div className="jobs-layout">
              <section className="job-terminal" aria-labelledby="job-terminal-heading">
                {selectedJob ? (
                  <>
                    <header>
                      <div>
                        <h2 id="job-terminal-heading">{selectedJob.name || selectedJob.id}</h2>
                        <p title={selectedJob.root}>{selectedJob.source} · {selectedJob.mode} · {selectedJob.root}</p>
                      </div>
                      <div className="job-actions">
                        <span className={`job-state state-${selectedJob.state}`}>
                          <span className="job-dot" aria-hidden="true" />
                          {selectedJob.state}{selectedJob.code !== null ? ` · exit ${selectedJob.code}` : ""}
                        </span>
                        {selectedJob.state === "succeeded" && (
                          <button className="button-primary" type="button" onClick={() => viewJobEvents(selectedJob)}>
                            View imported events
                          </button>
                        )}
                        {(selectedJob.state === "failed" || selectedJob.state === "cancelled") && (
                          <button
                            className="button-primary"
                            type="button"
                            disabled={jobActionBusy === `plan:${selectedJob.id}`}
                            onClick={() => void reviewJobPlan(selectedJob)}
                          >
                            {jobActionBusy === `plan:${selectedJob.id}` ? "Inspecting…" : "Review import plan"}
                          </button>
                        )}
                        {(selectedJob.running || selectedJob.state === "cancelling") && (
                          <button
                            className="button-quiet"
                            type="button"
                            disabled={selectedJob.state === "cancelling" || jobActionBusy === `cancel:${selectedJob.id}`}
                            onClick={() => void cancelJob(selectedJob.id)}
                          >
                            {selectedJob.state === "cancelling" || jobActionBusy === `cancel:${selectedJob.id}` ? "Cancelling…" : "Cancel job"}
                          </button>
                        )}
                        <button className="button-quiet" type="button" onClick={() => void copyJobLog(selectedJob)}>
                          {copiedJobId === selectedJob.id ? "Copied" : "Copy log"}
                        </button>
                      </div>
                    </header>
                    <dl className="job-facts">
                      <div><dt>started</dt><dd>{localTime(selectedJob.started)}</dd></div>
                      <div><dt>ended</dt><dd>{selectedJob.ended ? localTime(selectedJob.ended) : "—"}</dd></div>
                      <div><dt>elapsed</dt><dd>{elapsed(selectedJob.elapsed_ms)}</dd></div>
                    </dl>
                    {selectedJob.state === "succeeded" && selectedJob.result && (
                      <div className="job-result-summary" role="status">
                        <strong>{nf.format(selectedJob.result.selected_files)} files imported from the job-start snapshot</strong>
                        <span>
                          {nf.format(selectedJob.result.inserted)} inserted · {nf.format(selectedJob.result.duplicates)} duplicates · {nf.format(selectedJob.result.corrupt)} corrupt
                        </span>
                        <small>Live Claude/Codex sessions may append again immediately and appear as new pending work.</small>
                      </div>
                    )}
                    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{jobAnnouncement}</span>
                    <pre aria-label="Job terminal output">{jobLines.length ? jobLines.join("\n") : selectedJob.last || (selectedJob.running ? "Waiting for output…" : "No terminal output captured.")}</pre>
                  </>
                ) : (
                  <div className="empty-state">
                    <strong>Select a job</strong>
                    <span>Terminal output and completion details appear here.</span>
                  </div>
                )}
              </section>
              <ul className="job-list" aria-label="Import jobs">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <button
                      className={`job-row ${job.id === selectedJobId ? "is-selected" : ""}`}
                      type="button"
                      aria-current={job.id === selectedJobId ? "true" : undefined}
                      onClick={() => selectJob(job.id)}
                    >
                      <span className={`job-dot state-${job.state}`} aria-hidden="true" />
                      <span className="job-row-copy">
                        <strong>{job.name || `${job.source} import`}</strong>
                        <span>{job.mode === "all" ? "all pending files" : `next ${job.max_files ?? 1}`} · {job.state}</span>
                        <small>{localTime(job.started)} · {elapsed(job.elapsed_ms)}</small>
                      </span>
                    </button>
                  </li>
                ))}
                {!jobs.length && !jobsBusy && !jobsError && (
                  <li className="job-list-empty">
                    <div className="empty-state">
                      <strong>No import jobs yet</strong>
                      <span>Inspect a plan, then start a bounded batch.</span>
                    </div>
                  </li>
                )}
              </ul>
            </div>
          </section>
        )}
      </main>
      {planOpen && plan && (
        <div
          className="plan-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPlanImportMode(null);
              setPlanOpen(false);
            }
          }}
        >
          <section
            ref={planDialog}
            className={`plan-modal ${visible.length ? "" : "is-empty"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-modal-heading"
          >
            <header className="plan-modal-header">
              <div>
                <h2 id="plan-modal-heading">
                  {planInspectionMode === "full" ? "Full source inspection" : "Import plan"}
                </h2>
                <p>
                  {plan.will_parse
                    ? `${nf.format(plan.will_parse)} ${plan.will_parse === 1 ? "file needs" : "files need"} import`
                    : "Everything is already indexed"}
                  {plan.shrunk ? ` · ${nf.format(plan.shrunk)} need reconciliation` : ""}
                  {` · ${nf.format(plan.found)} found · ${planInspectionMode === "full" ? "content hashes verified" : "fast metadata check"} · read-only`}
                </p>
              </div>
              <button
                ref={planClose}
                className="button-quiet"
                type="button"
                autoFocus
                onClick={() => {
                  setPlanImportMode(null);
                  setPlanOpen(false);
                }}
                aria-label="Close import plan"
              >
                Close
              </button>
            </header>
            <ul className="plan-state-summary" aria-label="Import plan file states">
              <li><span>NEW</span><strong>{nf.format(plan.new)}</strong></li>
              <li><span>CHANGED</span><strong>{nf.format(plan.changed)}</strong></li>
              <li><span>INDEXED</span><strong>{nf.format(plan.unchanged)}</strong></li>
              <li><span>RECONCILE</span><strong>{nf.format(plan.shrunk)}</strong></li>
            </ul>
            <div className="plan-modal-toolbar">
              <div className="plan-modal-filters">
                <label className="field-label">
                  <span>Directory / File</span>
                  <input
                    type="search"
                    value={planQuery}
                    placeholder="filter path"
                    onChange={(event) => {
                      setPlanQuery(event.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <label className="field-label">
                  <span>State</span>
                  <select
                    value={filter}
                    onChange={(event) => {
                      setFilter(event.target.value as Filter);
                      setPage(0);
                    }}
                  >
                    <option value="all">All files ({nf.format(plan.found)})</option>
                    <option value="actionable">Needs attention ({nf.format(plan.new + plan.changed + plan.shrunk)})</option>
                    <option value="new">New ({nf.format(plan.new)})</option>
                    <option value="changed">Changed ({nf.format(plan.changed)})</option>
                    <option value="unchanged">Indexed ({nf.format(plan.unchanged)})</option>
                    <option value="shrunk">Reconcile ({nf.format(plan.shrunk)})</option>
                  </select>
                </label>
              </div>
              <span>
                {files.length
                  ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, files.length)} of ${files.length}`
                  : "0 files"}
              </span>
            </div>
            <div className="plan-modal-body">
              <div className="plan-list">
                {visible.map((file) => (
                  <article
                    className={`plan-row state-${file.state}`}
                    key={file.id}
                  >
                    <div className="plan-file">
                      <strong>{base(file.path)}</strong>
                      <span title={file.path}>{parent(file.path)}</span>
                    </div>
                    <span className="plan-state">{label(file.state)}</span>
                    <small>{bytes(file.size)}</small>
                  </article>
                ))}
                {!visible.length && (
                  <p className="empty-state">
                    {filter === "new" && !planQuery.trim() ? (
                      <>
                        <strong>No brand-new files.</strong>
                        <span>
                          {plan.changed
                            ? `${nf.format(plan.changed)} ${plan.changed === 1 ? "file has" : "files have"} changed since the last import.`
                            : "LanceDB already knows every discovered file."}
                        </span>
                        {plan.changed > 0 && (
                          <button
                            className="button-primary"
                            type="button"
                            onClick={() => {
                              setFilter("changed");
                              setPage(0);
                            }}
                          >
                            Show {nf.format(plan.changed)} changed
                          </button>
                        )}
                      </>
                    ) : filter === "actionable" && !planQuery.trim() ? (
                      <>
                        <strong>No files need attention.</strong>
                        <span>All {nf.format(plan.found)} discovered files are indexed.</span>
                      </>
                    ) : (
                      "No files match this state or path."
                    )}
                  </p>
                )}
              </div>
            </div>
            <div className={`plan-pager ${planImportMode ? "is-confirming" : ""}`}>
              {planImportMode ? (
                <div className="plan-import-confirm" role="group" aria-label="Confirm import">
                  <div>
                    <strong>
                      {planImportMode === "all"
                        ? `Import all ${nf.format(plan.will_parse)} pending files?`
                        : Math.min(maxFiles, plan.will_parse) === plan.will_parse
                          ? `Import ${nf.format(plan.will_parse)} pending ${plan.will_parse === 1 ? "file" : "files"}?`
                          : `Import next ${nf.format(Math.min(maxFiles, plan.will_parse))} of ${nf.format(plan.will_parse)} pending files?`}
                    </strong>
                    <span>
                      {nf.format(plan.new)} new · {nf.format(plan.changed)} changed · refreshes once at job start · source files stay unchanged
                    </span>
                  </div>
                  <div className="button-row">
                    <button className="button-quiet" type="button" onClick={() => setPlanImportMode(null)}>
                      Cancel
                    </button>
                    <button
                      ref={batchConfirmStart}
                      className="button-primary"
                      type="button"
                      disabled={!canImport}
                      onClick={() => {
                        const mode = planImportMode;
                        setPlanImportMode(null);
                        setPlanOpen(false);
                        void runImport(mode);
                      }}
                    >
                      {busy === "import" ? "Starting…" : "Start import"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="plan-page-controls" aria-label="Plan pages">
                    <button
                      className="button-quiet"
                      type="button"
                      disabled={page === 0}
                      onClick={() => setPage((current) => current - 1)}
                    >
                      Previous page
                    </button>
                    <span>Page {page + 1} of {pages}</span>
                    <button
                      className="button-quiet"
                      type="button"
                      disabled={page + 1 >= pages}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next page
                    </button>
                  </div>
                  {canImport && (
                    <div className="plan-import-actions" aria-label="Import batch controls">
                      <label className="plan-batch-control">
                        <span>Files per batch</span>
                        <input
                          type="number"
                          min="1"
                          max={Math.min(100, plan.will_parse)}
                          value={Math.min(maxFiles, plan.will_parse)}
                          onChange={(event) =>
                            setMaxFiles(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                          }
                        />
                      </label>
                      <button className="button-primary" type="button" onClick={() => setPlanImportMode("batch")}>
                        {maxFiles >= plan.will_parse
                          ? `Import ${nf.format(plan.will_parse)} ${plan.will_parse === 1 ? "file" : "files"}`
                          : `Import next ${nf.format(maxFiles)} ${maxFiles === 1 ? "file" : "files"}`}
                      </button>
                      {plan.will_parse > maxFiles && (
                        <button className="button-secondary" type="button" onClick={() => setPlanImportMode("all")}>
                          Import all {nf.format(plan.will_parse)}
                        </button>
                      )}
                    </div>
                  )}
                  {planInspectionMode === "quick" && (
                    <button
                      className="plan-audit-link"
                      type="button"
                      onClick={() => {
                        setPlanImportMode(null);
                        setPlanOpen(false);
                        navigateWorkspace("jobs");
                      }}
                    >
                      Need every file verified? Run full inspection in Jobs →
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
