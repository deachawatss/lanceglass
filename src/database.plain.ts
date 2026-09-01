import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { dirname, resolve } from "node:path";
import { SCHEMAS } from "./schemas";
import type {
  EmbeddingEventRow,
  EventRow,
  EventSourceRow,
  SourceFileRow,
} from "./types";

export function sql(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export type EmbeddingPageOptions = {
  source?: string;
  project?: string;
  sinceInclusive?: string;
  untilExclusive?: string;
  eventIds?: readonly string[];
  semanticRole: EmbeddingEventRow["semantic_role"];
  minimumCharacters: number;
  offset: number;
  limit: number;
};

/** The always-on typed JSONL store: canonical rows, provenance, and manifest. */
export class PlainDatabase {
  private constructor(
    readonly directory: string,
    readonly connection: Connection,
  ) {}

  static async open(directory: string) {
    return new PlainDatabase(directory, await lancedb.connect(directory));
  }

  async create() {
    const names = new Set(await this.connection.tableNames());
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      if (!names.has(name)) await this.connection.createEmptyTable(name, schema);
    }
    return (await this.connection.tableNames()).sort();
  }

  async tableNames() {
    return (await this.connection.tableNames()).sort();
  }

  async table(name: keyof typeof SCHEMAS): Promise<Table> {
    await this.create();
    return this.connection.openTable(name);
  }

  events() { return new EventRepository(this); }
  occurrences() { return new EventSourceRepository(this); }
  files() { return new SourceFileRepository(this); }
}

async function insertNew<T extends { id: string }>(table: Table, rows: T[]) {
  const firstById = new Map<string, T>();
  for (const row of rows) {
    if (!firstById.has(row.id)) firstById.set(row.id, row);
  }
  const unique = [...firstById.values()];
  if (!unique.length) return { inserted: 0, duplicates: 0 };
  const result = await table.mergeInsert("id").whenNotMatchedInsertAll().execute(unique);
  const inserted = result.numInsertedRows;
  return { inserted, duplicates: rows.length - inserted };
}

export class EventRepository {
  constructor(private readonly db: PlainDatabase) {}

  async insert(rows: EventRow[]) {
    return insertNew(await this.db.table("events"), rows);
  }

  async existingIds(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Set<string>();
    const rows = await (await this.db.table("events"))
      .query()
      .where(`id IN (${unique.map(sql).join(", ")})`)
      .select(["id"])
      .toArray() as unknown as Array<Pick<EventRow, "id">>;
    return new Set(rows.map((row) => row.id));
  }

  async count(source?: string) {
    return (await this.db.table("events"))
      .countRows(source ? `source = ${sql(source)}` : undefined);
  }

