import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventRepository, PlainDatabase } from "../src/database.plain";
import { loadEventFacets, loadEventPage } from "../src/event-browser";
import type { EventRow, EventSourceRow } from "../src/types";

function event(id: string, project: string, timestamp: string): EventRow {
  return {
    id,
    event_uuid: id,
    block_index: 0,
    session_id: "session",
    parent_uuid: "",
    timestamp,
    project,
    envelope_type: "message",
    block_type: "text",
    semantic_role: "assistant_answer",
    tool_name: "",
    tool_use_id: "",
    is_error: false,
    text: id,
    text_hash: `${id}-hash`,
    source: "claude",
  };
}

describe("bounded event browser", () => {
  test("stops a repository stream between Arrow batches", async () => {
    const controller = new AbortController();
    const query = {
      where() { return this; },
      select() { return this; },
      async *[Symbol.asyncIterator]() {
        yield {
          toArray: () => {
            controller.abort();
            return [{ id: "first", source: "claude", timestamp: "2026-09-01T01:00:00.000Z" }];
          },
        };
        yield { toArray: () => [] };
      },
    };
    const repository = new EventRepository({
      table: async () => ({ query: () => query }),
    } as never);

    await expect(repository.latestExact("claude", "", 50, undefined, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  test("propagates cancellation into repository work as AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = {
      events: () => ({
        latestExact: async (_source?: string, _project?: string, _limit?: number, _keys?: ReadonlySet<string>, signal?: AbortSignal) => {
          if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
          return { rows: [], total: 0 };
        },
        projectCounts: async () => [],
        keysForProject: async () => new Set<string>(),
        count: async () => 0,
      }),
      occurrences: () => ({
        eventKeysInFolder: async () => new Set<string>(),
        pathsForEvents: async () => [],
        folderCounts: async () => [],
        count: async () => 0,
      }),
    };

    await expect(loadEventPage(store, "claude", "", "", 50, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  test("matches provenance folders containing SQL LIKE wildcard characters exactly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-folder-"));
    try {
      const db = await PlainDatabase.open(directory);
      await db.create();
      await db.occurrences().insert([
        {
          id: "exact",
          event_id: "wanted",
          source: "claude",
          file_path: "/archive/a_b%/session.jsonl",
          file_hash: "hash",
          source_line: 1,
          observed_text_hash: "text-hash",
        },
        {
          id: "wildcard-lookalike",
          event_id: "wrong",
          source: "claude",
          file_path: "/archive/axbZZ/session.jsonl",
          file_hash: "hash",
          source_line: 1,
          observed_text_hash: "text-hash",
        },
      ]);

      expect(await db.occurrences().eventKeysInFolder("claude", "/archive/a_b%"))
        .toEqual(new Set(["claude\0wanted"]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("finds latest timestamps exactly even when physical append order differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "event-browser-"));
    try {
      const db = await PlainDatabase.open(directory);
      await db.create();
      await db.events().insert([
        event("newest", "sample-oracle", "2026-09-01T03:00:00.000Z"),
        event("oldest", "sample-oracle", "2026-09-01T01:00:00.000Z"),
        event("middle", "sample-oracle", "2026-09-01T02:00:00.000Z"),
      ]);

      const page = await db.events().latestExact("claude", "sample-oracle", 2);
      expect(page.total).toBe(3);
      expect(page.rows.map((row) => row.id)).toEqual(["newest", "middle"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("loads the exact latest page and provenance without unbounded list scans", async () => {
    const latest = event("latest", "sample-oracle", "2026-09-01T03:00:00.000Z");
    const occurrence: EventSourceRow = {
      id: "occurrence",
      event_id: latest.id,
      source: latest.source,
      file_path: "/archive/neo/session.jsonl",
      file_hash: "file-hash",
      source_line: 1,
      observed_text_hash: latest.text_hash,
    };
    const store = {
      events: () => ({
        list: async () => { throw new Error("unbounded event scan"); },
        latestExact: async () => ({ rows: [latest], total: 2 }),
        projectCounts: async () => [{ value: "sample-oracle", count: 2 }],
        keysForProject: async () => new Set([`${latest.source}\0${latest.id}`]),
        count: async () => 2,
      }),
      occurrences: () => ({
        list: async () => { throw new Error("unbounded occurrence scan"); },
        pathsForEvents: async () => [occurrence],
        folderCounts: async () => [{ value: "/archive/neo", label: "neo", count: 1 }],
        eventKeysInFolder: async () => new Set([`${latest.source}\0${latest.id}`]),
        count: async () => 1,
      }),
    };

    const page = await loadEventPage(store, "claude", "sample-oracle", "", 1);
    expect(page).toMatchObject({
      total: 2,
      events: [{ id: "latest", file_path: occurrence.file_path, folder: "/archive/neo" }],
      facets: { projects: [], folders: [] },
    });

    const facets = await loadEventFacets(store, "claude", "sample-oracle");
    expect(facets.facets).toEqual({
      projects: [{ value: "sample-oracle", count: 2 }],
      folders: [{ value: "/archive/neo", label: "neo", count: 1 }],
    });
  });
});
