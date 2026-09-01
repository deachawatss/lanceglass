import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { PlainDatabase, sql } from "./database";
import { createNormalizationState, normalize, sha256 } from "./normalize";
import type {
  EventRow,
  EventSourceRow,
  FilePlan,
  ImportOptions,
  IntakeReport,
  ProgressCallback,
  ImportReport,
  PlanReport,
  SourceFileRow,
  SourceSpec,
} from "./types";

type PlanOptions = {
  fileStates?: ReadonlyArray<FilePlan["state"]>;
  compareMode?: "full" | "metadata";
};

async function hashFile(path: string, heartbeat?: () => void) {
  const hash = createHash("sha256");
  let lastHeartbeatAt = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    const now = Date.now();
    if (heartbeat && now - lastHeartbeatAt >= 250) {
      lastHeartbeatAt = now;
      heartbeat();
    }
  }
  return hash.digest("hex");
}

const MEMORY_SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const CROSS_FILE_BATCH_LIMIT = 16 * 1024 * 1024;
const CROSS_FILE_ROW_LIMIT = 5_000;
const CROSS_FILE_FILE_LIMIT = 256;

type ImportLockOwner = { token?: unknown; pid?: unknown; started_at?: unknown };

async function readImportLockOwner(path: string): Promise<ImportLockOwner | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as ImportLockOwner; }
  catch { return undefined; }
}

