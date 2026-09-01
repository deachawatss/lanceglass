import { afterEach, describe, expect, test } from "bun:test";
import { Field, Int32, Schema } from "apache-arrow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database, defaultVectorDirectoryForSpace } from "../src/database";
import { EMBEDDING_DEPLOYMENTS } from "../src/embedding-provider";
import {
  HistoryVectorInputError,
  HistoryVectorStoreError,
  parseHistoryVectorRequest,
  visualizeHistoryVectors,
} from "../src/history-vectors";
import { UNKNOWN_PROVENANCE_FOLDER } from "../src/history";
import { EVENT_VECTORS_TABLE } from "../src/schemas";
import { embeddingText } from "../src/embeddings";
import { sha256 } from "../src/normalize";
import type { EventRow, EventSourceRow, EventVectorRow } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function event(
  id: string,
  timestamp: string,
  text: string,
  project = "sample-oracle",
  semanticRole: EventRow["semantic_role"] = "assistant_answer",
): EventRow {
  return {
    id,
    event_uuid: id,
    block_index: 0,
    session_id: "session-1",
    parent_uuid: "",
    timestamp,
    project,
    envelope_type: "message",
    block_type: "text",
    semantic_role: semanticRole,
    tool_name: "",
    tool_use_id: "",
    is_error: false,
    text,
    text_hash: `source-${id}`,
    source: "claude",
  };
}

function occurrence(id: string, eventId: string, filePath: string): EventSourceRow {
  return {
    id,
    event_id: eventId,
    source: "claude",
    file_path: filePath,
    file_hash: "file-hash",
    source_line: 1,
    observed_text_hash: `source-${eventId}`,
  };
}

async function fixture(deployment: "dual-4090" | "cloudflare") {
  const root = await mkdtemp(join(tmpdir(), "jscan-history-vectors-"));
  temporaryDirectories.push(root);
  const plainDirectory = join(root, "plain");
  const definition = EMBEDDING_DEPLOYMENTS[deployment];
  const vectorDirectory = defaultVectorDirectoryForSpace(
    plainDirectory,
    definition.vectorStoreKey,
  );
  const db = await Database.open(plainDirectory, vectorDirectory, definition.config.space);
  await db.plain.create();
  return { db, plainDirectory, vectorDirectory, definition };
}

function vector(eventRow: EventRow, values: number[], model: string): EventVectorRow {
  return {
    event_id: eventRow.id,
    source: eventRow.source,
    project: eventRow.project,
    session_id: eventRow.session_id,
    timestamp: eventRow.timestamp,
    text_hash: sha256(embeddingText(eventRow.text)),
    model,
    dimension: values.length,
    embedded_at: "2026-09-01T00:00:00.000Z",
    vector: Float32Array.from(values),
  };
}

const exactScope = {
  deployment: "dual-4090" as const,
  date: "2026-08-31",
  source: "claude",
  project: "sample-oracle",
  folder: "/archive/neo",
  session_id: "session-1",
  limit: 50,
  actors: ["human", "agent"] as const,
};

