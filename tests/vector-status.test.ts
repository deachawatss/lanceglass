import { afterEach, describe, expect, test } from "bun:test";
import { Field, Int32, Schema } from "apache-arrow";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/database";
import { EVENT_VECTORS_TABLE } from "../src/schemas";

const LAB = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function malformedStores() {
  const root = await mkdtemp(join(tmpdir(), "jscan-vector-status-"));
  temporaryDirectories.push(root);
  const plainDirectory = join(root, "database.plain");
  const vectorDirectory = join(root, "database.vector");
  const db = await Database.open(plainDirectory, vectorDirectory);
  await db.plain.create();
  await (await db.vector.connectionForWrite()).createEmptyTable(
    EVENT_VECTORS_TABLE,
    new Schema([new Field("event_id", new Int32(), false)]),
  );
  return { db, plainDirectory, vectorDirectory };
}

async function readProcess(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("optional vector status", () => {
  test("CLI status preserves plain counts and reports a malformed vector store", async () => {
    const { db, plainDirectory, vectorDirectory } = await malformedStores();
    await db.plain.events().insert([]);

    const result = await readProcess(Bun.spawn(["bun", "src/cli.ts", "status"], {
      cwd: LAB,
      env: { ...process.env, PLAIN_DB_DIR: plainDirectory, VECTOR_DB_DIR: vectorDirectory },
      stdout: "pipe",
      stderr: "pipe",
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      database: plainDirectory,
      tables: ["event_sources", "events", "source_files"],
      counts: { events: 0, event_sources: 0, source_files: 0, event_vectors: null },
      databases: {
        plain: { directory: plainDirectory },
        vector: {
          directory: vectorDirectory,
          present: true,
          health: "error",
          tables: [EVENT_VECTORS_TABLE],
          event_vectors: null,
        },
      },
    });
    expect(JSON.parse(result.stdout).databases.vector.error).toContain("contract mismatch");

    await expect(db.vector.eventVectors().count()).rejects.toThrow("contract mismatch");
  });

  test("GET /api/status remains available when optional vectors are malformed", async () => {
    const { plainDirectory, vectorDirectory } = await malformedStores();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);

    const child = Bun.spawn(["bun", "src/server.ts"], {
      cwd: LAB,
      env: {
        ...process.env,
        PORT: String(port),
        PLAIN_DB_DIR: plainDirectory,
        VECTOR_DB_DIR: vectorDirectory,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        response = await fetch(`http://127.0.0.1:${port}/api/status`).catch(() => undefined);
        if (response) break;
        await Bun.sleep(20);
      }
      expect(response?.status).toBe(200);
      const body = await response!.json() as Record<string, any>;
      expect(body).toMatchObject({
        db_dir: plainDirectory,
        tables: { events: 0, event_sources: 0, source_files: 0 },
        databases: {
          plain: { directory: plainDirectory },
          vector: {
            directory: vectorDirectory,
            present: true,
            health: "error",
            tables: [EVENT_VECTORS_TABLE],
            event_vectors: null,
          },
        },
      });
      expect(body.databases.vector.error).toContain("contract mismatch");
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
});
