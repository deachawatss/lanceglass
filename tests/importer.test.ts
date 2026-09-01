import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, truncateSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Database,
  EventRepository,
  EventSourceRepository,
  SourceFileRepository,
} from "../src/database";
import { importFile, importSource, plan } from "../src/importer";
import { sha256 } from "../src/normalize";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function record(uuid: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "live-session",
    timestamp: "2026-08-30T00:00:00.000Z",
    cwd: "/demo/lanceglass",
    message: { role: "user", content: text },
  });
}

describe("mutable JSONL imports", () => {
  test("writes import tables only to the plain database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "plain-only.jsonl");
    await writeFile(path, `${record("plain-only", "ordinary import stays plain")}\n`);
    const plainDirectory = join(directory, "database.plain");
    const vectorDirectory = join(directory, "database.vector");
    const database = await Database.open(plainDirectory, vectorDirectory);

    await importSource(database.plain, { source: "fixture", root: directory });

    expect(await database.plain.tableNames()).toEqual(["event_sources", "events", "source_files"]);
    expect(await database.vector.tableNames()).toEqual([]);
    expect(await stat(vectorDirectory).catch(() => null)).toBeNull();
  });

  test("rejects a stale plan revision before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "stale.jsonl");
    await writeFile(path, `${record("first", "planned")}\n`);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const spec = { source: "fixture", root: directory };
    const planned = await plan(db, spec);
    expect(await db.tableNames()).toEqual([]);

    await writeFile(path, `${record("first", "planned")}\n${record("second", "late")}\n`);
    await expect(importSource(db, spec, {
      expectedPlanRevision: planned.plan_revision,
      expectedWillParse: planned.will_parse,
    })).rejects.toThrow("stale import plan");

    expect(await db.tableNames()).toEqual([]);
  });

  test("supports plan filtering with metadata mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-plan-filter-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, `${record("same", "meta-only import")}\n`);
    const db = (await Database.open(join(directory, "lancedb"))).plain;

    await importSource(db, { source: "fixture", root: directory });
    const filtered = await plan(db, { source: "fixture", root: directory }, undefined, {
      compareMode: "metadata",
      fileStates: ["changed", "new", "shrunk"],
    });

    expect(filtered.found).toBe(1);
    expect(filtered.files).toHaveLength(0);
    expect(filtered.unchanged).toBe(1);
  });

  test("treats a failed manifest as actionable even when the file hash is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-failed-plan-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "failed.jsonl");
    await writeFile(path, `${record("failed", "retry unchanged file")}\n`);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    await importSource(db, { source: "fixture", root: directory });
    const id = sha256(`fixture\0${path}`);
    const manifest = await db.files().find(id);
    expect(manifest).not.toBeNull();
    await db.files().save({ ...manifest!, state: "failed" });

    const retryPlan = await plan(db, { source: "fixture", root: directory });
    expect(retryPlan.changed).toBe(1);
    expect(retryPlan.will_parse).toBe(1);
  });

  test("imports the preflight prefix and defers an append until the next idempotent pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "live.jsonl");
    const firstPrefix = `${record("first", "before snapshot")}\n`;
    const appended = `${record("second", "after snapshot")}\n`;
    await writeFile(path, firstPrefix);

    const info = await stat(path);
    const spec = { source: "fixture", root: directory };
    const file = {
      id: sha256(`fixture\0${path}`),
      source: "fixture",
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      state: "new" as const,
    };
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    await db.create();
    let progressCalls = 0;

    const first = await importFile(db, spec, file, () => {
      progressCalls++;
      if (progressCalls === 2) appendFileSync(path, appended);
    });

    const prefixHash = sha256(firstPrefix);
    expect(first.parsed).toBe(1);
    expect(await db.events().count()).toBe(1);
    expect(await db.occurrences().list()).toEqual([
      expect.objectContaining({ event_id: "first#0", file_hash: prefixHash }),
    ]);
    expect(await db.files().find(file.id)).toEqual(
      expect.objectContaining({ size: info.size, sha256: prefixHash, parsed_records: 1 }),
    );

    const resumed = await importSource(db, spec);
    const fullHash = sha256(firstPrefix + appended);
    expect(resumed.changed).toBe(1);
    expect(resumed.inserted).toBe(1);
    expect(resumed.occurrences_inserted).toBe(1);
    expect(await db.events().count()).toBe(2);
    expect(await db.occurrences().list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "first#0", file_hash: prefixHash }),
      expect.objectContaining({ event_id: "second#0", file_hash: fullHash }),
    ]));

    const repeated = await importSource(db, spec);
    expect(repeated.unchanged).toBe(1);
    expect(repeated.selected_files).toBe(0);
    expect(await db.events().count()).toBe(2);
    expect(await db.occurrences().count()).toBe(2);
  });

  test("refuses a file truncated below its preflight prefix before writing rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "truncated.jsonl");
    const original = `${record("first", "kept")}\n${record("second", "removed")}\n`;
    await writeFile(path, original);
    const info = await stat(path);
    await writeFile(path, `${record("first", "kept")}\n`);

    const db = (await Database.open(join(directory, "lancedb"))).plain;
    await db.create();
    await expect(importFile(db, { source: "fixture", root: directory }, {
      id: sha256(`fixture\0${path}`),
      source: "fixture",
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      state: "new",
    })).rejects.toThrow("JSONL file changed before snapshot");

    expect(await db.events().count()).toBe(0);
    expect(await db.occurrences().count()).toBe(0);
    expect(await db.files().count()).toBe(0);
  });

  test("batches empty-file manifests while preserving idempotent resume state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-empty-batch-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      writeFile(join(source, `${String(index).padStart(3, "0")}.jsonl`), "")
    ));
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const originalSaveMany = SourceFileRepository.prototype.saveMany;
    const manifestBatchSizes: number[] = [];
    SourceFileRepository.prototype.saveMany = async function (rows) {
      manifestBatchSizes.push(rows.length);
      return originalSaveMany.call(this, rows);
    };
    try {
      const first = await importSource(db, { source: "fixture", root: source });
      expect(first.selected_files).toBe(300);
      expect(first.parsed_records).toBe(0);
      expect(manifestBatchSizes).toEqual([256, 256, 44, 44]);
      expect(await db.files().count("fixture")).toBe(300);
    } finally {
      SourceFileRepository.prototype.saveMany = originalSaveMany;
    }

    const repeated = await importSource(db, { source: "fixture", root: source });
    expect(repeated.unchanged).toBe(300);
    expect(repeated.selected_files).toBe(0);
  });

  test("merges many small files in one canonical and provenance batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-row-batch-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      writeFile(
        join(source, `${String(index).padStart(3, "0")}.jsonl`),
        `${record(`event-${index}`, `small file ${index}`)}\n`,
      )
    ));
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const originalEventInsert = EventRepository.prototype.insert;
    const originalOccurrenceInsert = EventSourceRepository.prototype.insert;
    let eventInsertCalls = 0;
    let occurrenceInsertCalls = 0;
    EventRepository.prototype.insert = async function (rows) {
      eventInsertCalls++;
      return originalEventInsert.call(this, rows);
    };
    EventSourceRepository.prototype.insert = async function (rows) {
      occurrenceInsertCalls++;
      return originalOccurrenceInsert.call(this, rows);
    };
    try {
      const result = await importSource(db, { source: "fixture", root: source });
      expect(result.inserted).toBe(40);
      expect(result.occurrences_inserted).toBe(40);
      expect(eventInsertCalls).toBe(1);
      expect(occurrenceInsertCalls).toBe(1);
    } finally {
      EventRepository.prototype.insert = originalEventInsert;
      EventSourceRepository.prototype.insert = originalOccurrenceInsert;
    }
  });

  test("assigns cross-file duplicate event IDs to the first stable file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-duplicate-batch-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const firstPath = join(source, "a.jsonl");
    const secondPath = join(source, "b.jsonl");
    await writeFile(firstPath, `${record("shared", "first observation")}\n`);
    await writeFile(secondPath, `${record("shared", "second observation")}\n`);
    const db = (await Database.open(join(directory, "lancedb"))).plain;

    const result = await importSource(db, { source: "fixture", root: source });
    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.occurrences_inserted).toBe(2);
    expect(await db.events().count()).toBe(1);
    expect(await db.events().list()).toEqual([
      expect.objectContaining({
        id: "shared#0",
        source: "fixture",
        text: "first observation",
      }),
    ]);
    expect(await db.occurrences().count()).toBe(2);
    expect(await db.files().find(sha256(`fixture\0${firstPath}`))).toEqual(
      expect.objectContaining({ inserted_events: 1, duplicate_events: 0 }),
    );
    expect(await db.files().find(sha256(`fixture\0${secondPath}`))).toEqual(
      expect.objectContaining({ inserted_events: 0, duplicate_events: 1 }),
    );

    const repeated = await importSource(db, { source: "fixture", root: source });
    expect(repeated.selected_files).toBe(0);
    expect(await db.events().count()).toBe(1);
    expect(await db.occurrences().count()).toBe(2);
  });

  test("commits the completed batch before a later snapshot failure and resumes at that boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-failure-boundary-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const firstPath = join(source, "a.jsonl");
    const secondPath = join(source, "b.jsonl");
    const secondContents = `${record("second", "retry me")}\n`;
    await writeFile(firstPath, `${record("first", "commit me")}\n`);
    await writeFile(secondPath, secondContents);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    let truncated = false;

    await expect(importSource(db, { source: "fixture", root: source }, {
      onProgress(progress) {
        if (
          !truncated && progress.phase === "import" &&
          progress.status === "progress" && progress.path === secondPath
        ) {
          truncated = true;
          truncateSync(secondPath, 0);
        }
      },
    })).rejects.toThrow("JSONL file changed before snapshot");

    expect(await db.events().count()).toBe(1);
    expect(await db.occurrences().count()).toBe(1);
    expect(await db.files().find(sha256(`fixture\0${firstPath}`))).toEqual(
      expect.objectContaining({ state: "imported", inserted_events: 1 }),
    );
    expect(await db.files().find(sha256(`fixture\0${secondPath}`))).toBeNull();

    await writeFile(secondPath, secondContents);
    const resumed = await importSource(db, { source: "fixture", root: source });
    expect(resumed.selected_files).toBe(1);
    expect(resumed.inserted).toBe(1);
    expect(resumed.occurrences_inserted).toBe(1);
    expect(await db.events().count()).toBe(2);
    expect(await db.occurrences().count()).toBe(2);
  });

  for (const stage of ["pending", "canonical", "occurrence", "finalize"] as const) {
    test(`recovers exact cross-file attribution after a ${stage} checkpoint failure`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `jscan-importer-wal-${stage}-test-`));
      temporaryDirectories.push(directory);
      const source = join(directory, "source");
      await mkdir(source);
      const firstPath = join(source, "a.jsonl");
      const secondPath = join(source, "b.jsonl");
      await writeFile(firstPath, `${record("wal-shared", "first owner")}\n`);
      await writeFile(secondPath, `${record("wal-shared", "second duplicate")}\n`);
      const db = (await Database.open(join(directory, "lancedb"))).plain;
      const originalSaveMany = SourceFileRepository.prototype.saveMany;
      const originalEventInsert = EventRepository.prototype.insert;
      const originalOccurrenceInsert = EventSourceRepository.prototype.insert;
      let injected = false;

      if (stage === "pending" || stage === "finalize") {
        SourceFileRepository.prototype.saveMany = async function (rows) {
          const targetState = stage === "finalize" ? "imported" : "pending";
          if (!injected && rows[0]?.state === targetState) {
            injected = true;
            if (stage === "pending") await originalSaveMany.call(this, rows);
            throw new Error(`injected ${stage} failure`);
          }
          return originalSaveMany.call(this, rows);
        };
      } else if (stage === "canonical") {
        EventRepository.prototype.insert = async function (rows) {
          const result = await originalEventInsert.call(this, rows);
          if (!injected) {
            injected = true;
            throw new Error("injected canonical failure");
          }
          return result;
        };
      } else {
        EventSourceRepository.prototype.insert = async function (rows) {
          const result = await originalOccurrenceInsert.call(this, rows);
          if (!injected) {
            injected = true;
            throw new Error("injected occurrence failure");
          }
          return result;
        };
      }

      try {
        await expect(importSource(db, { source: "fixture", root: source }))
          .rejects.toThrow(`injected ${stage} failure`);
      } finally {
        SourceFileRepository.prototype.saveMany = originalSaveMany;
        EventRepository.prototype.insert = originalEventInsert;
        EventSourceRepository.prototype.insert = originalOccurrenceInsert;
      }

      const checkpoints = await db.files().list("fixture");
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.every((row) => row.state === "pending")).toBe(true);
      const resumed = await importSource(db, { source: "fixture", root: source });
      expect(resumed.inserted).toBe(1);
      expect(resumed.duplicates).toBe(1);
      expect(await db.files().find(sha256(`fixture\0${firstPath}`))).toEqual(
        expect.objectContaining({ state: "imported", inserted_events: 1, duplicate_events: 0 }),
      );
      expect(await db.files().find(sha256(`fixture\0${secondPath}`))).toEqual(
        expect.objectContaining({ state: "imported", inserted_events: 0, duplicate_events: 1 }),
      );
      expect(await db.events().list()).toEqual([
        expect.objectContaining({ id: "wal-shared#0", text: "first owner" }),
      ]);
      expect(await db.occurrences().count()).toBe(2);
    });
  }

  test("replays an active small-file WAL prefix before importing a later append", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-small-append-wal-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const path = join(source, "active.jsonl");
    const prefix = `${record("prefix", "claimed before crash")}\n`;
    const appended = `${record("append", "written after crash")}\n`;
    await writeFile(path, prefix);
    const checkpointInfo = await stat(path);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const originalSaveMany = SourceFileRepository.prototype.saveMany;
    let injected = false;
    SourceFileRepository.prototype.saveMany = async function (rows) {
      const result = await originalSaveMany.call(this, rows);
      if (!injected && rows[0]?.state === "pending") {
        injected = true;
        throw new Error("injected pending append failure");
      }
      return result;
    };
    try {
      await expect(importSource(db, { source: "fixture", root: source }))
        .rejects.toThrow("injected pending append failure");
    } finally {
      SourceFileRepository.prototype.saveMany = originalSaveMany;
    }
    appendFileSync(path, appended);

    const replay = await importSource(db, { source: "fixture", root: source });
    expect(replay.inserted).toBe(1);
    expect(replay.duplicates).toBe(0);
    expect(await db.events().count()).toBe(1);
    expect(await db.files().find(sha256(`fixture\0${path}`))).toEqual(
      expect.objectContaining({
        state: "imported",
        size: checkpointInfo.size,
        sha256: sha256(prefix),
        inserted_events: 1,
        duplicate_events: 0,
      }),
    );

    const appendedPass = await importSource(db, { source: "fixture", root: source });
    expect(appendedPass.changed).toBe(1);
    expect(appendedPass.inserted).toBe(1);
    expect(appendedPass.duplicates).toBe(1);
    expect(await db.events().count()).toBe(2);
    expect(await db.files().find(sha256(`fixture\0${path}`))).toEqual(
      expect.objectContaining({
        state: "imported",
        size: (await stat(path)).size,
        sha256: sha256(prefix + appended),
      }),
    );
  });

  test("replays a large-file WAL prefix after canonical commit before importing an append", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-large-append-wal-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const path = join(source, "active-large.jsonl");
    const prefix = `${record("large-prefix", "x".repeat(16 * 1024 * 1024 + 1_024))}\n`;
    const appended = `${record("large-append", "written after canonical crash")}\n`;
    await writeFile(path, prefix);
    const checkpointInfo = await stat(path);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const originalOccurrenceInsert = EventSourceRepository.prototype.insert;
    let injected = false;
    EventSourceRepository.prototype.insert = async function (rows) {
      if (!injected) {
        injected = true;
        throw new Error("injected large canonical failure");
      }
      return originalOccurrenceInsert.call(this, rows);
    };
    try {
      await expect(importSource(db, { source: "fixture", root: source }))
        .rejects.toThrow("injected large canonical failure");
    } finally {
      EventSourceRepository.prototype.insert = originalOccurrenceInsert;
    }
    appendFileSync(path, appended);

    const replay = await importSource(db, { source: "fixture", root: source });
    expect(replay.inserted).toBe(1);
    expect(replay.duplicates).toBe(0);
    expect(await db.events().count()).toBe(1);
    expect(await db.files().find(sha256(`fixture\0${path}`))).toEqual(
      expect.objectContaining({
        state: "imported",
        size: checkpointInfo.size,
        sha256: sha256(prefix),
        inserted_events: 1,
        duplicate_events: 0,
      }),
    );

    const appendedPass = await importSource(db, { source: "fixture", root: source });
    expect(appendedPass.changed).toBe(1);
    expect(appendedPass.inserted).toBe(1);
    expect(appendedPass.duplicates).toBe(1);
    expect(await db.events().count()).toBe(2);
    expect(await db.files().find(sha256(`fixture\0${path}`))).toEqual(
      expect.objectContaining({ state: "imported", size: (await stat(path)).size }),
    );
  });

  test("refuses a second writer without deleting an unknown import lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-lock-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const db = (await Database.open(join(directory, "lancedb"))).plain;
    const lockPath = `${db.directory}.import.lock`;
    await writeFile(lockPath, JSON.stringify({ token: "other", pid: 4242 }));

    await expect(importSource(db, { source: "fixture", root: source }))
      .rejects.toThrow("pid 4242");
    expect(await stat(lockPath)).toBeTruthy();
  });

  test("imports Codex rollout records with one shared per-file normalization state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-importer-codex-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    const path = join(source, "rollout.jsonl");
    const records = [
      { type: "session_meta", timestamp: "t0", payload: {
        id: "codex-session", cwd: "/work/codex-demo",
      } },
      { type: "response_item", timestamp: "t1", payload: {
        type: "message", id: "user-item", role: "user",
        content: [{ type: "input_text", text: "index this rollout" }],
      } },
      { type: "response_item", timestamp: "t2", payload: {
        type: "custom_tool_call", id: "tool-item", call_id: "call-1",
        name: "exec", input: "pwd",
      } },
      { type: "response_item", timestamp: "t3", payload: {
        type: "reasoning", encrypted_content: "ignored",
      } },
    ];
    await writeFile(path, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const db = (await Database.open(join(directory, "lancedb"))).plain;

    const report = await importSource(db, { source: "codex", root: source });
    const events = await db.events().list("codex");

    expect(report).toMatchObject({ parsed_records: 4, blocks: 2, inserted: 2, corrupt: 0 });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "user-item#0", session_id: "codex-session", project: "codex-demo",
        semantic_role: "human_intent", text: "index this rollout",
      }),
      expect.objectContaining({
        id: "tool-item#0", session_id: "codex-session", project: "codex-demo",
        semantic_role: "tool_action", tool_name: "exec", tool_use_id: "call-1", text: "pwd",
      }),
    ]));
  });
});