describe("history vector request", () => {
  test("requires an explicit supported deployment and exact bounded scope", () => {
    expect(parseHistoryVectorRequest(new URL(
      "http://localhost/api/vectors/visualize?deployment=dual-4090&date=2026-08-31" +
      "&source=claude&project=sample-oracle&folder=%2Farchive%2Fneo&session_id=session-1&limit=25",
    ))).toEqual({ ...exactScope, limit: 25, actors: ["human", "agent"] });
    expect(parseHistoryVectorRequest(new URL(
      "http://localhost/api/vectors/visualize?deployment=dual-4090&date=2026-08-31" +
      "&source=claude&project=&folder=%2Farchive%2Fneo&session_id=session-1",
    )).project).toBe("");
    expect(parseHistoryVectorRequest(new URL(
      "http://localhost/api/vectors/visualize?deployment=dual-4090&date=2026-08-31" +
      "&source=claude&project=sample-oracle&folder=%2Farchive%2Fneo&session_id=session-1" +
      "&actor=agent&actor=human",
    )).actors).toEqual(["human", "agent"]);
    expect(parseHistoryVectorRequest(new URL(
      "http://localhost/api/vectors/visualize?deployment=dual-4090&date=2026-08-31" +
      "&source=claude&project=sample-oracle&folder=%2Farchive%2Fneo&session_id=session-1" +
      "&actor=human",
    )).actors).toEqual(["human"]);
    expect(parseHistoryVectorRequest(new URL(
      "http://localhost/api/vectors/visualize?deployment=dual-4090&date=2026-08-31" +
      "&source=claude&project=sample-oracle&folder=%2Farchive%2Fneo&session_id=session-1" +
      "&actor=agent,human",
    )).actors).toEqual(["human", "agent"]);

    for (const query of [
      "date=2026-08-31&source=claude&project=p&folder=f&session_id=s",
      "deployment=m5-ollama&date=2026-08-31&source=claude&project=p&folder=f&session_id=s",
      "deployment=cloudflare&date=2026-08-31&source=claude&project=p&folder=f&session_id=s&limit=501",
      "deployment=cloudflare&date=2026-08-31&source=claude&project=p&folder=f&session_id=s&actor=",
      "deployment=cloudflare&date=2026-08-31&source=claude&project=p&folder=f&session_id=s&actor=robot",
    ]) {
      expect(() => parseHistoryVectorRequest(new URL(`http://localhost/api?${query}`)))
        .toThrow(HistoryVectorInputError);
    }
  });
});

