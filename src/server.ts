import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database, defaultVectorDirectoryForSpace, sql } from "./database";
import { EMBEDDING_DEPLOYMENTS } from "./embedding-provider";
import {
  buildHistory,
  buildHistorySession,
  makeHistorySessionSpanKey,
  HistoryInputError,
  UNKNOWN_PROVENANCE_FOLDER,
  historyWindow,
  parseDateKey,
  parseHistoryPeriod,
  todayInBangkok,
} from "./history";
import { importSource, intake, plan } from "./importer";
import { JobManager } from "./jobs";
import { loadEventFacets, loadEventPage } from "./event-browser";
import {
  HistoryVectorInputError,
  HistoryVectorStoreError,
  parseHistoryVectorRequest,
  visualizeHistoryVectors,
  type HistoryVectorDeployment,
} from "./history-vectors";
import { resolveSourceSpec, SOURCE_PRESETS, sourcePreset } from "./sources";
import type { EventRow, EventSourceRow, FilePlan } from "./types";

const PORT = Number(process.env.PORT ?? 4320);
// DB_DIR remains a supported alias for the plain JSONL store. VECTOR_DB_DIR is
// deliberately separate so serving/importing ordinary rows never opens it.
const DB_DIR = process.env.PLAIN_DB_DIR ?? process.env.DB_DIR ?? `${import.meta.dir}/../.data/lancedb`;
const VECTOR_DB_DIR = process.env.VECTOR_DB_DIR ?? `${DB_DIR}.vector`;
const UI_DIR = fileURLToPath(new URL("../ui/dist", import.meta.url));
const FIXTURE_ROOT = sourcePreset("fixture")!.root;
const jobs = new JobManager(DB_DIR);
const HISTORY_CACHE_TTL_MS = 45_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ROOT_LENGTH = 4_096;
const MAX_SOURCE_LENGTH = 128;
const MAX_PROJECT_LENGTH = 512;
const MAX_SESSION_LENGTH = 4_096;
const EVENT_ID_CHUNK_SIZE = 500;

type CacheEntry<T> = {
  value: T;
  version: number;
  expiresAt: number;
};

let historyCacheVersion = 0;
let jobsStateSignature = "";
const historyCache = new Map<string, CacheEntry<unknown>>();
const historySessionCache = new Map<string, CacheEntry<unknown>>();

function cacheKey(parts: string[]) {
  return parts.join("\0");
}

function invalidateHistoryCache() {
  historyCacheVersion += 1;
  historyCache.clear();
  historySessionCache.clear();
}

