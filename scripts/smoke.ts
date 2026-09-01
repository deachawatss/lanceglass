import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAB = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(LAB, "fixtures/minimal");
const FILE = join(FIXTURE, "session.jsonl");
const temporary = await mkdtemp(join(tmpdir(), "lanceglass-smoke-"));
const DB_DIR = join(temporary, "lancedb");
const VECTOR_DB_DIR = `${DB_DIR}.vector`;
const environment = { ...process.env, DB_DIR, VECTOR_DB_DIR };
const port = 45_000 + (process.pid % 10_000);
const base = `http://127.0.0.1:${port}`;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`smoke failed: ${message}`);
}

async function run(command: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(command, {
    cwd: LAB,
    env: { ...environment, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
  return { stdout, stderr, value: JSON.parse(stdout) };
}

async function cli(...args: string[]) {
  return (await run(["bun", "src/cli.ts", ...args])).value;
}

async function api<T>(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`API ${path} failed: ${body.error ?? response.status}`);
  return body;
}

let server: ReturnType<typeof Bun.spawn> | null = null;
try {
  console.log("[smoke 01/09] choose database");
  check((await cli("choose")).selected === "LanceDB", "database choice");

  console.log("[smoke 02/09] create isolated database");
  const initialized = await cli("init");
  check(initialized.tables.length === 3, "three tables created");
  check(initialized.databases.vector.tables.length === 0, "init leaves the optional vector store absent");

  server = Bun.spawn(["bun", "src/server.ts"], {
    cwd: LAB,
    env: { ...environment, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      ready = (await fetch(`${base}/api/status`)).ok;
      if (ready) break;
    } catch {}
    await Bun.sleep(50);
  }
  check(ready, "UI API starts");
  const hostileStatus = await fetch(`${base}/api/status`, { headers: { host: "evil.example" } });
  const hostileUi = await fetch(`${base}/`, { headers: { host: "evil.example" } });
  check(hostileStatus.status === 400 && hostileUi.status === 400, "non-local Host cannot read API or UI routes");

  console.log("[smoke 03/09] inspect explicit schema + repository boundary");
  const schemas = await cli("schema");
  check(Object.keys(schemas).sort().join(",") === "event_sources,events,source_files", "schema names");

  console.log("[smoke 04/09] normalize fixture without database writes");
  const normalized = await cli("normalize", "--file", FILE, "--source", "fixture");
  check(normalized.blocks === 5, "five canonical blocks in first fixture");
  check(normalized.corrupt === 1, "corrupt line reported");

  console.log("[smoke 05/09] plan two files with stderr progress, then import one-file batch");
  const planRun = await run(["bun", "src/cli.ts", "plan", "--root", FIXTURE, "--source", "fixture"]);
  const before = planRun.value;
  check(before.found === 2 && before.new === 2 && before.will_parse === 2, "two fixtures start new");
  check(planRun.stderr.includes("[jscan] scan start") && planRun.stderr.includes("[jscan] plan complete"), "plan progress stays on stderr");
  check(!planRun.stdout.includes("[jscan]"), "plan stdout remains JSON-only");
  const query = new URLSearchParams({ root: FIXTURE, source: "fixture" });
  type IntakeResponse = {
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
  const statusBeforeIntake = await api<{ tables: Record<string, number> }>(base, "/api/status");
  const initialIntake = await api<IntakeResponse>(base, `/api/import/intake?${query}`);
  const statusAfterIntake = await api<{ tables: Record<string, number> }>(base, "/api/status");
  check(initialIntake.source === "fixture" && initialIntake.root === FIXTURE, "intake identifies source and root");
  check(!Number.isNaN(Date.parse(initialIntake.checked_at)), "intake includes a checked timestamp");
  check(initialIntake.found === 2 && initialIntake.new === 2 && initialIntake.indexed === 0, "initial intake finds two new files");
  check(initialIntake.changed === 0 && initialIntake.reconcile === 0 && initialIntake.actionable === 2, "initial intake counts are actionable");
  check(JSON.stringify(statusAfterIntake.tables) === JSON.stringify(statusBeforeIntake.tables), "intake endpoint performs no database writes");
  const importRun = await run(
    ["bun", "src/cli.ts", "import", "--root", FIXTURE, "--source", "fixture", "--max-files", "1"],
    { JSCAN_PROGRESS_INTERVAL_MS: "5" },
  );
  const first = importRun.value;
  check(first.selected_files === 1, "first batch selects one file");
  check(first.remaining_files === 1 && first.partial === true, "first batch reports one remaining");
  check(first.inserted === 5 && first.corrupt === 1, "first batch inserts first fixture");
  check(importRun.stderr.includes("[jscan] import start 0/1"), "import phase starts immediately");
  check(importRun.stderr.includes("[jscan] import progress 1/1") && importRun.stderr.includes("records="), "first import item includes live record details");
  check((importRun.stderr.match(/^\[jscan\] import progress 1\/1/gm)?.length ?? 0) >= 2, "timer repeats active import progress during awaited work");
  check(importRun.stderr.includes("[jscan] import complete 1/1"), "import completion is visible");
  check(importRun.stderr.trimEnd().endsWith("corrupt=1"), "heartbeat stops after import completion");
  check(!importRun.stdout.includes("[jscan]"), "import stdout remains parseable JSON only");
  const partialIntake = await api<IntakeResponse>(base, `/api/import/intake?${query}`);
  check(partialIntake.found === 2 && partialIntake.new === 1 && partialIntake.indexed === 1, "partial intake separates new and indexed files");
  check(partialIntake.changed === 0 && partialIntake.reconcile === 0 && partialIntake.actionable === 1, "partial intake keeps actionable count exact");

  console.log("[smoke 06/09] prove partial state before resume");
  const middle = await cli("plan", "--root", FIXTURE, "--source", "fixture");
  check(middle.new === 1 && middle.unchanged === 1 && middle.will_parse === 1, "one file remains after partial import");
  const partialStatus = await cli("status");
  check(partialStatus.counts.events === 5 && partialStatus.counts.source_files === 1, "partial database counts");
  const pluginRun = await run(["bun", "maw-plugin/index.ts", "plan", "--root", FIXTURE, "--source", "fixture"]);
  check(pluginRun.value.will_parse === 1, "plugin CLI stdout remains parseable plan JSON");
  check(pluginRun.stderr.includes("[jscan] scan start") && pluginRun.stderr.includes("[jscan] plan complete"), "plugin preserves child stderr progress");
  check(!pluginRun.stdout.includes("[jscan]"), "plugin does not merge child stderr into stdout");
  const priorDbDir = process.env.DB_DIR;
  process.env.DB_DIR = DB_DIR;
  const handler = (await import("../maw-plugin/index")).default;
  const handlerOutput: string[] = [];
  const handlerErrors: string[] = [];
  const stderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    handlerErrors.push(String(chunk));
    const callback = args.find((value) => typeof value === "function") as
      | ((error?: Error | null) => void)
      | undefined;
    callback?.();
    return true;
  }) as typeof process.stderr.write;
  let handlerResult: Awaited<ReturnType<typeof handler>>;
  let capturedResult: Awaited<ReturnType<typeof handler>>;
  try {
    handlerResult = await handler({
      source: "cli",
      args: ["plan", "--root", FIXTURE, "--source", "fixture"],
      writer: (...values) => handlerOutput.push(values.map(String).join(" ")),
    });
    capturedResult = await handler({
      source: "cli",
      args: ["plan", "--root", FIXTURE, "--source", "fixture"],
    });
  } finally {
    process.stderr.write = stderrWrite;
  }
  if (priorDbDir === undefined) delete process.env.DB_DIR;
  else process.env.DB_DIR = priorDbDir;
  check(handlerResult.ok && JSON.parse(handlerOutput.join("\n")).will_parse === 1, "handler writer receives parseable stdout");
  check(handlerOutput.every((line) => !line.includes("[jscan]")), "handler without errorWriter isolates child stderr");
  check(handlerErrors.some((line) => line.includes("[jscan] scan start")), "handler stderr fallback preserves progress evidence");
  check(capturedResult.ok && JSON.parse(capturedResult.output ?? "").will_parse === 1, "handler capture keeps stdout parseable without writers");
  check(!capturedResult.output?.includes("[jscan]"), "handler capture never merges stderr into output");

  console.log("[smoke 07/09] resume through HTTP import API");
  const apiPlan = await api<{ new: number; unchanged: number; files: unknown[] }>(base, `/api/import/plan?${query}`);
  check(apiPlan.new === 1 && apiPlan.unchanged === 1 && apiPlan.files.length === 2, "plan API exposes file states");
  const resumed = await api<{ selected_files: number; remaining_files: number; partial: boolean; inserted: number }>(base, "/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: FIXTURE, source: "fixture", maxFiles: 1 }),
  });
  check(resumed.selected_files === 1 && resumed.inserted === 2, "resume imports second fixture");
  check(resumed.remaining_files === 0 && resumed.partial === false, "resume completes import");
  const completeIntake = await api<IntakeResponse>(base, `/api/import/intake?${query}`);
  check(completeIntake.found === 2 && completeIntake.new === 0 && completeIntake.indexed === 2, "complete intake recognizes both indexed files");
  check(completeIntake.changed === 0 && completeIntake.reconcile === 0 && completeIntake.actionable === 0, "complete intake has no actionable files");

  console.log("[smoke 08/09] repeat safely and read final rows");
  const jobPlan = await api<{ plan_revision: string; will_parse: number }>(base, `/api/import/plan?${query}`);
  const startedJob = await api<{ id: string; state: string }>(base, "/api/jobs/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "all",
      root: FIXTURE,
      source: "fixture",
      expectedPlanRevision: jobPlan.plan_revision,
      expectedWillParse: jobPlan.will_parse,
    }),
  });
  check(startedJob.state === "running", "job import starts asynchronously");
  let completedJob: { state: string; result?: { selected_files: number; inserted: number } } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const listing = await api<{ jobs: Array<{ id: string; state: string; result?: { selected_files: number; inserted: number } }> }>(base, "/api/jobs");
    completedJob = listing.jobs.find((job) => job.id === startedJob.id);
    if (completedJob && completedJob.state !== "running" && completedJob.state !== "cancelling") break;
    await Bun.sleep(25);
  }
  check(completedJob?.state === "succeeded", "job import completes successfully");
  check(completedJob.result?.selected_files === 0 && completedJob.result.inserted === 0, "all-mode job is idempotent");
  const jobLog = await api<{ next: number; lines: Array<{ stream: string; line: string }> }>(base, `/api/jobs/${startedJob.id}/log?from=0`);
  check(jobLog.next > 0 && jobLog.lines.some((line) => line.stream === "stderr" && line.line.includes("[jscan]")), "job log streams CLI progress");
  const repeated = await api<{ unchanged: number; selected_files: number; inserted: number }>(base, "/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: FIXTURE, source: "fixture", maxFiles: 1 }),
  });
  check(repeated.unchanged === 2 && repeated.selected_files === 0 && repeated.inserted === 0, "repeat is idempotent");
  const finalStatus = await api<{ tables: { events: number; event_sources: number; source_files: number } }>(base, "/api/status");
  check(finalStatus.tables.events === 7, "seven canonical events");
  check(finalStatus.tables.event_sources === 7 && finalStatus.tables.source_files === 2, "final provenance and file counts");
  check((await stat(VECTOR_DB_DIR).catch(() => null)) === null, "ordinary import never creates vector storage");
  type EventResponse = {
    events: Array<{ project: string; file_path?: string; folder?: string }>;
    total: number;
    facets: { projects: []; folders: [] };
  };
  type EventFacetResponse = {
    facets: {
      projects: Array<{ value: string; count: number }>;
      folders: Array<{ value: string; label: string; count: number }>;
    };
  };
  const events = await api<EventResponse>(base, "/api/events?source=fixture&limit=2");
  check(events.events.length === 2 && events.total === 7, "event API reads canonical rows");
  check(events.facets.projects.length === 0 && events.facets.folders.length === 0, "event API does not block rows on facets");
  const facets = await api<EventFacetResponse>(base, "/api/events/facets?source=fixture&project=lanceglass");
  check(facets.facets.projects.some((facet) => facet.value === "lanceglass" && facet.count === 6), "project facets count canonical rows");
  check(facets.facets.folders.some((facet) => facet.value === FIXTURE && facet.label === "minimal" && facet.count === 6), "folder facets count selected-project provenance-backed events");
  check(events.events.every((event) => event.file_path && event.folder === FIXTURE), "event API enriches rows with provenance paths");
  const liveEvents = await api<Omit<EventResponse, "facets">>(base, "/api/events/live?source=fixture&limit=2");
  check(liveEvents.events.length === 2 && liveEvents.total === 7, "bounded live event API reads the current tail");
  check(!("facets" in liveEvents), "live event API skips heavyweight facet construction");

  const projectEvents = await api<EventResponse>(base, "/api/events?source=fixture&project=lanceglass&limit=200");
  check(projectEvents.total === 6 && projectEvents.events.every((event) => event.project === "lanceglass"), "project filter is exact and reports filtered total");
  const folderQuery = new URLSearchParams({ source: "fixture", folder: FIXTURE, limit: "200" });
  const folderEvents = await api<EventResponse>(base, `/api/events?${folderQuery}`);
  check(folderEvents.total === 7 && folderEvents.events.every((event) => event.folder === FIXTURE), "folder filter is exact and preserves matching provenance");

  type HistoryResponse = {
    time_zone: string;
    period: string;
    start: string;
    end: string;
    totals: { events: number; sessions: number; active_days: number };
    days: Array<{
      date: string;
      event_count: number;
      session_count: number;
      groups: Array<{
        source: string;
        project: string;
        folder: string;
        sessions: Array<{ session_id: string }>;
      }>;
    }>;
  };
  const historyQuery = new URLSearchParams({
    period: "day",
    date: "2026-08-30",
    source: "fixture",
  });
  const history = await api<HistoryResponse>(base, `/api/history?${historyQuery}`);
  check(history.time_zone === "Asia/Bangkok" && history.period === "day", "history API declares Bangkok day semantics");
  check(history.start === "2026-08-30" && history.end === "2026-08-30", "history API returns the selected day");
  check(history.totals.events === 7 && history.totals.sessions === 2, "Aug 30 history has seven events across two source-scoped sessions");
  check(history.days.length === 1 && history.days[0].event_count === 7 && history.days[0].session_count === 2, "history day exposes canonical event and distinct session counts");
  const smokeGroup = history.days[0].groups.find((group) => group.project === "lanceglass");
  check(smokeGroup?.source === "fixture" && smokeGroup.folder === FIXTURE, "history groups source, Oracle, and provenance folder exactly");
  const sessionQuery = new URLSearchParams({
    date: "2026-08-30",
    source: "fixture",
    project: "lanceglass",
    folder: FIXTURE,
    session_id: smokeGroup!.sessions[0].session_id,
    limit: "2",
  });
  const historySession = await api<{
    total: number;
    next_offset: number | null;
    events: Array<{ timestamp: string; block_index: number }>;
  }>(base, `/api/history/session?${sessionQuery}`);
  check(historySession.total === 4 && historySession.events.length === 2 && historySession.next_offset === 2, "history session detail is exact and paginated");
  check(historySession.events[0].timestamp <= historySession.events[1].timestamp, "history session detail is chronological");
  const invalidHistory = await fetch(`${base}/api/history?period=quarter&date=2026-08-30`);
  check(invalidHistory.status === 400, "history API rejects an invalid period");

  console.log("[smoke 09/09] serve the production React + Tailwind build");
  const home = await fetch(`${base}/`);
  const html = await home.text();
  check(home.ok && html.includes("Lanceglass"), "built UI document responds");
  check(html.includes("THESIS: Treat agent JSONL as evidence"), "direction contract survives build");
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  check(assetPath, "built UI declares a bundled asset");
  check((await fetch(`${base}${assetPath}`)).ok, "built UI asset responds");

  console.log(`SMOKE PASS · events=7 · partial_remaining=1→0 · repeat_inserted=0 · db=${DB_DIR}`);
} finally {
  server?.kill();
  if (server) await server.exited;
  await rm(temporary, { recursive: true, force: true });
}