describe("history vector visualization", () => {
  test("derives exact folder scope from provenance and reports coverage", async () => {
    const { db, definition } = await fixture("dual-4090");
    const included = event("included", "2026-08-30T18:00:00.000Z", "x".repeat(100));
    const includedTwo = event("included-two", "2026-08-30T18:30:00.000Z", "w".repeat(100));
    const missing = event("missing", "2026-08-30T19:00:00.000Z", "y".repeat(100));
    const otherFolder = event("other-folder", "2026-08-30T20:00:00.000Z", "z".repeat(100));
    const ineligible = event("short", "2026-08-30T21:00:00.000Z", "short");
    await db.plain.events().insert([included, includedTwo, missing, otherFolder, ineligible]);
    await db.plain.occurrences().insert([
      occurrence("o1", included.id, "/archive/neo/session.jsonl"),
      occurrence("o1b", includedTwo.id, "/archive/neo/session.jsonl"),
      occurrence("o2", missing.id, "/archive/neo/session.jsonl"),
      occurrence("o3", otherFolder.id, "/archive/other/session.jsonl"),
      occurrence("o4", ineligible.id, "/archive/neo/session.jsonl"),
    ]);
    const dimension = definition.config.space.dimension;
    const stale = vector(missing, Array.from({ length: dimension }, (_, index) => index === 2 ? 1 : 0), definition.config.space.model);
    stale.text_hash = "stale-text-hash";
    const vectorRows = [
      vector(included, Array.from({ length: dimension }, (_, index) => index === 0 ? 1 : 0), definition.config.space.model),
      vector(includedTwo, Array.from({ length: dimension }, (_, index) => index === 1 ? 1 : 0), definition.config.space.model),
      stale,
      vector(otherFolder, Array.from({ length: dimension }, (_, index) => index === 1 ? 1 : 0), definition.config.space.model),
    ];
    await db.vector.eventVectors().upsert(vectorRows);

    const first = await visualizeHistoryVectors(db.plain, db.vector, exactScope);
    const second = await visualizeHistoryVectors(db.plain, db.vector, exactScope);
    const limited = await visualizeHistoryVectors(db.plain, db.vector, { ...exactScope, limit: 1 });
    const { db: reordered } = await fixture("dual-4090");
    await reordered.plain.events().insert([
      ineligible,
      otherFolder,
      missing,
      includedTwo,
      included,
    ]);
    await reordered.plain.occurrences().insert([
      occurrence("o4", ineligible.id, "/archive/neo/session.jsonl"),
      occurrence("o3", otherFolder.id, "/archive/other/session.jsonl"),
      occurrence("o2", missing.id, "/archive/neo/session.jsonl"),
      occurrence("o1b", includedTwo.id, "/archive/neo/session.jsonl"),
      occurrence("o1", included.id, "/archive/neo/session.jsonl"),
    ]);
    await reordered.vector.eventVectors().upsert([...vectorRows].reverse());
    const reorderedResult = await visualizeHistoryVectors(
      reordered.plain,
      reordered.vector,
      exactScope,
    );

    expect(first.status).toBe("ready");
    expect(first.coverage).toEqual({ eligible: 3, embedded: 2, missing: 1, sampled: 2 });
    expect(first.points).toHaveLength(2);
    expect(first.points[0]).toMatchObject({
      event_id: "included",
      source: "claude",
      project: "sample-oracle",
      session_id: "session-1",
      semantic_role: "assistant_answer",
      text_preview: "x".repeat(100),
    });
    for (const point of first.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(Number.isFinite(point.z)).toBe(true);
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(1);
    }
    expect(first.points).toEqual(second.points);
    expect(first.points).toEqual(reorderedResult.points);
    expect(limited.coverage).toEqual({ eligible: 3, embedded: 2, missing: 1, sampled: 1 });
    expect(limited.points.map((point) => point.event_id)).toEqual(["included-two"]);
    expect(first.space).toMatchObject({
      id: definition.config.space.id,
      provider: "ollama",
      dimension,
    });
  });

  test("filters human and agent roles before coverage and projection", async () => {
    const { db, definition } = await fixture("dual-4090");
    const human = event(
      "human",
      "2026-08-30T18:00:00.000Z",
      "human ".repeat(20),
      "sample-oracle",
      "human_intent",
    );
    const answer = event(
      "answer",
      "2026-08-30T18:01:00.000Z",
      "agent answer ".repeat(10),
      "sample-oracle",
      "assistant_answer",
    );
    const humanFollowup = event(
      "human-followup",
      "2026-08-30T18:01:30.000Z",
      "human followup ".repeat(10),
      "sample-oracle",
      "human_intent",
    );
    const summary = event(
      "summary",
      "2026-08-30T18:02:00.000Z",
      "agent summary ".repeat(10),
      "sample-oracle",
      "summary",
    );
    const roleEvents = [human, answer, humanFollowup, summary];
    await db.plain.events().insert(roleEvents);
    await db.plain.occurrences().insert(roleEvents.map((row, index) =>
      occurrence(`role-${index}`, row.id, "/archive/neo/session.jsonl")
    ));
    const dimension = definition.config.space.dimension;
    await db.vector.eventVectors().upsert(roleEvents.map((row, axis) =>
      vector(
        row,
        Array.from({ length: dimension }, (_, index) => index === axis ? 1 : 0),
        definition.config.space.model,
      )
    ));

    const humanResult = await visualizeHistoryVectors(db.plain, db.vector, {
      ...exactScope,
      actors: ["human"],
    });
    const agentResult = await visualizeHistoryVectors(db.plain, db.vector, {
      ...exactScope,
      actors: ["agent"],
    });
    const bothResult = await visualizeHistoryVectors(db.plain, db.vector, exactScope);

    expect(humanResult.coverage).toEqual({ eligible: 2, embedded: 2, missing: 0, sampled: 2 });
    expect(humanResult.points.map((point) => point.event_id)).toEqual(["human", "human-followup"]);
    expect(agentResult.coverage).toEqual({ eligible: 2, embedded: 2, missing: 0, sampled: 2 });
    expect(agentResult.points.map((point) => point.event_id)).toEqual(["answer", "summary"]);
    expect(bothResult.coverage).toEqual({ eligible: 4, embedded: 4, missing: 0, sampled: 4 });
    expect(bothResult.scope.actors).toEqual(["human", "agent"]);
    expect(bothResult.projection.method).toBe("deterministic-pca-3d");
    for (const point of bothResult.points) {
      expect(Number.isFinite(point.z)).toBe(true);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(1);
    }
    expect(bothResult.points.some((point) => Math.abs(point.z) > 1e-6)).toBe(true);
    expect((await visualizeHistoryVectors(db.plain, db.vector, exactScope)).points)
      .toEqual(bothResult.points);
  });

  test("returns an explicit empty state when the selected vector store is missing", async () => {
    const { db, definition } = await fixture("cloudflare");
    const included = event("included", "2026-08-30T18:00:00.000Z", "x".repeat(100));
    await db.plain.events().insert([included]);
    await db.plain.occurrences().insert([
      occurrence("o1", included.id, "/archive/neo/session.jsonl"),
    ]);

    const result = await visualizeHistoryVectors(db.plain, db.vector, {
      ...exactScope,
      deployment: "cloudflare",
    });

    expect(result).toMatchObject({
      deployment: "cloudflare",
      status: "missing_store",
      available: false,
      coverage: { eligible: 1, embedded: 0, missing: 1, sampled: 0 },
      points: [],
      space: { id: definition.config.space.id, provider: "cloudflare-workers-ai" },
    });
  });

  test("maps orphan History rows in the explicit unknown-provenance scope", async () => {
    const { db, definition } = await fixture("dual-4090");
    const orphan = event("orphan", "2026-08-30T18:00:00.000Z", "x".repeat(100));
    await db.plain.events().insert([orphan]);
    const dimension = definition.config.space.dimension;
    await db.vector.eventVectors().upsert([
      vector(orphan, Array.from({ length: dimension }, (_, index) => index === 0 ? 1 : 0), definition.config.space.model),
    ]);

    const result = await visualizeHistoryVectors(db.plain, db.vector, {
      ...exactScope,
      folder: UNKNOWN_PROVENANCE_FOLDER,
    });

    expect(result.coverage).toEqual({ eligible: 1, embedded: 1, missing: 0, sampled: 1 });
    expect(result.points.map((point) => point.event_id)).toEqual(["orphan"]);
  });

  test("turns a malformed selected store into a bounded typed error", async () => {
    const { db } = await fixture("dual-4090");
    await (await db.vector.connectionForWrite()).createEmptyTable(
      EVENT_VECTORS_TABLE,
      new Schema([new Field("event_id", new Int32(), false)]),
    );

    await expect(visualizeHistoryVectors(db.plain, db.vector, exactScope))
      .rejects.toBeInstanceOf(HistoryVectorStoreError);
    await expect(visualizeHistoryVectors(db.plain, db.vector, exactScope))
      .rejects.toThrow("selected vector store is malformed");
  });
});