function getCached<T>(cache: Map<string, CacheEntry<unknown>>, key: string, now: number) {
  const entry = cache.get(key);
  if (!entry || entry.version !== historyCacheVersion || now > entry.expiresAt) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setCached<T>(cache: Map<string, CacheEntry<unknown>>, key: string, value: T, now: number) {
  cache.set(key, {
    value,
    version: historyCacheVersion,
    expiresAt: now + HISTORY_CACHE_TTL_MS,
  });
}

function watchJobsForHistoryCacheInvalidation() {
  const signature = jobs.list().map((job) => `${job.id}:${job.state}`).join("|");
  if (signature !== jobsStateSignature) {
    jobsStateSignature = signature;
    if (!jobs.isBusy()) invalidateHistoryCache();
  }
}

type DatabaseHandle = Awaited<ReturnType<typeof Database.open>>;
type HistoryDateWindow = { start: string; endExclusive: string };
type ScopedSessionSpan = { first: string; last: string };
type ScopedSessionSpanMap = Map<string, ScopedSessionSpan>;
type PlanStateFilter = "all" | "actionable" | FilePlan["state"];

function vectorDirectoryForDeployment(deployment: HistoryVectorDeployment) {
  if (deployment === "dual-4090") {
    return process.env.DUAL_4090_VECTOR_DB_DIR ?? VECTOR_DB_DIR;
  }
  return process.env.CLOUDFLARE_VECTOR_DB_DIR ?? defaultVectorDirectoryForSpace(
    DB_DIR,
    EMBEDDING_DEPLOYMENTS.cloudflare.vectorStoreKey,
  );
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value
  ), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

async function optionalVectorStatus(db: Awaited<ReturnType<typeof Database.open>>) {
  let present: boolean | null = null;
  let tables: string[] = [];
  try {
    present = await db.vector.exists();
    if (!present) {
      return { directory: VECTOR_DB_DIR, present, health: "missing", error: null, tables, event_vectors: 0 };
    }
    tables = await db.vector.tableNames();
    return {
      directory: VECTOR_DB_DIR,
      present,
      health: "healthy",
      error: null,
      tables,
      event_vectors: await db.vector.eventVectors().count(),
    };
  } catch (error) {
    return {
      directory: VECTOR_DB_DIR,
      present,
      health: "error",
      error: error instanceof Error ? error.message : String(error),
      tables,
      event_vectors: null,
    };
  }
}

async function getStatus() {
  const db = await Database.open(DB_DIR, VECTOR_DB_DIR);
  const tableNames = await db.plain.tableNames();
  const tables: Record<string, number> = {
    events: 0,
    event_sources: 0,
    source_files: 0,
  };
  const sources: Record<string, Record<string, number>> = {};

  if (tableNames.includes("events")) tables.events = await db.plain.events().count();
  if (tableNames.includes("event_sources")) tables.event_sources = await db.plain.occurrences().count();
  if (tableNames.includes("source_files")) {
    tables.source_files = await db.plain.files().count();
    const sourceNames = [...new Set((await db.plain.files().list()).map((row) => row.source))];
    for (const source of sourceNames) {
      sources[source] = {
        events: tableNames.includes("events") ? await db.plain.events().count(source) : 0,
        event_sources: tableNames.includes("event_sources") ? await db.plain.occurrences().count(source) : 0,
        source_files: await db.plain.files().count(source),
      };
    }
  }

  const vector = await optionalVectorStatus(db);
  return {
    // Keep db_dir/table counts stable for the existing UI; the explicit
    // `databases` field exposes the physical split for clients that need it.
    db_dir: DB_DIR,
    vector_db_dir: VECTOR_DB_DIR,
    databases: {
      plain: { directory: DB_DIR, tables: tableNames },
      vector,
    },
    fixture_root: FIXTURE_ROOT,
    source_presets: SOURCE_PRESETS,
    tables,
    sources,
  };
}

async function getEvents(source: string, project: string, folder: string, limit: number, signal?: AbortSignal) {
  const db = await Database.open(DB_DIR);
  if (!(await db.plain.tableNames()).includes("events")) {
    return {
      events: [], source, project, folder, limit, total: 0,
      facets: { projects: [], folders: [] },
    };
  }

  return loadEventPage(db.plain, source, project, folder, limit, signal);
}

async function getEventFacets(source: string, project: string, signal?: AbortSignal) {
  const db = await Database.open(DB_DIR);
  if (!(await db.plain.tableNames()).includes("events")) {
    return { source, project, facets: { projects: [], folders: [] } };
  }
  return loadEventFacets(db.plain, source, project, DB_DIR, signal);
}

async function getLiveEvents(source: string, project: string, limit: number) {
  const db = await Database.open(DB_DIR);
  if (!(await db.plain.tableNames()).includes("events")) {
    return { events: [], source, project, folder: "", limit, total: 0 };
  }
  const window = await db.plain.events().latestWindow(source, project, limit);
  return {
    events: window.rows,
    source,
    project,
    folder: "",
    limit,
    total: window.total,
  };
}

function dateToUtcStart(date: string) {
  return `${date}T00:00:00.000Z`;
}

function utcDateExclusive(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return `${value.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function eventKey(event: { source: string; id: string }) {
  return `${event.source}\0${event.id}`;
}

function chunk<T>(values: T[], size = EVENT_ID_CHUNK_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function inClause(column: string, values: string[]) {
  return `${column} IN (${values.map(sql).join(", ")})`;
}

async function queryHistoryRows(
  db: DatabaseHandle,
  source: string,
  project = "",
  sessionId = "",
  window?: HistoryDateWindow,
) {
  const names = await db.plain.tableNames();
  if (!names.includes("events")) return { events: [] as EventRow[], occurrences: [] as EventSourceRow[] };

  const eventTable = await db.plain.connection.openTable("events");
  let eventQuery = eventTable.query();
  const eventPredicates = [
    source && `source = ${sql(source)}`,
    project && `project = ${sql(project)}`,
    sessionId && `session_id = ${sql(sessionId)}`,
    window && `timestamp >= ${sql(window.start)}`,
    window && `timestamp < ${sql(window.endExclusive)}`,
  ].filter(Boolean) as string[];
  if (eventPredicates.length) eventQuery = eventQuery.where(eventPredicates.join(" AND "));
  const eventRows = await eventQuery.select([
    "id",
    "session_id",
    "source",
    "timestamp",
    "project",
    "block_index",
    "block_type",
    "semantic_role",
    "tool_name",
    "text",
  ]).toArray();
  const events = eventRows as unknown as EventRow[];

  let occurrences: EventSourceRow[] = [];
  if (names.includes("event_sources") && events.length > 0) {
    const occurrenceTable = await db.plain.connection.openTable("event_sources");
    const eventIds = [...new Set(events.map((event) => event.id))];
    const sourcePredicates = source ? [`source = ${sql(source)}`] : [];
    const occurrenceRows = await Promise.all(
      chunk(eventIds).map(async (batch) => {
        let occurrenceQuery = occurrenceTable.query();
        const occurrencePredicates = [
          ...sourcePredicates,
          inClause("event_id", batch),
        ];
        if (occurrencePredicates.length) occurrenceQuery = occurrenceQuery.where(occurrencePredicates.join(" AND "));
        return occurrenceQuery.toArray() as PromiseLike<EventSourceRow[]>;
      }),
    );
    occurrences = occurrenceRows.flat() as unknown as EventSourceRow[];
  }

  return { events, occurrences };
}

function occurrenceFolderKeys(
  events: readonly EventRow[],
  occurrences: readonly EventSourceRow[],
) {
  const validEventIds = new Set(events.map((event) => eventKey(event)));
  const foldersByEvent = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    const key = eventKey(occurrence);
    if (!validEventIds.has(key)) continue;
    const folders = foldersByEvent.get(key) ?? new Set<string>();
    folders.add(dirname(occurrence.file_path));
    foldersByEvent.set(key, folders);
  }
  return foldersByEvent;
}

function scopedFoldersForEvent(
  event: Pick<EventRow, "source" | "id">,
  occurrenceFolders: Map<string, Set<string>>,
) {
  return [...(occurrenceFolders.get(eventKey(event)) ?? new Set([UNKNOWN_PROVENANCE_FOLDER]))];
}

async function scopedSessionSpansForHistory(
  db: DatabaseHandle,
  events: readonly EventRow[],
  occurrences: readonly EventSourceRow[],
  window: HistoryDateWindow,
  rangeStart: string,
  rangeEnd: string,
) {
  if (!events.length) return new Map<string, { first: string; last: string }>();

  const occurrenceFolders = occurrenceFolderKeys(events, occurrences);
  const bySourceProject = new Map<string, Map<string, Set<string>>>();
  const spans: ScopedSessionSpanMap = new Map();
  for (const event of events) {
    const folders = scopedFoldersForEvent(event, occurrenceFolders);
    const bucketKey = `${event.source}\0${event.project}`;
    const sessions = bySourceProject.get(bucketKey) ?? new Map<string, Set<string>>();
    const targetFolders = sessions.get(event.session_id) ?? new Set<string>();
    const date = event.timestamp.slice(0, 10);
    for (const folder of folders) targetFolders.add(folder);
    for (const folder of targetFolders) {
      const key = makeHistorySessionSpanKey(event.source, event.project, folder, event.session_id);
      const span = spans.get(key);
      if (!span) spans.set(key, { first: date, last: date });
      else {
        if (date < span.first) span.first = date;
        if (date > span.last) span.last = date;
      }
    }
    sessions.set(event.session_id, targetFolders);
    bySourceProject.set(bucketKey, sessions);
  }

  const beforeMarker = shiftDate(rangeStart, -1);
  const afterMarker = shiftDate(rangeEnd, 1);
  const eventTable = await db.plain.connection.openTable("events");

  for (const [bucketKey, sessions] of bySourceProject) {
    const [source, project] = bucketKey.split("\0");
    const sessionIds = [...sessions.keys()];
    if (!sessionIds.length) continue;

    const beforeRows: EventRow[] = [];
    const afterRows: EventRow[] = [];
    for (const sessionChunk of chunk(sessionIds)) {
      const basePredicates = [
        `source = ${sql(source)}`,
        `project = ${sql(project)}`,
        inClause("session_id", sessionChunk),
      ];
      const beforeRowsChunk = await eventTable
        .query()
        .where([...basePredicates, `timestamp < ${sql(window.start)}`].join(" AND "))
        .select(["source", "project", "session_id", "id", "timestamp"])
        .toArray() as unknown as EventRow[];
      const afterRowsChunk = await eventTable
        .query()
        .where([...basePredicates, `timestamp >= ${sql(window.endExclusive)}`].join(" AND "))
        .select(["source", "project", "session_id", "id", "timestamp"])
        .toArray() as unknown as EventRow[];
      beforeRows.push(...beforeRowsChunk);
      afterRows.push(...afterRowsChunk);
    }

    const markContinues = async (rows: EventRow[], direction: "before" | "after") => {
      if (!rows.length) return;
      const markerByEvent = new Map<string, Set<string>>();
      const rowsBySession = chunk(rows);
      const paths = await Promise.all(
        rowsBySession.map(async (batch) => db.plain.occurrences().pathsForEvents(batch)),
      );
      for (const row of rows) {
        const key = eventKey(row);
        markerByEvent.set(key, new Set<string>());
      }
      for (const row of paths.flat()) {
        const key = eventKey(row);
        const folders = markerByEvent.get(key) ?? new Set<string>();
        folders.add(dirname(row.file_path));
        markerByEvent.set(key, folders);
      }
      for (const event of rows) {
        const targetFolders = sessions.get(event.session_id);
        if (!targetFolders || !targetFolders.size) continue;
        const eventFolders = markerByEvent.get(eventKey(event));
        const folders = eventFolders && eventFolders.size
          ? eventFolders
          : new Set([UNKNOWN_PROVENANCE_FOLDER]);
        for (const folder of folders) {
          if (!targetFolders.has(folder)) continue;
          const key = makeHistorySessionSpanKey(event.source, event.project, folder, event.session_id);
          const span = spans.get(key);
          if (!span) continue;
          if (direction === "before") span.first = beforeMarker;
          else span.last = afterMarker;
        }
      }
    };

    await Promise.all([
      markContinues(beforeRows, "before"),
      markContinues(afterRows, "after"),
    ]);
  }
  return spans;
}

function shiftDate(value: string, deltaDays: number) {
  const valueDate = new Date(`${value}T00:00:00.000Z`);
  valueDate.setUTCDate(valueDate.getUTCDate() + deltaDays);
  return valueDate.toISOString().slice(0, 10);
}

async function historyRows(
  source: string,
  project = "",
  sessionId = "",
  window?: HistoryDateWindow,
) {
  const db = await Database.open(DB_DIR);
  return queryHistoryRows(db, source, project, sessionId, window);
}

async function getHistoryRowsForWindow(url: URL) {
  const filters = historyFilters(url);
  const period = parseHistoryPeriod((url.searchParams.get("period") ?? "week").trim());
  const date = parseDateKey((url.searchParams.get("date") ?? todayInBangkok()).trim());
  const today = todayInBangkok();
  const range = historyWindow(period, date, today);
  const window = {
    start: dateToUtcStart(range.start),
    endExclusive: utcDateExclusive(range.end),
  };
  const db = await Database.open(DB_DIR);
  const rows = await queryHistoryRows(
    db,
    filters.source,
    filters.project,
    "",
    window,
  );
  const shouldUseContinuationSpans = filters.project || filters.folder
    ? rows.events.length <= 1_500
    : false;
  return {
    ...rows,
    filters,
    period,
    date,
    today,
    sessionSpans: shouldUseContinuationSpans
      ? await scopedSessionSpansForHistory(
        db,
        rows.events,
        rows.occurrences,
        window,
        range.start,
        range.end,
      )
      : undefined,
  };
}

function historyFilters(url: URL) {
  return {
    source: boundedText(url.searchParams.get("source") ?? "", "source", MAX_SOURCE_LENGTH),
    project: boundedText(url.searchParams.get("project") ?? "", "project", MAX_PROJECT_LENGTH),
    folder: boundedText(url.searchParams.get("folder") ?? "", "folder", MAX_ROOT_LENGTH),
  };
}

async function getHistory(url: URL) {
  const now = Date.now();
  const {
    date,
    today,
    period,
    events,
    occurrences,
    filters,
    sessionSpans,
  } = await getHistoryRowsForWindow(url);
  if (!jobs.isBusy()) {
    const key = cacheKey([
      "history",
      period,
      date,
      today,
      filters.source,
      filters.project,
      filters.folder,
    ]);
    const cached = getCached<ReturnType<typeof buildHistory>>(historyCache, key, now);
    if (cached) return cached;
    const response = buildHistory(events, occurrences, { period, date, today, ...filters, sessionSpans });
    setCached(historyCache, key, response, now);
    return response;
  }
  return buildHistory(events, occurrences, { period, date, today, ...filters, sessionSpans });
}

function requiredHistoryText(url: URL, name: string, max: number) {
  if (!url.searchParams.has(name)) throw new HttpError(400, `${name} is required`);
  const value = boundedText(url.searchParams.get(name), name, max);
  if (!value) throw new HttpError(400, `${name} is required`);
  return value;
}

async function getHistorySession(url: URL) {
  const date = parseDateKey(requiredHistoryText(url, "date", 10));
  historyWindow("day", date);
  const filters = {
    source: requiredHistoryText(url, "source", MAX_SOURCE_LENGTH),
    project: requiredHistoryText(url, "project", MAX_PROJECT_LENGTH),
    folder: requiredHistoryText(url, "folder", MAX_ROOT_LENGTH),
  };
  const session_id = requiredHistoryText(url, "session_id", MAX_SESSION_LENGTH);
  const rawOffset = url.searchParams.get("offset") ?? "0";
  const rawLimit = url.searchParams.get("limit") ?? "200";
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  const now = Date.now();
  const cacheable = !jobs.isBusy();
  const sessionCacheKey = cacheKey([
    "history-session",
    date,
    filters.source,
    filters.project,
    filters.folder,
    session_id,
    String(offset),
    String(limit),
  ]);
  if (cacheable) {
    const cached = getCached<ReturnType<typeof buildHistorySession>>(historySessionCache, sessionCacheKey, now);
    if (cached) return cached;
  }
  const { events, occurrences } = await historyRows(filters.source, filters.project, session_id);
  const response = buildHistorySession(events, occurrences, {
    date,
    session_id,
    offset,
    limit,
    ...filters,
  });
  if (cacheable) setCached(historySessionCache, sessionCacheKey, response, now);
  return response;
}

async function getHistoryVectorVisualization(url: URL) {
  const request = parseHistoryVectorRequest(url);
  const deployment = EMBEDDING_DEPLOYMENTS[request.deployment];
  const db = await Database.open(
    DB_DIR,
    vectorDirectoryForDeployment(request.deployment),
    deployment.config.space,
  );
  return visualizeHistoryVectors(db.plain, db.vector, request);
}

function sourceSpec(url: URL) {
  const root = (url.searchParams.get("root") ?? "").trim();
  const source = (url.searchParams.get("source") ?? "").trim();
  return resolveSourceSpec(root, source);
}

function boundedText(value: unknown, name: string, max: number) {
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  const result = value.trim();
  if (result.length > max || result.includes("\0")) {
    throw new HttpError(400, `${name} is too long or contains invalid characters`);
  }
  return result;
}

function parsePlanStateFilter(raw: string | null) {
  if (!raw) return "all";
  const state = raw.trim() as PlanStateFilter;
  if (state === "all" || state === "actionable") return state;
  if (state === "new" || state === "changed" || state === "unchanged" || state === "shrunk") return state;
  throw new HttpError(400, `invalid plan filter: ${raw}`);
}

function parsePlanCompareMode(raw: string | null) {
  if (!raw) return "full";
  const mode = raw.trim();
  if (mode === "full" || mode === "metadata") return mode;
  throw new HttpError(400, `invalid plan compare mode: ${raw}`);
}

function planStateSelection(filter: PlanStateFilter) {
  if (filter === "all") return undefined;
  if (filter === "actionable") return ["new", "changed", "shrunk"] as const;
  return [filter];
}

function validateLocalHost(url: URL) {
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]" && hostname !== "::1") {
    throw new HttpError(400, "requests require a local Host");
  }
}

function validateMutation(request: Request, url: URL) {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(400, "cross-origin mutation rejected");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(400, "application/json is required");
}

async function jsonBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(400, "request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(400, "request body is too large");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}

function requestSpec(body: Record<string, unknown>) {
  const root = boundedText(body.root ?? "", "root", MAX_ROOT_LENGTH);
  const source = boundedText(body.source ?? "", "source", MAX_SOURCE_LENGTH);
  return resolveSourceSpec(root, source);
}

async function importRequest(request: Request) {
  const body = await jsonBody(request);
  const maxFiles = Number(body.maxFiles);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
    throw new HttpError(400, "maxFiles must be an integer from 1 to 100");
  }
  invalidateHistoryCache();
  const db = await Database.open(DB_DIR);
  return importSource(db.plain, requestSpec(body), { maxFiles });
}

async function startJobRequest(request: Request) {
  const body = await jsonBody(request);
  const mode = body.mode;
  if (mode !== "batch" && mode !== "all") throw new HttpError(400, "mode must be batch or all");
  const expectedPlanRevision = boundedText(
    body.expectedPlanRevision ?? body.expected_plan_revision ?? body.plan_revision,
    "expectedPlanRevision",
    128,
  );
  if (!expectedPlanRevision) throw new HttpError(400, "expectedPlanRevision is required");
  const expectedWillParse = Number(body.expectedWillParse ?? body.expected_will_parse ?? body.will_parse);
  if (!Number.isInteger(expectedWillParse) || expectedWillParse < 0) {
    throw new HttpError(400, "expectedWillParse must be a non-negative integer");
  }
  const planPolicy = body.planPolicy ?? body.plan_policy ?? "exact";
  if (planPolicy !== "exact" && planPolicy !== "refresh") {
    throw new HttpError(400, "planPolicy must be exact or refresh");
  }
  let maxFiles: number | undefined;
  if (mode === "batch") {
    maxFiles = Number(body.maxFiles);
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
      throw new HttpError(400, "batch maxFiles must be an integer from 1 to 100");
    }
  } else if (body.maxFiles !== undefined) {
    throw new HttpError(400, "all mode must not include maxFiles");
  }
  const started = jobs.start({
    mode,
    spec: requestSpec(body),
    expectedPlanRevision,
    expectedWillParse,
    planPolicy,
    maxFiles,
  });
  if (!started) throw new HttpError(409, "an import writer is already active", { active_id: jobs.activeId ?? null });
  invalidateHistoryCache();
  return started;
}

function staticFile(pathname: string) {
  const relative = pathname === "/"
    ? "index.html"
    : decodeURIComponent(pathname).replace(/^\/+/, "");
  const path = resolve(UI_DIR, relative);
  if (path !== UI_DIR && !path.startsWith(`${UI_DIR}/`)) return null;
  return path;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 255,
  async fetch(request: Request) {
    const url = new URL(request.url);
    watchJobsForHistoryCacheInvalidation();

    try {
      validateLocalHost(url);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/")) {
        const path = staticFile("/")!;
        const file = Bun.file(path);
        if (!(await file.exists())) {
          return json({ error: "UI build missing; run bun run ui:build" }, 503);
        }
        return new Response(file, {
          headers: { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(await getStatus());
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
          : 50;
        const source = (url.searchParams.get("source") ?? "").trim();
        const project = (url.searchParams.get("project") ?? "").trim();
        const folder = (url.searchParams.get("folder") ?? "").trim();
        return json(await getEvents(source, project, folder, limit, request.signal));
      }
      if (request.method === "GET" && url.pathname === "/api/events/facets") {
        const source = boundedText(url.searchParams.get("source") ?? "", "source", MAX_SOURCE_LENGTH);
        const project = boundedText(url.searchParams.get("project") ?? "", "project", MAX_PROJECT_LENGTH);
        return json(await getEventFacets(source, project, request.signal));
      }
      if (request.method === "GET" && url.pathname === "/api/events/live") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
          : 50;
        const source = (url.searchParams.get("source") ?? "").trim();
        const project = (url.searchParams.get("project") ?? "").trim();
        return json(await getLiveEvents(source, project, limit));
      }
      if (request.method === "GET" && url.pathname === "/api/history") {
        return json(await getHistory(url));
      }
      if (request.method === "GET" && url.pathname === "/api/history/session") {
        return json(await getHistorySession(url));
      }
      if (request.method === "GET" && url.pathname === "/api/vectors/visualize") {
        return json(await getHistoryVectorVisualization(url));
      }
      if (request.method === "GET" && url.pathname === "/api/import/plan") {
        const db = await Database.open(DB_DIR);
        const planFilter = parsePlanStateFilter(url.searchParams.get("plan_state"));
        const compareMode = parsePlanCompareMode(url.searchParams.get("compare"));
        return json(await plan(db.plain, sourceSpec(url), undefined, {
          fileStates: planStateSelection(planFilter),
          compareMode,
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/import/intake") {
        const db = await Database.open(DB_DIR);
        return json(await intake(db.plain, sourceSpec(url)));
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        validateMutation(request, url);
        if (!jobs.tryAcquireSync()) {
          throw new HttpError(409, "an import writer is already active", { active_id: jobs.activeId ?? null });
        }
        try {
          return json(await importRequest(request));
        } finally {
          jobs.releaseSync();
        }
      }
      if (request.method === "POST" && url.pathname === "/api/jobs/import") {
        validateMutation(request, url);
        return json(await startJobRequest(request), 202);
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        return json({ jobs: jobs.list(), active_id: jobs.activeId ?? null });
      }
      const jobLog = url.pathname.match(/^\/api\/jobs\/([^/]+)\/log$/);
      if (request.method === "GET" && jobLog) {
        const rawFrom = url.searchParams.get("from") ?? "0";
        const from = Number(rawFrom);
        if (!Number.isInteger(from) || from < 0) throw new HttpError(400, "from must be a non-negative integer");
        const result = jobs.logs(decodeURIComponent(jobLog[1]), from);
        if (!result) throw new HttpError(404, "job not found");
        return json(result);
      }
      const jobCancel = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (request.method === "POST" && jobCancel) {
        validateMutation(request, url);
        await jsonBody(request);
        const id = decodeURIComponent(jobCancel[1]);
        const existing = jobs.get(id);
        if (!existing) throw new HttpError(404, "job not found");
        if (existing.state !== "running" && existing.state !== "cancelling") {
          throw new HttpError(409, `job is already ${existing.state}`);
        }
        return json(jobs.cancel(id), 202);
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const path = staticFile(url.pathname);
        if (!path) return json({ error: "not found" }, 404);
        const file = Bun.file(path);
        if (!(await file.exists())) return json({ error: "not found" }, 404);
        return new Response(file, {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
          },
        });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpError) return json({ error: message, ...error.details }, error.status);
      if (error instanceof HistoryInputError) return json({ error: message }, 400);
      if (error instanceof HistoryVectorInputError) return json({ error: message }, 400);
      if (error instanceof HistoryVectorStoreError) return json({ error: message }, 422);
      return json({ error: message, db_dir: DB_DIR }, 500);
    }
  },
});

console.log(`Lanceglass: http://${server.hostname}:${server.port}`);
console.log(`LanceDB: ${DB_DIR}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.stop(false);
  await jobs.shutdown();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