async function acquireImportLock(db: PlainDatabase) {
  const lockPath = `${db.directory}.import.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const candidatePath = `${lockPath}.${token}.candidate`;
  await writeFile(candidatePath, JSON.stringify({
    token, pid: process.pid, started_at: new Date().toISOString(),
  }), { flag: "wx" });
  try {
    await link(candidatePath, lockPath);
  } catch (error) {
    await unlink(candidatePath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readImportLockOwner(lockPath);
    const pid = Number.isInteger(owner?.pid) ? ` (pid ${owner!.pid})` : "";
    throw new Error(
      `plain database import writer is already active for ${db.directory}${pid}; ` +
      `wait for it to finish or manually remove ${lockPath} after verifying the owner is gone`,
    );
  }
  await unlink(candidatePath).catch(() => {});
  return async () => {
    if ((await readImportLockOwner(lockPath))?.token === token) {
      await unlink(lockPath).catch(() => {});
    }
  };
}

async function snapshotFile(path: string, size: number, heartbeat?: () => void) {
  if (size <= MEMORY_SNAPSHOT_LIMIT) {
    const source = await open(path, "r");
    try {
      const sourceInfo = await source.stat();
      if (!sourceInfo.isFile() || sourceInfo.size < size) {
        throw new Error(`JSONL file changed before snapshot: ${path}`);
      }
      const buffer = Buffer.allocUnsafe(size);
      let position = 0;
      let lastHeartbeatAt = 0;
      while (position < size) {
        const { bytesRead } = await source.read(buffer, position, size - position, position);
        if (!bytesRead) throw new Error(`JSONL file changed during snapshot: ${path}`);
        position += bytesRead;
        const now = Date.now();
        if (heartbeat && now - lastHeartbeatAt >= 250) {
          lastHeartbeatAt = now;
          heartbeat();
        }
      }
      return {
        input: () => Readable.from([buffer]),
        sha256: createHash("sha256").update(buffer).digest("hex"),
        cleanup: async () => {},
      };
    } finally {
      await source.close();
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "jscan-snapshot-"));
  const snapshotPath = join(directory, "source.jsonl");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 1024 * 1024));
  let position = 0;
  let lastHeartbeatAt = 0;

  try {
    const source = await open(path, "r");
    try {
      const snapshot = await open(snapshotPath, "wx");
      try {
        const sourceInfo = await source.stat();
        if (!sourceInfo.isFile() || sourceInfo.size < size) {
          throw new Error(`JSONL file changed before snapshot: ${path}`);
        }

        while (position < size) {
          const length = Math.min(buffer.length, size - position);
          const { bytesRead } = await source.read(buffer, 0, length, position);
          if (!bytesRead) throw new Error(`JSONL file changed during snapshot: ${path}`);
          hash.update(buffer.subarray(0, bytesRead));

          let written = 0;
          while (written < bytesRead) {
            const result = await snapshot.write(
              buffer,
              written,
              bytesRead - written,
              position + written,
            );
            written += result.bytesWritten;
          }
          position += bytesRead;

          const now = Date.now();
          if (heartbeat && now - lastHeartbeatAt >= 250) {
            lastHeartbeatAt = now;
            heartbeat();
          }
        }
      } finally {
        await snapshot.close();
      }
    } finally {
      await source.close();
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    input: () => createReadStream(snapshotPath),
    sha256: hash.digest("hex"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function discover(spec: SourceSpec, onProgress?: ProgressCallback) {
  const root = resolve(spec.root);
  onProgress?.({ phase: "scan", status: "start", current: 0, path: root });
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`invalid JSONL root: ${root}`);

  const pending = [root];
  const files: Omit<FilePlan, "state">[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
        const info = await stat(path);
        files.push({
          id: sha256(`${spec.source}\0${path}`),
          source: spec.source,
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
        onProgress?.({
          phase: "scan",
          status: "progress",
          current: files.length,
          path,
        });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  onProgress?.({ phase: "scan", status: "complete", current: files.length, total: files.length, path: root });
  return files;
}

export async function intake(db: PlainDatabase, spec: SourceSpec): Promise<IntakeReport> {
  const files = await discover(spec);
  const tableNames = await db.tableNames();
  const known = tableNames.includes("source_files")
    ? new Map(((await (await db.connection.openTable("source_files"))
      .query().where(`source = ${sql(spec.source)}`).toArray()) as unknown as SourceFileRow[])
      .map((row) => [row.id, row]))
    : new Map<string, SourceFileRow>();
  let newFiles = 0;
  let changed = 0;
  let indexed = 0;
  let reconcile = 0;

  for (const file of files) {
    const previous = known.get(file.id);
    if (!previous) {
      newFiles++;
      continue;
    }

    indexed++;
    if (
      previous.state === "pending" ||
      previous.state === "requires_reconcile" ||
      previous.state === "failed" ||
      file.size < previous.size
    ) {
      reconcile++;
    } else if (file.size !== previous.size || file.mtimeMs !== previous.mtime_ms) {
      changed++;
    }
  }

  return {
    source: spec.source,
    root: resolve(spec.root),
    checked_at: new Date().toISOString(),
    found: files.length,
    new: newFiles,
    changed,
    indexed,
    reconcile,
    actionable: newFiles + changed + reconcile,
  };
}

export async function plan(
  db: PlainDatabase,
  spec: SourceSpec,
  onProgress?: ProgressCallback,
  options: PlanOptions = {},
): Promise<PlanReport> {
  const found = await discover(spec, onProgress);
  onProgress?.({ phase: "plan", status: "start", current: 0, total: found.length });
  const compareMode = options.compareMode ?? "full";
  const requestedStates = options.fileStates
    ? new Set(options.fileStates)
    : null;
  const tableNames = await db.tableNames();
  const known = tableNames.includes("source_files")
    ? new Map(((await (await db.connection.openTable("source_files"))
      .query().where(`source = ${sql(spec.source)}`).toArray()) as unknown as SourceFileRow[])
      .map((row) => [row.id, row]))
    : new Map<string, SourceFileRow>();
  const files: FilePlan[] = [];
  const allStates: FilePlan["state"][] = [];
  let processed = 0;

  for (const file of found) {
    const previous = known.get(file.id);
    let state: FilePlan["state"] = "new";
    if (previous) {
      if (previous.state === "pending" || previous.state === "failed") state = "changed";
      else if (previous.state === "requires_reconcile" || file.size < previous.size) state = "shrunk";
      else if (file.size !== previous.size || file.mtimeMs !== previous.mtime_ms) {
        state = "changed";
      } else if (compareMode === "metadata") {
        state = "unchanged";
      } else {
        state = await hashFile(file.path, () => onProgress?.({
          phase: "plan",
          status: "progress",
          current: processed + 1,
          total: found.length,
          path: file.path,
        })) === previous.sha256 ? "unchanged" : "changed";
      }
    }
    allStates.push(state);
    processed += 1;
    if (!requestedStates || requestedStates.has(state)) {
      files.push({ ...file, state });
    }
    onProgress?.({
      phase: "plan",
      status: "progress",
      current: processed,
      total: found.length,
      path: file.path,
    });
  }

  const count = (state: FilePlan["state"]) => allStates.filter((item) => item === state).length;
  const planSignatureRows = found
    .map((file, index): [string, number, number, FilePlan["state"]] => [
      file.id,
      file.size,
      file.mtimeMs,
      allStates[index] ?? "unchanged",
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const planRevision = sha256(JSON.stringify([
    spec.source,
    resolve(spec.root),
    ...planSignatureRows,
  ]));
  const report = {
    source: spec.source,
    root: resolve(spec.root),
    plan_revision: planRevision,
    found: found.length,
    new: count("new"),
    changed: count("changed"),
    unchanged: count("unchanged"),
    shrunk: count("shrunk"),
    will_parse: count("new") + count("changed"),
    files,
  };
  onProgress?.({ phase: "plan", status: "complete", current: processed, total: found.length });
  return report;
}

export async function importFile(
  db: PlainDatabase,
  spec: SourceSpec,
  file: FilePlan,
  onProgress?: ProgressCallback,
  position = { current: 1, total: 1 },
) {
  let parsed = 0;
  let blocks = 0;
  let inserted = 0;
  let duplicates = 0;
  let occurrenceInserts = 0;
  let corrupt = 0;
  let line = 0;
  let lastProgressAt = 0;

  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    onProgress?.({
      phase: "import",
      status: "progress",
      current: position.current,
      total: position.total,
      path: file.path,
      parsed_records: parsed,
      blocks,
      inserted,
      duplicates,
      corrupt,
    });
  };

  progress(true);
  const snapshot = await snapshotFile(file.path, file.size, progress);
  const fileHash = snapshot.sha256;
  const fallbackSession = basename(file.path, ".jsonl");
  const prior = await db.files().find(file.id);
  const recovery = prior?.state === "pending";
  if (recovery && (prior.sha256 !== fileHash || prior.size !== file.size)) {
    await snapshot.cleanup();
    throw new Error(`pending import snapshot changed; reconcile before importing: ${file.path}`);
  }
  const auditDirectory = await mkdtemp(join(tmpdir(), "jscan-audit-"));
  const auditDb = await PlainDatabase.open(join(auditDirectory, "seen.lancedb"));
  let auditBuffer: EventRow[] = [];
  const flushAudit = async () => {
    if (!auditBuffer.length || recovery) {
      auditBuffer = [];
      return;
    }
    const existing = await db.events().existingIds(auditBuffer.map((row) => row.id));
    await auditDb.events().insert(auditBuffer.filter((row) => existing.has(row.id)));
    const result = await auditDb.events().insert(auditBuffer);
    inserted += result.inserted;
    duplicates += result.duplicates;
    auditBuffer = [];
  };

  try {
    // Pass one computes the complete audit record without retaining the file
    // or its IDs in memory. The temporary LanceDB primary key makes duplicate
    // ownership exact even when an ID repeats across 5k boundaries.
    progress(true);
    const auditNormalization = createNormalizationState(fallbackSession);
    for await (const raw of createInterface({ input: snapshot.input() })) {
      line++;
      if (!raw.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { corrupt++; progress(); continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        corrupt++;
        progress();
        continue;
      }
      parsed++;
      const rows = normalize(value as Record<string, unknown>, {
        source: spec.source,
        filePath: file.path,
        fileHash,
        line,
        fallbackSession,
      }, auditNormalization);
      blocks += rows.events.length;
      auditBuffer.push(...rows.events);
      progress();
      if (auditBuffer.length >= 5_000) await flushAudit();
    }
    await flushAudit();
    if (recovery) {
      inserted = prior.inserted_events;
      duplicates = prior.duplicate_events;
      if (
        prior.parsed_records !== parsed || prior.corrupt_lines !== corrupt ||
        inserted + duplicates !== blocks
      ) throw new Error(`pending import audit changed; reconcile before importing: ${file.path}`);
    }

    const pending: SourceFileRow = {
      id: file.id,
      source: spec.source,
      path: file.path,
      size: file.size,
      mtime_ms: file.mtimeMs,
      sha256: fileHash,
      state: "pending",
      imported_at: new Date().toISOString(),
      parsed_records: parsed,
      inserted_events: inserted,
      duplicate_events: duplicates,
      corrupt_lines: corrupt,
    };
    await db.files().save(pending);

    let writeLine = 0;
    let eventBuffer: EventRow[] = [];
    let occurrenceBuffer: EventSourceRow[] = [];
    const writeNormalization = createNormalizationState(fallbackSession);
    const flushWrite = async () => {
      if (!eventBuffer.length) return;
      await db.events().insert(eventBuffer);
      const observed = await db.occurrences().insert(occurrenceBuffer);
      occurrenceInserts += observed.inserted;
      eventBuffer = [];
      occurrenceBuffer = [];
    };
    for await (const raw of createInterface({ input: snapshot.input() })) {
      writeLine++;
      if (!raw.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rows = normalize(value as Record<string, unknown>, {
        source: spec.source,
        filePath: file.path,
        fileHash,
        line: writeLine,
        fallbackSession,
      }, writeNormalization);
      eventBuffer.push(...rows.events);
      occurrenceBuffer.push(...rows.occurrences);
      if (eventBuffer.length >= 5_000) await flushWrite();
    }
    await flushWrite();
    await db.files().save({ ...pending, state: "imported" });
  } finally {
    await rm(auditDirectory, { recursive: true, force: true });
    await snapshot.cleanup();
  }
  progress(true);
  return { parsed, blocks, inserted, duplicates, occurrenceInserts, corrupt };
}

type PendingFileImport = {
  file: FilePlan;
  fileHash: string;
  parsed: number;
  blocks: number;
  corrupt: number;
  events: EventRow[];
  occurrences: EventSourceRow[];
};

async function prepareSmallFile(
  spec: SourceSpec,
  file: FilePlan,
  onProgress: ProgressCallback | undefined,
  position: { current: number; total: number },
): Promise<PendingFileImport> {
  let parsed = 0;
  let blocks = 0;
  let corrupt = 0;
  let line = 0;
  let lastProgressAt = 0;
  const events: EventRow[] = [];
  const occurrences: EventSourceRow[] = [];
  const fallbackSession = basename(file.path, ".jsonl");
  const normalization = createNormalizationState(fallbackSession);
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    onProgress?.({
      phase: "import",
      status: "progress",
      current: position.current,
      total: position.total,
      path: file.path,
      parsed_records: parsed,
      blocks,
      inserted: 0,
      duplicates: 0,
      corrupt,
    });
  };

  progress(true);
  const snapshot = await snapshotFile(file.path, file.size, progress);
  try {
    for await (const raw of createInterface({ input: snapshot.input() })) {
      line++;
      if (!raw.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { corrupt++; progress(); continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        corrupt++;
        progress();
        continue;
      }
      parsed++;
      const rows = normalize(value as Record<string, unknown>, {
        source: spec.source,
        filePath: file.path,
        fileHash: snapshot.sha256,
        line,
        fallbackSession,
      }, normalization);
      blocks += rows.events.length;
      events.push(...rows.events);
      occurrences.push(...rows.occurrences);
      progress();
    }
  } finally {
    await snapshot.cleanup();
  }
  progress(true);
  return { file, fileHash: snapshot.sha256, parsed, blocks, corrupt, events, occurrences };
}

async function importSourceUnlocked(
  db: PlainDatabase,
  spec: SourceSpec,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const preflight = await plan(db, spec, options.onProgress);
  if (
    options.expectedPlanRevision !== undefined &&
    preflight.plan_revision !== options.expectedPlanRevision
  ) {
    throw new Error(
      `stale import plan: expected revision ${options.expectedPlanRevision}, got ${preflight.plan_revision}`,
    );
  }
  if (
    options.expectedWillParse !== undefined &&
    preflight.will_parse !== options.expectedWillParse
  ) {
    throw new Error(
      `stale import plan: expected ${options.expectedWillParse} files, got ${preflight.will_parse}`,
    );
  }
  if (preflight.shrunk > 0) {
    throw new Error(`import plan contains ${preflight.shrunk} shrunk file(s); reconcile before importing`);
  }
  await db.create();
  const allPriorRows = await db.files().list();
  const foreignPending = allPriorRows.find((row) =>
    row.state === "pending" && row.source !== spec.source
  );
  if (foreignPending) {
    throw new Error(
      `pending import for source ${foreignPending.source} must recover before fresh source ` +
      `${spec.source}: ${foreignPending.path}`,
    );
  }
  const priorRows = allPriorRows.filter((row) => row.source === spec.source);
  const pendingById = new Map(priorRows
    .filter((row) => row.state === "pending")
    .map((row) => [row.id, row]));
  const eligible = preflight.files.filter((file) =>
    file.state === "new" || file.state === "changed"
  ).sort((left, right) => {
    const recoveryOrder = Number(pendingById.has(right.id)) - Number(pendingById.has(left.id));
    return recoveryOrder || left.path.localeCompare(right.path);
  });
  const maxFiles = options.maxFiles == null
    ? eligible.length
    : Math.max(0, Math.trunc(options.maxFiles));
  const selected = new Set(eligible.slice(0, maxFiles).map((file) => file.id));
  const remainingFiles = Math.max(0, eligible.length - selected.size);
  const report: ImportReport = {
    source: preflight.source,
    root: preflight.root,
    plan_revision: preflight.plan_revision,
    found: preflight.found,
    new: preflight.new,
    changed: preflight.changed,
    unchanged: preflight.unchanged,
    shrunk: preflight.shrunk,
    will_parse: preflight.will_parse,
    selected_files: selected.size,
    remaining_files: remainingFiles,
    partial: remainingFiles > 0,
    parsed_records: 0,
    blocks: 0,
    inserted: 0,
    duplicates: 0,
    occurrences_inserted: 0,
    corrupt: 0,
  };
  options.onProgress?.({
    phase: "import",
    status: "start",
    current: 0,
    total: selected.size,
  });

  let importedFiles = 0;
  let pendingFiles: PendingFileImport[] = [];
  let pendingBytes = 0;
  let pendingRows = 0;
  const flushPendingFiles = async () => {
    if (!pendingFiles.length) return;
    const files = pendingFiles;
    pendingFiles = [];
    pendingBytes = 0;
    pendingRows = 0;

    const eventRows = files.flatMap((pending) => pending.events);
    const occurrenceRows = files.flatMap((pending) => pending.occurrences);
    const recovering = files.every((pending) => pendingById.has(pending.file.id));
    if (!recovering && files.some((pending) => pendingById.has(pending.file.id))) {
      throw new Error("pending recovery batch cannot be mixed with fresh files");
    }
    const seen = recovering
      ? new Set<string>()
      : await db.events().existingIds(eventRows.map((row) => row.id));
    const perFile = files.map((pending) => {
      const checkpoint = pendingById.get(pending.file.id);
      if (checkpoint) {
        if (checkpoint.sha256 !== pending.fileHash || checkpoint.size !== pending.file.size) {
          throw new Error(`pending import snapshot changed; reconcile before importing: ${pending.file.path}`);
        }
        return {
          pending,
          inserted: checkpoint.inserted_events,
          duplicates: checkpoint.duplicate_events,
        };
      }
      let inserted = 0;
      let duplicates = 0;
      for (const row of pending.events) {
        if (seen.has(row.id)) duplicates++;
        else {
          seen.add(row.id);
          inserted++;
        }
      }
      return { pending, inserted, duplicates };
    });

    const pendingManifests = perFile.map(({ pending, inserted, duplicates }): SourceFileRow => ({
      id: pending.file.id,
      source: spec.source,
      path: pending.file.path,
      size: pending.file.size,
      mtime_ms: pending.file.mtimeMs,
      sha256: pending.fileHash,
      state: "pending",
      imported_at: new Date().toISOString(),
      parsed_records: pending.parsed,
      inserted_events: inserted,
      duplicate_events: duplicates,
      corrupt_lines: pending.corrupt,
    }));
    await db.files().saveMany(pendingManifests);

    const canonical = await db.events().insert(eventRows);
    if (!recovering && canonical.inserted !== perFile.reduce((sum, item) => sum + item.inserted, 0)) {
      throw new Error("canonical event merge changed during import");
    }
    const observed = await db.occurrences().insert(occurrenceRows);

    const finalized = pendingManifests.map((row) => ({ ...row, state: "imported" as const }));
    await db.files().saveMany(finalized);
    for (const { pending, inserted, duplicates } of perFile) {
      report.parsed_records += pending.parsed;
      report.blocks += pending.blocks;
      report.inserted += inserted;
      report.duplicates += duplicates;
      report.corrupt += pending.corrupt;
    }
    report.occurrences_inserted += observed.inserted;
  };

  for (const file of preflight.files.filter((file) => file.state === "shrunk")) {
    const previous = await db.files().find(file.id);
    if (previous) await db.files().save({ ...previous, state: "requires_reconcile" });
  }
  for (const file of eligible) {
    if (!selected.has(file.id)) continue;
    importedFiles++;
    const position = { current: importedFiles, total: selected.size };
    const checkpoint = pendingById.get(file.id);
    const replayFile = checkpoint ? {
      ...file,
      size: checkpoint.size,
      mtimeMs: checkpoint.mtime_ms,
    } : file;
    if (replayFile.size > MEMORY_SNAPSHOT_LIMIT) {
      await flushPendingFiles();
      const result = await importFile(
        db, spec, replayFile, options.onProgress, position,
      );
      report.parsed_records += result.parsed;
      report.blocks += result.blocks;
      report.inserted += result.inserted;
      report.duplicates += result.duplicates;
      report.occurrences_inserted += result.occurrenceInserts;
      report.corrupt += result.corrupt;
      continue;
    }

    if (pendingFiles.length && pendingBytes + replayFile.size > CROSS_FILE_BATCH_LIMIT) {
      await flushPendingFiles();
    }

    try {
      const pending = await prepareSmallFile(spec, replayFile, options.onProgress, position);
      pendingFiles.push(pending);
      pendingBytes += replayFile.size;
      pendingRows += pending.events.length;
    } catch (error) {
      // Files parsed before the failure are a complete, stable prefix. Commit
      // that prefix before surfacing the later-file error so retry resumes at
      // the boundary instead of re-reading successful work.
      await flushPendingFiles();
      throw error;
    }
    if (
      pendingBytes >= CROSS_FILE_BATCH_LIMIT ||
      pendingRows >= CROSS_FILE_ROW_LIMIT ||
      pendingFiles.length >= CROSS_FILE_FILE_LIMIT ||
      (pendingById.has(file.id) && pendingFiles.length > 0)
    ) await flushPendingFiles();
  }
  await flushPendingFiles();
  options.onProgress?.({
    phase: "import",
    status: "complete",
    current: importedFiles,
    total: selected.size,
    parsed_records: report.parsed_records,
    blocks: report.blocks,
    inserted: report.inserted,
    duplicates: report.duplicates,
    corrupt: report.corrupt,
  });
  return report;
}

export async function importSource(
  db: PlainDatabase,
  spec: SourceSpec,
  options: ImportOptions = {},
) {
  const release = await acquireImportLock(db);
  try { return await importSourceUnlocked(db, spec, options); }
  finally { await release(); }
}

export async function preview(file: string, source = "fixture") {
  const path = resolve(file);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`invalid JSONL file: ${path}`);
  const fileHash = await hashFile(path);
  const events: EventRow[] = [];
  let line = 0;
  let corrupt = 0;
  const fallbackSession = basename(path, ".jsonl");
  const normalization = createNormalizationState(fallbackSession);
  for await (const raw of createInterface({ input: createReadStream(path) })) {
    line++;
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        corrupt++;
        continue;
      }
      events.push(...normalize(value, {
        source,
        filePath: path,
        fileHash,
        line,
        fallbackSession,
      }, normalization).events);
    } catch { corrupt++; }
  }
  return { file: path, sha256: fileHash, blocks: events.length, corrupt, events };
}
