import { afterEach, describe, expect, test } from "bun:test";
import { Field, Int32, Schema, Utf8 } from "apache-arrow";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, VectorDatabase, type PlainDatabase } from "../src/database";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EMBEDDING_TEXT_LIMIT,
  EVENT_VECTOR_SCHEMA,
  EVENT_VECTORS_TABLE,
} from "../src/schemas";
import {
  ACTIVE_EMBEDDING_SPACE,
  CLOUDFLARE_EMBEDDING_SPACE,
  defineEmbeddingSpace,
  embeddingDateRange,
  embeddingText,
  embedPending,
  type EmbeddingProvider,
} from "../src/embeddings";
import { sha256 } from "../src/normalize";
import type { EventRow, EventSourceRow } from "../src/types";

const temporaryDirectories: string[] = [];
const LAB = fileURLToPath(new URL("..", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

type TemporaryStores = {
  root: string;
  plainDirectory: string;
  vectorDirectory: string;
  plain: PlainDatabase;
  vector: VectorDatabase;
};

async function temporaryStores(): Promise<TemporaryStores> {
  const root = await mkdtemp(join(tmpdir(), "jscan-embeddings-test-"));
  temporaryDirectories.push(root);
  const plainDirectory = join(root, "database.plain");
  const vectorDirectory = join(root, "database.vector");
  const database = await Database.open(plainDirectory, vectorDirectory);
  return { root, plainDirectory, vectorDirectory, ...database };
}

async function directoryExists(path: string) {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

function text(letter: string, length = 120) {
  return `${letter.repeat(length - 1)}.`;
}

function event(
  id: string,
  semanticRole: EventRow["semantic_role"],
  value: string,
  timestamp = "2026-08-31T12:00:00.000Z",
  source = "fixture",
): EventRow {
  return {
    id,
    event_uuid: id.split("#")[0] ?? id,
    block_index: 0,
    session_id: "session-1",
    parent_uuid: "",
    timestamp,
    project: "embedding-lab",
    envelope_type: semanticRole === "summary" ? "summary" : "assistant",
    block_type: semanticRole === "summary" ? "summary" : "text",
    semantic_role: semanticRole,
    tool_name: "",
    tool_use_id: "",
    is_error: false,
    text: value,
    text_hash: sha256(value),
    source,
  };
}

function vector(seed: number) {
  const result = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
  result[seed % EMBEDDING_DIMENSION] = 1;
  return result;
}

function provider(
  embed: (texts: string[]) => Promise<number[][]>,
): EmbeddingProvider {
  return { space: ACTIVE_EMBEDDING_SPACE, embed };
}

describe("incremental event embeddings across two LanceDB stores", () => {
  test("rejects another embedding space before creating vector storage", async () => {
    const { plain, vector: vectors, vectorDirectory } = await temporaryStores();
    await plain.events().insert([event("foreign-space#0", "human_intent", text("f"))]);
    const foreignProvider: EmbeddingProvider = {
      space: defineEmbeddingSpace({
        ...ACTIVE_EMBEDDING_SPACE,
        id: "remote-bge-m3-1024-cosine-text-v1",
        provider: "openai-compatible",
        revision: "remote-revision",
      }),
      embed: async () => [vector(1)],
    };

    await expect(embedPending(plain, vectors, foreignProvider, { maxEvents: 1 }))
      .rejects.toThrow("use a separate event_vectors store for each embedding space");
    expect(await directoryExists(vectorDirectory)).toBe(false);
  });

  test("stores another provider in a matching isolated vector space", async () => {
    const root = await mkdtemp(join(tmpdir(), "jscan-foreign-space-test-"));
    temporaryDirectories.push(root);
    const plainDirectory = join(root, "database.plain");
    const vectorDirectory = join(root, "database.vector.cloudflare");
    const database = await Database.open(
      plainDirectory,
      vectorDirectory,
      CLOUDFLARE_EMBEDDING_SPACE,
    );
    await database.plain.events().insert([
      event("cloudflare#0", "human_intent", text("c")),
    ]);
    const cloudflare: EmbeddingProvider = {
      space: CLOUDFLARE_EMBEDDING_SPACE,
      embed: async () => [vector(3)],
    };

    const report = await embedPending(database.plain, database.vector, cloudflare, {
      maxEvents: 1,
    });
    expect(report).toMatchObject({
      embedding_space_id: CLOUDFLARE_EMBEDDING_SPACE.id,
      provider: "cloudflare-workers-ai",
      model: "@cf/baai/bge-m3",
      embedded: 1,
      vectors: 1,
    });
    const table = await (await database.vector.connectionIfPresent())!
      .openTable(EVENT_VECTORS_TABLE);
    const schema = await table.schema();
    expect(schema.metadata.get("embedding_space_id")).toBe(CLOUDFLARE_EMBEDDING_SPACE.id);
    expect(schema.metadata.get("embedding_provider")).toBe("cloudflare-workers-ai");
    expect(schema.metadata.get("embedding_revision")).toBe(CLOUDFLARE_EMBEDDING_SPACE.revision);
    expect(schema.metadata.get("embedding_dimension")).toBe("1024");
    expect(schema.metadata.get("embedding_distance")).toBe("cosine");
  });

  test("refuses plain and vector paths that resolve to the same physical store", async () => {
    const root = await mkdtemp(join(tmpdir(), "jscan-split-store-test-"));
    temporaryDirectories.push(root);
    const plainDirectory = join(root, "database.plain");
    const vectorAlias = join(root, "database.vector-alias");
    await mkdir(plainDirectory);
    await symlink(plainDirectory, vectorAlias);

    await expect(Database.open(plainDirectory, plainDirectory)).rejects.toThrow(
      "plain and vector database directories must be different",
    );
    await expect(Database.open(plainDirectory, vectorAlias)).rejects.toThrow(
      "plain and vector database directories must be different",
    );
    expect(await directoryExists(join(plainDirectory, "event_vectors.lance"))).toBe(false);
  });

  test("does not disguise a non-ENOENT vector filesystem error as a missing store", async () => {
    const vectorStore = new VectorDatabase("\0");
    await expect(vectorStore.exists()).rejects.toThrow("without null bytes");
  });

  test("leaves vector storage absent until an explicit embed succeeds", async () => {
    const { plain, vector, vectorDirectory } = await temporaryStores();
    await plain.events().insert([event("plain-only#0", "human_intent", text("p"))]);

    expect(await plain.tableNames()).toEqual(["event_sources", "events", "source_files"]);
    expect(await vector.tableNames()).toEqual([]);
    expect(await directoryExists(vectorDirectory)).toBe(false);
  });

  test("embeds only eligible semantic blocks in priority order and hashes exact input", async () => {
    const { plain, vector: vectors, vectorDirectory } = await temporaryStores();
    const human = event("human#0", "human_intent", text("h", 2_100), "2026-08-31T10:00:00.000Z");
    const summary = event("summary#0", "summary", text("s"), "2026-08-31T12:00:00.000Z");
    const assistant = event("assistant#0", "assistant_answer", text("a"), "2026-08-31T13:00:00.000Z");
    await plain.events().insert([
      assistant,
      event("tool#0", "tool_action", text("t")),
      event("reminder#0", "assistant_answer", `<system-reminder>${text("r")}`),
      event("short#0", "human_intent", "too short"),
      summary,
      human,
    ]);

    const calls: string[][] = [];
    const result = await embedPending(plain, vectors, provider(async (inputs) => {
      calls.push(inputs);
      return inputs.map((_input, index) => vector(index + 1));
    }), { maxEvents: 10, batchSize: 10 });

    expect(result).toMatchObject({
      scanned: 3,
      eligible: 3,
      up_to_date: 0,
      selected: 3,
      embedded: 3,
      more_may_remain: false,
      vectors: 3,
    });
    expect(calls).toEqual([[
      embeddingText(human.text),
      embeddingText(summary.text),
      embeddingText(assistant.text),
    ]]);
    expect(calls[0]?.[0]).toHaveLength(EMBEDDING_TEXT_LIMIT);
    expect(await vectors.eventVectors().metadata()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_id: human.id,
        text_hash: sha256(embeddingText(human.text)),
        model: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSION,
      }),
    ]));
    const stored = await (await vectors.connectionIfPresent())!
      .openTable(EVENT_VECTORS_TABLE)
      .then((table) => table.query().select(["event_id", "vector"]).toArray()) as Array<{
        event_id: string;
        vector: ArrayLike<number>;
      }>;
    const storedHuman = stored.find((row) => row.event_id === human.id);
    expect(Array.from(storedHuman!.vector)).toHaveLength(EMBEDDING_DIMENSION);
    expect(Array.from(storedHuman!.vector).every(Number.isFinite)).toBe(true);
    expect(await plain.tableNames()).toEqual(["event_sources", "events", "source_files"]);
    expect(await vectors.tableNames()).toEqual([EVENT_VECTORS_TABLE]);
    expect(await directoryExists(vectorDirectory)).toBe(true);
  });

  test("embeds Codex input and output text while excluding Codex tool blocks", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    const human = {
      ...event("codex-human#0", "human_intent", text("h"), undefined, "codex"),
      envelope_type: "response_item",
      block_type: "input_text",
    };
    const assistant = {
      ...event("codex-assistant#0", "assistant_answer", text("a"), undefined, "codex"),
      envelope_type: "response_item",
      block_type: "output_text",
    };
    const tool = {
      ...event("codex-tool#0", "tool_action", text("t"), undefined, "codex"),
      envelope_type: "response_item",
      block_type: "function_call",
    };
    await plain.events().insert([human, assistant, tool]);

    const calls: string[][] = [];
    const report = await embedPending(plain, vectors, provider(async (inputs) => {
      calls.push(inputs);
      return inputs.map((_input, index) => vector(index + 1));
    }), { source: "codex", maxEvents: 10, batchSize: 10 });

    expect(report).toMatchObject({
      source: "codex",
      scanned: 2,
      eligible: 2,
      selected: 2,
      embedded: 2,
      more_may_remain: false,
      vectors: 2,
    });
    expect(calls).toEqual([[embeddingText(human.text), embeddingText(assistant.text)]]);
    expect(await vectors.eventVectors().metadata()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: human.id, source: "codex" }),
      expect.objectContaining({ event_id: assistant.id, source: "codex" }),
    ]));
  });

  test("is idempotent when current and overwrites a changed plain event", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    const first = event("same#0", "human_intent", text("a"));
    await plain.events().insert([first]);
    let calls = 0;
    const fake = provider(async (inputs) => {
      calls++;
      return inputs.map(() => vector(calls));
    });

    await embedPending(plain, vectors, fake, { maxEvents: 10 });
    const repeated = await embedPending(plain, vectors, fake, { maxEvents: 10 });
    expect(repeated).toMatchObject({ up_to_date: 1, selected: 0, embedded: 0, vectors: 1 });
    expect(calls).toBe(1);

    const changed = { ...first, text: text("b"), text_hash: sha256(text("b")) };
    await (await plain.table("events"))
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([changed]);

    const refreshed = await embedPending(plain, vectors, fake, { maxEvents: 10 });
    expect(refreshed).toMatchObject({ up_to_date: 0, selected: 1, embedded: 1, vectors: 1 });
    expect(calls).toBe(2);
    expect(await vectors.eventVectors().metadata()).toEqual([
      expect.objectContaining({ event_id: first.id, text_hash: sha256(embeddingText(changed.text)) }),
    ]);
  });

  test("does not create the vector database when provider output is invalid", async () => {
    const { plain, vector: vectors, vectorDirectory } = await temporaryStores();
    await plain.events().insert([event("invalid#0", "human_intent", text("i"))]);

    await expect(embedPending(plain, vectors, provider(async () => [vector(1).slice(1)]), {
      maxEvents: 1,
      retries: 0,
    })).rejects.toThrow(`expected ${EMBEDDING_DIMENSION}`);

    expect(await vectors.tableNames()).toEqual([]);
    expect(await directoryExists(vectorDirectory)).toBe(false);
    expect(await plain.tableNames()).toEqual(["event_sources", "events", "source_files"]);
  });

  test("rejects non-finite, overflow, and zero-norm vectors before persistence", async () => {
    const cases: Array<[string, () => number[]]> = [
      ["non-finite", () => {
        const invalid = vector(1);
        invalid[0] = Number.NaN;
        return invalid;
      }],
      ["overflow", () => {
        const invalid = vector(1);
        invalid[0] = Number.MAX_VALUE;
        return invalid;
      }],
      ["zero norm", () => Array.from({ length: EMBEDDING_DIMENSION }, () => 0)],
    ];
    for (const [_name, makeInvalid] of cases) {
      const { plain, vector: vectors, vectorDirectory } = await temporaryStores();
      await plain.events().insert([event(`invalid-${_name}#0`, "human_intent", text("i"))]);
      await expect(embedPending(plain, vectors, provider(async () => [makeInvalid()]), {
        maxEvents: 1,
        retries: 0,
      })).rejects.toThrow();
      expect(await directoryExists(vectorDirectory)).toBe(false);
    }
  });

  test("persists completed vector batches and resumes from the plain store after failure", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert([
      event("first#0", "human_intent", text("a"), "2026-08-31T10:00:00.000Z"),
      event("second#0", "human_intent", text("b"), "2026-08-31T09:00:00.000Z"),
      event("third#0", "human_intent", text("c"), "2026-08-31T08:00:00.000Z"),
    ]);
    let calls = 0;
    const unreliable = provider(async (inputs) => {
      calls++;
      if (calls === 2) throw new Error("temporary Ollama outage");
      return inputs.map((_input, index) => vector(index + calls));
    });

    await expect(embedPending(plain, vectors, unreliable, {
      maxEvents: 3,
      batchSize: 2,
      retries: 0,
    })).rejects.toThrow("temporary Ollama outage");
    expect(await vectors.eventVectors().count()).toBe(2);
    expect(await plain.events().count()).toBe(3);

    const resumed = await embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map((_input, index) => vector(index + 10))
    ), { maxEvents: 3, batchSize: 2 });
    expect(resumed).toMatchObject({ up_to_date: 2, selected: 1, embedded: 1, vectors: 3 });
    expect(await plain.events().count()).toBe(3);
  });

  test("retries transient provider failures without retrying malformed vectors", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert([event("retry#0", "human_intent", text("r"))]);
    let attempts = 0;
    const delays: number[] = [];
    const result = await embedPending(plain, vectors, provider(async (inputs) => {
      attempts++;
      if (attempts === 1) throw new Error("connection reset");
      return inputs.map(() => vector(5));
    }), {
      maxEvents: 1,
      retries: 1,
      retryDelayMs: 7,
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    });

    expect(result.embedded).toBe(1);
    expect(attempts).toBe(2);
    expect(delays).toEqual([7]);
  });

  test("checks the complete vector schema, not only embedding metadata", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert([event("bad-contract#0", "human_intent", text("c"))]);
    await (await vectors.connectionForWrite()).createEmptyTable(EVENT_VECTORS_TABLE, new Schema([
      new Field("event_id", new Int32(), false),
      ...EVENT_VECTOR_SCHEMA.fields.slice(1),
    ], new Map(EVENT_VECTOR_SCHEMA.metadata)));

    await expect(embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map(() => vector(1))
    ), { maxEvents: 1 })).rejects.toThrow(`rebuild ${EVENT_VECTORS_TABLE}`);
  });

  test("queries a bounded plain page for --limit instead of materializing the corpus", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert(Array.from({ length: 300 }, (_, index) =>
      event(`large-${String(index).padStart(3, "0")}#0`, "human_intent", text("l"), undefined, "fixture")
    ));
    const calls: string[][] = [];
    const result = await embedPending(plain, vectors, provider(async (inputs) => {
      calls.push(inputs);
      return inputs.map((_input, index) => vector(index + 1));
    }), { source: "fixture", maxEvents: 3, batchSize: 3 });

    expect(result).toMatchObject({
      scanned: 3,
      eligible: 3,
      selected: 3,
      embedded: 3,
      more_may_remain: true,
      vectors: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
  });

  test("scopes embedding by oracle and inclusive Bangkok calendar dates", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    const before = {
      ...event("before#0", "human_intent", text("b"), "2026-08-30T16:59:59.000Z", "claude"),
      project: "sample-oracle",
    };
    const inside = {
      ...event("inside#0", "human_intent", text("i"), "2026-08-30T17:00:00.000Z", "claude"),
      project: "sample-oracle",
      session_id: "neo-session",
    };
    const otherProject = {
      ...event("other-project#0", "human_intent", text("o"), "2026-08-31T12:00:00.000Z", "claude"),
      project: "home-oracle",
    };
    const after = {
      ...event("after#0", "human_intent", text("a"), "2026-08-31T17:00:00.000Z", "claude"),
      project: "sample-oracle",
    };
    await plain.events().insert([before, inside, otherProject, after]);

    const result = await embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map(() => vector(7))
    ), {
      source: "claude",
      project: "sample-oracle",
      since: "2026-08-31",
      until: "2026-08-31",
      maxEvents: 10,
    });

    expect(result).toMatchObject({
      source: "claude",
      project: "sample-oracle",
      since: "2026-08-31",
      until: "2026-08-31",
      selected: 1,
      embedded: 1,
      vectors: 1,
    });
    expect(await vectors.eventVectors().metadata()).toEqual([
      expect.objectContaining({
        event_id: inside.id,
        source: "claude",
        project: "sample-oracle",
        session_id: "neo-session",
        timestamp: "2026-08-30T17:00:00.000Z",
      }),
    ]);
  });

  test("scopes embedding to an exact provenance folder without duplicating events", async () => {
    const { root, plain, vector: vectors } = await temporaryStores();
    const wantedFolder = join(root, "projects", "sample-oracle");
    const otherFolder = join(root, "projects", "home-oracle");
    const wanted = {
      ...event("wanted#0", "human_intent", text("w"), undefined, "claude"),
      project: "sample-oracle",
    };
    const other = {
      ...event("other#0", "human_intent", text("o"), undefined, "claude"),
      project: "home-oracle",
    };
    await plain.events().insert([wanted, other]);
    const occurrence = (
      id: string,
      eventRow: EventRow,
      filePath: string,
    ): EventSourceRow => ({
      id,
      event_id: eventRow.id,
      source: eventRow.source,
      file_path: filePath,
      file_hash: sha256(filePath),
      source_line: 1,
      observed_text_hash: eventRow.text_hash,
    });
    await plain.occurrences().insert([
      occurrence("wanted-source-1", wanted, join(wantedFolder, "session-a.jsonl")),
      occurrence("wanted-source-2", wanted, join(wantedFolder, "session-b.jsonl")),
      occurrence("other-source", other, join(otherFolder, "session.jsonl")),
    ]);

    const result = await embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map(() => vector(8))
    ), { source: "claude", folder: wantedFolder, maxEvents: 10 });

    expect(result).toMatchObject({
      source: "claude",
      folder: wantedFolder,
      selected: 1,
      embedded: 1,
      vectors: 1,
    });
    expect((await vectors.eventVectors().metadata()).map((row) => row.event_id)).toEqual([
      wanted.id,
    ]);
  });

  test("validates embedding date scopes before calling the provider", async () => {
    expect(embeddingDateRange("2026-08-31", "2026-08-31")).toEqual({
      sinceInclusive: "2026-08-30T17:00:00.000Z",
      untilExclusive: "2026-08-31T17:00:00.000Z",
    });
    expect(() => embeddingDateRange("2026-8-31")).toThrow("since must use YYYY-MM-DD");
    expect(() => embeddingDateRange("2026-09-01", "2026-08-31")).toThrow(
      "since must not be after until",
    );

    const { plain, vector: vectors, vectorDirectory } = await temporaryStores();
    await plain.events().insert([event("invalid-date#0", "human_intent", text("d"))]);
    let providerCalls = 0;
    await expect(embedPending(plain, vectors, provider(async (inputs) => {
      providerCalls++;
      return inputs.map(() => vector(1));
    }), { since: "2026-8-31" })).rejects.toThrow("since must use YYYY-MM-DD");
    expect(providerCalls).toBe(0);
    expect(await directoryExists(vectorDirectory)).toBe(false);
  });

  test("uses a token-owned vector lock so a contender cannot delete another writer's lease", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert([event("lock#0", "human_intent", text("l"))]);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseProvider!: () => void;
    const held = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const first = embedPending(plain, vectors, provider(async (inputs) => {
      markStarted();
      await held;
      return inputs.map(() => vector(1));
    }), { maxEvents: 1 });

    await started;
    await expect(embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map(() => vector(2))
    ), { maxEvents: 1 })).rejects.toThrow("writer is already active");
    releaseProvider();
    await expect(first).resolves.toMatchObject({ embedded: 1 });

    const lockPath = `${vectors.directory}.${EVENT_VECTORS_TABLE}.lock`;
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  test("does not break a pre-existing vector lock it does not own", async () => {
    const { plain, vector: vectors } = await temporaryStores();
    await plain.events().insert([event("external-lock#0", "human_intent", text("l"))]);
    const lockPath = `${vectors.directory}.${EVENT_VECTORS_TABLE}.lock`;
    const owner = { token: "someone-else", pid: process.pid, started_at: "2026-08-31T00:00:00.000Z" };
    await writeFile(lockPath, JSON.stringify(owner), "utf8");

    await expect(embedPending(plain, vectors, provider(async (inputs) =>
      inputs.map(() => vector(1))
    ), { maxEvents: 1 })).rejects.toThrow("writer is already active");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(owner);
  });

  test("CLI routes DB_DIR to plain and VECTOR_DB_DIR to optional vector storage", async () => {
    const { plain, vector: vectors, plainDirectory, vectorDirectory } = await temporaryStores();
    await plain.events().insert([event("cli#0", "human_intent", text("q"))]);
    const requests: string[][] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: ACTIVE_EMBEDDING_SPACE.revision }],
          });
        }
        if (url.pathname !== "/api/embed") return new Response("not found", { status: 404 });
        const body = await request.json() as { input: string[] };
        requests.push(body.input);
        await Bun.sleep(25);
        return Response.json({ embeddings: body.input.map((_input, index) => vector(index + 1)) });
      },
    });
    try {
      const statusChild = Bun.spawn(["bun", "src/cli.ts", "status"], {
        cwd: LAB,
        env: { ...process.env, DB_DIR: plainDirectory, VECTOR_DB_DIR: vectorDirectory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [statusOutput, statusCode] = await Promise.all([
        new Response(statusChild.stdout).text(),
        statusChild.exited,
      ]);
      expect(statusCode).toBe(0);
      expect(JSON.parse(statusOutput)).toMatchObject({
        database: plainDirectory,
        databases: { vector: { directory: vectorDirectory, tables: [] } },
        counts: { event_vectors: 0 },
      });
      expect(await directoryExists(vectorDirectory)).toBe(false);

      const child = Bun.spawn([
        "bun", "src/cli.ts", "embed",
        "--source", "fixture",
        "--oracle", "embedding-lab",
        "--since", "2026-08-31",
        "--until", "2026-08-31",
        "--limit", "1",
        "--batch-size", "1",
      ], {
        cwd: LAB,
        env: {
          ...process.env,
          DB_DIR: plainDirectory,
          VECTOR_DB_DIR: vectorDirectory,
          OLLAMA_URL: server.url.toString(),
          JSCAN_PROGRESS_INTERVAL_MS: "5",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        source: "fixture",
        project: "embedding-lab",
        since: "2026-08-31",
        until: "2026-08-31",
        selected: 1,
        embedded: 1,
        vectors: 1,
      });
      expect(stdout).not.toContain("[jscan]");
      expect(stderr).toContain("[jscan] embed start 0/1");
      expect(stderr).toContain("[jscan] embed progress 0/1");
      expect(stderr).toContain("[jscan] embed complete 1/1");
      expect(requests).toEqual([[text("q")]]);
      expect(await plain.tableNames()).toEqual(["event_sources", "events", "source_files"]);
      expect(await vectors.tableNames()).toEqual([EVENT_VECTORS_TABLE]);
    } finally {
      server.stop(true);
    }
  });
});