  async latestWindow(source = "", project = "", limit = 50) {
    const table = await this.db.table("events");
    const predicates = [
      source && `source = ${sql(source)}`,
      project && `project = ${sql(project)}`,
    ].filter(Boolean) as string[];
    const predicate = predicates.join(" AND ");
    const total = await table.countRows(predicate || undefined);
    if (!total) return { rows: [] as EventRow[], total };

    // LanceDB's scalar query has limit/offset but no timestamp order. Read only
    // a bounded physical tail, then restore the UI's chronological ordering in
    // memory. Imports append committed batches, so this window exposes fresh
    // rows without materializing the entire source on every live tick.
    const windowSize = Math.min(total, Math.max(limit * 4, 200));
    let query = table.query();
    if (predicate) query = query.where(predicate);
    query = query.offset(Math.max(0, total - windowSize)).limit(windowSize);
    const rows = await query.toArray() as unknown as EventRow[];
    return {
      rows: rows
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit),
      total,
    };
  }

  async latestExact(
    source = "",
    project = "",
    limit = 50,
    eventKeys?: ReadonlySet<string>,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    if (eventKeys && !eventKeys.size) return { rows: [] as EventRow[], total: 0 };
    const table = await this.db.table("events");
    const predicates = [
      source && `source = ${sql(source)}`,
      project && `project = ${sql(project)}`,
    ].filter(Boolean) as string[];
    let query = table.query();
    if (predicates.length) query = query.where(predicates.join(" AND "));
    query = query.select(["id", "source", "timestamp"]);

    type Candidate = Pick<EventRow, "id" | "source" | "timestamp">;
    const heap: Candidate[] = [];
    const older = (left: Candidate, right: Candidate) =>
      left.timestamp < right.timestamp ||
      (left.timestamp === right.timestamp && `${left.source}\0${left.id}` < `${right.source}\0${right.id}`);
    const swap = (left: number, right: number) => {
      [heap[left], heap[right]] = [heap[right]!, heap[left]!];
    };
    const push = (candidate: Candidate) => {
      heap.push(candidate);
      for (let index = heap.length - 1; index > 0;) {
        const parent = Math.floor((index - 1) / 2);
        if (!older(heap[index]!, heap[parent]!)) break;
        swap(index, parent);
        index = parent;
      }
    };
    const replaceOldest = (candidate: Candidate) => {
      heap[0] = candidate;
      for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let oldest = index;
        if (left < heap.length && older(heap[left]!, heap[oldest]!)) oldest = left;
        if (right < heap.length && older(heap[right]!, heap[oldest]!)) oldest = right;
        if (oldest === index) break;
        swap(index, oldest);
        index = oldest;
      }
    };

    let total = 0;
    for await (const batch of query) {
      throwIfAborted(signal);
      for (const value of batch.toArray()) {
        const candidate = value as unknown as Candidate;
        if (eventKeys && !eventKeys.has(`${candidate.source}\0${candidate.id}`)) continue;
        total += 1;
        if (heap.length < limit) push(candidate);
        else if (older(heap[0]!, candidate)) replaceOldest(candidate);
      }
    }

    const selected = heap.sort((left, right) =>
      right.timestamp.localeCompare(left.timestamp) ||
      `${right.source}\0${right.id}`.localeCompare(`${left.source}\0${left.id}`)
    );
    const keys = new Set(selected.map((row) => `${row.source}\0${row.id}`));
    const ids = [...new Set(selected.map((row) => row.id))];
    if (!ids.length) return { rows: [] as EventRow[], total };
    throwIfAborted(signal);
    const rows = await table.query()
      .where(`id IN (${ids.map(sql).join(", ")})`)
      .toArray() as unknown as EventRow[];
    const rowsByKey = new Map(rows
      .filter((row) => keys.has(`${row.source}\0${row.id}`))
      .map((row) => [`${row.source}\0${row.id}`, row]));
    return {
      rows: selected.flatMap((row) => {
        const full = rowsByKey.get(`${row.source}\0${row.id}`);
        return full ? [full] : [];
      }),
      total,
    };
  }

  async projectCounts(source = "", signal?: AbortSignal) {
    throwIfAborted(signal);
    const table = await this.db.table("events");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    query = query.select(["project"]);
    const counts = new Map<string, number>();
    for await (const batch of query) {
      throwIfAborted(signal);
      for (const value of batch.toArray()) {
        const { project } = value as unknown as Pick<EventRow, "project">;
        counts.set(project, (counts.get(project) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, count]) => ({ value, count }));
  }

  async keysForProject(source: string, project: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!project) return new Set<string>();
    const predicates = [
      source && `source = ${sql(source)}`,
      `project = ${sql(project)}`,
    ].filter(Boolean) as string[];
    const query = (await this.db.table("events")).query()
      .where(predicates.join(" AND "))
      .select(["id", "source"]);
    const keys = new Set<string>();
    for await (const batch of query) {
      throwIfAborted(signal);
      for (const value of batch.toArray()) {
        const row = value as unknown as Pick<EventRow, "id" | "source">;
        keys.add(`${row.source}\0${row.id}`);
      }
    }
    return keys;
  }

  async list(source = ""): Promise<EventRow[]> {
    const table = await this.db.table("events");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    return await query.toArray() as unknown as EventRow[];
  }

  async embeddingPage(options: EmbeddingPageOptions): Promise<EmbeddingEventRow[]> {
    if (options.eventIds && !options.eventIds.length) return [];
    const table = await this.db.table("events");
    const predicates = [
      `semantic_role = ${sql(options.semanticRole)}`,
      `block_type IN (${[
        "text", "summary", "input_text", "output_text",
      ].map(sql).join(", ")})`,
      `length(text) > ${options.minimumCharacters}`,
      `text NOT LIKE ${sql("<system-reminder>%")}`,
      `text NOT LIKE ${sql("[Image: source:%")}`,
      options.source && `source = ${sql(options.source)}`,
      options.project && `project = ${sql(options.project)}`,
      options.sinceInclusive && `timestamp >= ${sql(options.sinceInclusive)}`,
      options.untilExclusive && `timestamp < ${sql(options.untilExclusive)}`,
      options.eventIds && `id IN (${options.eventIds.map(sql).join(", ")})`,
    ].filter(Boolean) as string[];
    const query = table.query()
      .where(predicates.join(" AND "))
      .offset(options.offset)
      .limit(options.limit);
    return await query.select([
      "id", "session_id", "timestamp", "project", "block_type",
      "semantic_role", "text", "source",
    ]).toArray() as unknown as EmbeddingEventRow[];
  }
}

