type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };
type DemoEvent = {
  id: string; timestamp: string; project: string; block_type: string;
  semantic_role: string; source: string; text: string; file_path: string;
  folder: string; session_id: string; block_index: number; tool_name: string;
};

const DEMO_ROOT = "/demo/fixtures/jsonl";
const DEMO_DATE = "2026-09-01";
const PROJECTS = ["lanceglass", "atlas-oracle", "neo-oracle", "pulse-oracle"];
const SOURCES = ["claude", "codex"];
const ROLES = ["human_intent", "assistant_answer", "tool_action", "tool_evidence", "summary"];
const EVENT_DATES = ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"];
const COPY = [
  "How do we import JSONL and know whether it is new?",
  "Use a source-file manifest plus stable event UUID and block identity.",
  '{"command":"maw jscan import --root fixtures/minimal --source fixture"}',
  "Scan complete: metadata matched the canonical source-file ledger.",
  "Created a typed, local-first JSONL database lab.",
  "Map one embedding provider per vector space; never mix dimensions.",
  "History groups sessions by Bangkok day, project, source, and directory.",
  "The browser can switch between stream, history, jobs, and vector maps.",
];

const events: DemoEvent[] = Array.from({ length: 1000 }, (_, index) => {
  const source = SOURCES[index % SOURCES.length]!;
  const project = PROJECTS[Math.floor(index / 11) % PROJECTS.length]!;
  const eventDate = EVENT_DATES[Math.floor(index / 145) % EVENT_DATES.length]!;
  const day = eventDate.slice(-2);
  const hour = 1 + (Math.floor(index / 7) % 15);
  const semantic_role = ROLES[index % ROLES.length]!;
  const block_type = semantic_role === "tool_action" ? "tool_use"
    : semantic_role === "tool_evidence" ? "tool_result"
    : semantic_role === "summary" ? "summary" : "text";
  const session_id = `${source}-${project}-${day}-${Math.floor((index % 145) / 12)}`;
  const folder = `/demo/oracles/${project}`;
  return {
    id: `demo-${String(index + 1).padStart(4, "0")}`,
    timestamp: `${eventDate}T${String(hour).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    project, block_type, semantic_role, source,
    text: `${COPY[index % COPY.length]} · synthetic event ${String(index + 1).padStart(4, "0")}`,
    file_path: `${folder}/${session_id}.jsonl`, folder, session_id,
    block_index: index % 12, tool_name: block_type.startsWith("tool_") ? "Bash" : "",
  };
}).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

const files = Array.from({ length: 36 }, (_, index) => ({
  id: `file-${index + 1}`, source: index % 2 ? "codex" : "claude",
  path: `${DEMO_ROOT}/${PROJECTS[index % PROJECTS.length]}/session-${String(index + 1).padStart(2, "0")}.jsonl`,
  size: 18_000 + index * 913,
  mtimeMs: Date.parse(`2026-08-${String(26 + (index % 6)).padStart(2, "0")}T12:00:00Z`),
  state: index < 2 ? "new" : index < 6 ? "changed" : "unchanged",
}));

const JOB_ID = "static-demo-import";
const report = {
  plan_revision: "static-fixture-v1", source: "claude", root: DEMO_ROOT,
  found: 18, new: 1, changed: 2, unchanged: 15, shrunk: 0, will_parse: 3,
  selected_files: 3, remaining_files: 0, partial: false, parsed_records: 180,
  blocks: 244, inserted: 0, duplicates: 244, occurrences_inserted: 244, corrupt: 0,
};
const job = {
  id: JOB_ID, name: "Static fixture import", mode: "all", root: DEMO_ROOT,
  source: "claude", running: false, state: "succeeded", code: 0,
  started: "2026-09-01T03:10:00.000Z", ended: "2026-09-01T03:10:01.420Z",
  elapsed_ms: 1420, last: "[demo] Static fixtures inspected; no storage was mutated.", result: report,
};
const log = [
  "[demo] Static mode: no filesystem, KV, D1, or LanceDB writes.",
  `[jscan] scan complete ${files.length}/${files.length} ${DEMO_ROOT}`,
  "[jscan] plan complete 36/36",
  "[jscan] import progress 3/3 records=180 blocks=244",
  "[demo] Simulation complete. Refreshing restores the same fixtures.",
];

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-lanceglass-demo": "static-fixture" },
});

function scopedEvents(url: URL) {
  const source = url.searchParams.get("source")?.trim() ?? "";
  const project = url.searchParams.get("project")?.trim() ?? "";
  const folder = url.searchParams.get("folder")?.trim() ?? "";
  return events.filter((row) => (!source || row.source === source)
    && (!project || row.project === project) && (!folder || row.folder === folder));
}

function facets(url: URL) {
  const source = url.searchParams.get("source")?.trim() ?? "";
  const project = url.searchParams.get("project")?.trim() ?? "";
  const scoped = events.filter((row) => !source || row.source === source);
  const count = (rows: DemoEvent[], key: "project" | "folder") => {
    const values = new Map<string, number>();
    rows.forEach((row) => values.set(row[key], (values.get(row[key]) ?? 0) + 1));
    return [...values].map(([value, total]) => key === "folder"
      ? { value, count: total, label: value.split("/").slice(-2).join("/") }
      : { value, count: total }).sort((a, b) => b.count - a.count);
  };
  return { projects: count(scoped, "project"), folders: count(scoped.filter((row) => !project || row.project === project), "folder") };
}

function dateKey(timestamp: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}
function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function windowFor(period: string, anchor: string) {
  if (period === "day") return { start: anchor, end: anchor };
  if (period === "month") {
    const date = new Date(`${anchor}T00:00:00Z`);
    const start = `${anchor.slice(0, 7)}-01`;
    const naturalEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { start, end: DEMO_DATE >= start && DEMO_DATE <= naturalEnd ? DEMO_DATE : naturalEnd };
  }
  const weekday = new Date(`${anchor}T00:00:00Z`).getUTCDay();
  const start = shiftDate(anchor, -(weekday === 0 ? 6 : weekday - 1));
  const naturalEnd = shiftDate(start, 6);
  return { start, end: DEMO_DATE >= start && DEMO_DATE <= naturalEnd ? DEMO_DATE : naturalEnd };
}

function history(url: URL) {
  const period = url.searchParams.get("period") ?? "week";
  const anchor = url.searchParams.get("date") ?? DEMO_DATE;
  const source = url.searchParams.get("source")?.trim() ?? "";
  const project = url.searchParams.get("project")?.trim() ?? "";
  const folder = url.searchParams.get("folder")?.trim() ?? "";
  const range = windowFor(period, anchor);
  const scoped = scopedEvents(url).filter((row) => dateKey(row.timestamp) >= range.start && dateKey(row.timestamp) <= range.end);
  const days = [];
  for (let date = range.start; date <= range.end; date = shiftDate(date, 1)) {
    const dayEvents = scoped.filter((row) => dateKey(row.timestamp) === date);
    const byGroup = new Map<string, DemoEvent[]>();
    dayEvents.forEach((row) => {
      const key = `${row.source}\0${row.project}\0${row.folder}`;
      byGroup.set(key, [...(byGroup.get(key) ?? []), row]);
    });
    const groups = [...byGroup.values()].map((rows) => {
      const bySession = new Map<string, DemoEvent[]>();
      rows.forEach((row) => bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row]));
      const first = rows[0]!;
      return {
        source: first.source, project: first.project, folder: first.folder,
        event_count: rows.length, session_count: bySession.size,
        sessions: [...bySession.values()].map((session) => {
          const ordered = [...session].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          const preview = ordered.find((row) => row.semantic_role === "human_intent") ?? ordered[0]!;
          return { session_id: ordered[0]!.session_id, source: ordered[0]!.source,
            project: ordered[0]!.project, folder: ordered[0]!.folder,
            started_at: ordered[0]!.timestamp, ended_at: ordered.at(-1)!.timestamp,
            event_count: ordered.length, preview: preview.text, continues_before: false, continues_after: false };
        }),
      };
    });
    days.push({ date, event_count: dayEvents.length, session_count: new Set(dayEvents.map((row) => `${row.source}\0${row.session_id}`)).size, groups });
  }
  return { time_zone: "Asia/Bangkok", period, date: anchor, anchor, ...range, source, project, folder,
    totals: { days: days.length, active_days: days.filter((day) => day.event_count).length,
      events: scoped.length, sessions: new Set(scoped.map((row) => `${row.source}\0${row.session_id}`)).size,
      sources: new Set(scoped.map((row) => row.source)).size, projects: new Set(scoped.map((row) => row.project)).size,
      folders: new Set(scoped.map((row) => row.folder)).size }, days };
}

function session(url: URL) {
  const date = url.searchParams.get("date") ?? DEMO_DATE;
  const source = url.searchParams.get("source") ?? "";
  const project = url.searchParams.get("project") ?? "";
  const folder = url.searchParams.get("folder") ?? "";
  const session_id = url.searchParams.get("session_id") ?? "";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
  const rows = events.filter((row) => row.source === source && row.project === project && row.folder === folder && row.session_id === session_id)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const page = rows.slice(offset, offset + limit); const next = offset + page.length;
  return { time_zone: "Asia/Bangkok", date, source, project, folder, session_id, offset, limit,
    total: rows.length, selected_day_events: rows.filter((row) => dateKey(row.timestamp) === date).length,
    next_offset: next < rows.length ? next : null,
    events: page.map(({ id, timestamp, block_index, block_type, semantic_role, tool_name, text }) => ({ id, timestamp, block_index, block_type, semantic_role, tool_name, text })) };
}

function vector(url: URL) {
  const deployment = url.searchParams.get("deployment") ?? "dual-4090";
  const session_id = url.searchParams.get("session_id") ?? "";
  const rows = events.filter((row) => !session_id || row.session_id === session_id).slice(0, 72);
  return { available: true, deployment,
    space: { id: `${deployment}:demo-384:v1`, provider: deployment, model: "demo-embedding-384", revision: "static-v1", dimension: 384, distance: "cosine", text_policy: "synthetic-preview" },
    scope: { date: url.searchParams.get("date") ?? DEMO_DATE, source: url.searchParams.get("source") ?? "", project: url.searchParams.get("project") ?? "", folder: url.searchParams.get("folder") ?? "", session_id, actors: url.searchParams.getAll("actor") },
    coverage: { eligible: rows.length, embedded: rows.length, missing: 0, sampled: rows.length },
    projection: { method: "static-demo-orbit", explained_variance: 0.82 },
    points: rows.map((row, index) => { const angle = index * 0.73; const radius = 0.25 + (index % 9) * 0.075;
      return { event_id: row.id, timestamp: row.timestamp, block_type: row.block_type, semantic_role: row.semantic_role,
        tool_name: row.tool_name, text_preview: row.text, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: Math.sin(angle * 0.43) * 0.72 };
    }) };
}

function plan(url: URL) {
  const source = url.searchParams.get("source")?.trim() || "claude";
  const root = url.searchParams.get("root")?.trim() || DEMO_ROOT;
  const scoped = files.filter((file) => file.source === source);
  const requested = url.searchParams.get("plan_state") ?? "all";
  const selected = requested === "actionable" ? scoped.filter((file) => file.state !== "unchanged") : scoped;
  return { plan_revision: "static-fixture-v1", source, root, found: scoped.length,
    new: scoped.filter((file) => file.state === "new").length,
    changed: scoped.filter((file) => file.state === "changed").length,
    unchanged: scoped.filter((file) => file.state === "unchanged").length, shrunk: 0,
    will_parse: scoped.filter((file) => file.state !== "unchanged").length, files: selected };
}

export const demoWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url); const path = url.pathname;
    if (path === "/health") return json({ ok: true, service: "lanceglass", mode: "static-fixture", storage: "none" });
    if (path === "/api/status") return json({
      demo: { enabled: true, label: "Static fixture demo", storage: "none", persistence: "none" },
      db_dir: "static fixture · no database attached", vector_db_dir: "static fixture · synthetic projection",
      databases: { plain: { directory: "bundled fixture", tables: ["events", "event_sources", "source_files"] } },
      fixture_root: DEMO_ROOT,
      source_presets: [{ id: "claude", label: "Claude fixture", root: DEMO_ROOT, default: true }, { id: "codex", label: "Codex fixture", root: DEMO_ROOT }],
      tables: { events: events.length, event_sources: events.length, source_files: files.length },
      sources: Object.fromEntries(SOURCES.map((source) => [source, { events: events.filter((row) => row.source === source).length,
        event_sources: events.filter((row) => row.source === source).length, source_files: files.filter((file) => file.source === source).length }])) });
    if (path === "/api/events" || path === "/api/events/live") {
      const rows = scopedEvents(url); const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const body = { events: rows.slice(0, limit), source: url.searchParams.get("source") ?? "", project: url.searchParams.get("project") ?? "", folder: url.searchParams.get("folder") ?? "", limit, total: rows.length };
      return json(path.endsWith("/live") ? body : { ...body, facets: facets(url) });
    }
    if (path === "/api/events/facets") return json({ facets: facets(url) });
    if (path === "/api/import/intake") { const value = plan(url); return json({ source: value.source, root: value.root, checked_at: new Date().toISOString(), found: value.found, new: value.new, changed: value.changed, indexed: value.unchanged, reconcile: 0, actionable: value.will_parse }); }
    if (path === "/api/import/plan") return json(plan(url));
    if (path === "/api/history") return json(history(url));
    if (path === "/api/history/session") return json(session(url));
    if (path === "/api/vectors/visualize") return json(vector(url));
    if (path === "/api/jobs") return json({ jobs: [job], active_id: null });
    if (path === `/api/jobs/${JOB_ID}/log`) { const from = Math.max(0, Number(url.searchParams.get("from") ?? 0)); return json({ offset: from, from, next: log.length, truncated: false, lines: log.slice(from), running: false, state: "succeeded", code: 0, result: report, job }); }
    if (request.method === "POST" && path === "/api/jobs/import") return json({ started: true, id: JOB_ID, demo: true }, 202);
    if (request.method === "POST" && path === "/api/import") return json({ ...report, demo: true });
    if (request.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) return json({ error: "Static demo jobs are immutable." }, 409);
    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export default demoWorker;