describe("GET /api/vectors/visualize", () => {
  test("serves the selected space without silently falling back", async () => {
    const { db, plainDirectory, definition } = await fixture("cloudflare");
    const included = event("included", "2026-08-30T18:00:00.000Z", "x".repeat(100));
    await db.plain.events().insert([included]);
    await db.plain.occurrences().insert([
      occurrence("o1", included.id, "/archive/neo/session.jsonl"),
    ]);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const child = Bun.spawn(["bun", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PORT: String(port), PLAIN_DB_DIR: plainDirectory },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      const query = new URLSearchParams({
        deployment: "cloudflare",
        date: "2026-08-31",
        source: "claude",
        project: "sample-oracle",
        folder: "/archive/neo",
        session_id: "session-1",
        limit: "10",
      });
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        response = await fetch(`http://127.0.0.1:${port}/api/vectors/visualize?${query}`)
          .catch(() => undefined);
        if (response) break;
        await Bun.sleep(20);
      }
      expect(response?.status).toBe(200);
      expect(await response!.json()).toMatchObject({
        deployment: "cloudflare",
        status: "missing_store",
        available: false,
        coverage: { eligible: 1, embedded: 0, missing: 1, sampled: 0 },
        space: { id: definition.config.space.id },
      });

      const bad = await fetch(`http://127.0.0.1:${port}/api/vectors/visualize?deployment=dual-4090`);
      expect(bad.status).toBe(400);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
});