export class EventSourceRepository {
  constructor(private readonly db: PlainDatabase) {}

  async insert(rows: EventSourceRow[]) {
    return insertNew(await this.db.table("event_sources"), rows);
  }

  async count(source?: string) {
    return (await this.db.table("event_sources"))
      .countRows(source ? `source = ${sql(source)}` : undefined);
  }

  async list(source = ""): Promise<EventSourceRow[]> {
    const table = await this.db.table("event_sources");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    return await query.toArray() as unknown as EventSourceRow[];
  }

  async eventIdsInFolder(source: string, folder: string) {
    const target = resolve(folder);
    const predicates = [
      source && `source = ${sql(source)}`,
      `file_path LIKE ${sql(`${target}/%`)}`,
    ].filter(Boolean) as string[];
    const rows = await (await this.db.table("event_sources"))
      .query()
      .where(predicates.join(" AND "))
      .select(["event_id", "file_path"])
      .toArray() as unknown as Array<Pick<EventSourceRow, "event_id" | "file_path">>;
    return [...new Set(rows
      .filter((row) => dirname(resolve(row.file_path)) === target)
      .map((row) => row.event_id))].sort();
  }

  async eventKeysInFolder(source: string, folder: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const target = resolve(folder);
    let query = (await this.db.table("event_sources")).query();
    // Do not use LIKE here: literal folder names may contain '%' or '_'. The
    // source predicate is indexed/scalar-safe; exact dirname matching remains
    // in application code while projected rows stream in bounded batches.
    if (source) query = query.where(`source = ${sql(source)}`);
    query = query.select(["event_id", "source", "file_path"]);
    const keys = new Set<string>();
    for await (const batch of query) {
      throwIfAborted(signal);
      for (const value of batch.toArray()) {
        const row = value as unknown as Pick<EventSourceRow, "event_id" | "source" | "file_path">;
        if (dirname(resolve(row.file_path)) === target) keys.add(`${row.source}\0${row.event_id}`);
      }
    }
    return keys;
  }

  async pathsForEvents(events: readonly Pick<EventRow, "id" | "source">[], signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!events.length) return [] as EventSourceRow[];
    const ids = [...new Set(events.map((event) => event.id))];
    const keys = new Set(events.map((event) => `${event.source}\0${event.id}`));
    const rows = await (await this.db.table("event_sources"))
      .query()
      .where(`event_id IN (${ids.map(sql).join(", ")})`)
      .toArray() as unknown as EventSourceRow[];
    throwIfAborted(signal);
    return rows.filter((row) => keys.has(`${row.source}\0${row.event_id}`));
  }

  async folderCounts(source: string, eventKeys: ReadonlySet<string>, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (!eventKeys.size) return [] as Array<{ value: string; count: number }>;
    const table = await this.db.table("event_sources");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    query = query.select(["event_id", "source", "file_path"]);
    const keysByFolder = new Map<string, Set<string>>();
    for await (const batch of query) {
      throwIfAborted(signal);
      for (const value of batch.toArray()) {
        const row = value as unknown as Pick<EventSourceRow, "event_id" | "source" | "file_path">;
        const key = `${row.source}\0${row.event_id}`;
        if (!eventKeys.has(key)) continue;
        const folder = dirname(row.file_path);
        const keys = keysByFolder.get(folder) ?? new Set<string>();
        keys.add(key);
        keysByFolder.set(folder, keys);
      }
    }
    return [...keysByFolder.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, keys]) => ({ value, count: keys.size }));
  }
}

export class SourceFileRepository {
  constructor(private readonly db: PlainDatabase) {}

  async list(source?: string): Promise<SourceFileRow[]> {
    const table = await this.db.table("source_files");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    return await query.toArray() as unknown as SourceFileRow[];
  }

  async find(id: string): Promise<SourceFileRow | null> {
    const rows = await (await this.db.table("source_files"))
      .query().where(`id = ${sql(id)}`).limit(1).toArray();
    return (rows[0] as unknown as SourceFileRow | undefined) ?? null;
  }

  async save(row: SourceFileRow) {
    await this.saveMany([row]);
  }

  async saveMany(rows: SourceFileRow[]) {
    if (!rows.length) return;
    await (await this.db.table("source_files"))
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async count(source?: string) {
    return (await this.db.table("source_files"))
      .countRows(source ? `source = ${sql(source)}` : undefined);
  }
}
