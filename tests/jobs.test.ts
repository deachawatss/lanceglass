import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/database";
import { plan } from "../src/importer";
import { drainJobStream, JobManager } from "../src/jobs";

const temporaryDirectories: string[] = [];
const managers: JobManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function record(index: number) {
  return JSON.stringify({
    type: "user",
    uuid: `job-${index}`,
    sessionId: "job-session",
    timestamp: "2026-08-31T00:00:00.000Z",
    cwd: "/job-test",
    message: { role: "user", content: `job line ${index}` },
  });
}

async function fixture(lines: number) {
  const directory = await mkdtemp(join(tmpdir(), "jscan-job-test-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "job.jsonl"),
    Array.from({ length: lines }, (_, index) => record(index)).join("\n") + "\n");
  const dbDir = join(directory, "lancedb");
  const db = (await Database.open(dbDir)).plain;
  await db.create();
  const spec = { source: "fixture", root: directory };
  const planned = await plan(db, spec);
  return { directory, dbDir, spec, planned };
}

async function terminal(manager: JobManager, id: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = manager.get(id)!;
    if (job.state !== "running" && job.state !== "cancelling") return job;
    await Bun.sleep(25);
  }
  throw new Error("job did not finish");
}

describe("import jobs", () => {
  test("shutdown waits for an active synchronous writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jscan-job-test-"));
    temporaryDirectories.push(directory);
    const manager = new JobManager(join(directory, "lancedb"));
    managers.push(manager);
    expect(manager.tryAcquireSync()).toBe(true);
    let stopped = false;
    const shutdown = manager.shutdown().then(() => { stopped = true; });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    manager.releaseSync();
    await shutdown;
    expect(stopped).toBe(true);
    expect(manager.tryAcquireSync()).toBe(false);
  });

  test("decodes split UTF-8 chunks and emits a final unterminated fragment", async () => {
    const bytes = new TextEncoder().encode("first 🌱\nfinal 🌕");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
        controller.enqueue(bytes.subarray(8, 11));
        controller.enqueue(bytes.subarray(11));
        controller.close();
      },
    });
    const lines: string[] = [];
    await drainJobStream(stream, "stdout", (_stream, line) => lines.push(line));
    expect(lines).toEqual(["first 🌱", "final 🌕"]);
  });

  test("captures streamed logs and the final ImportReport", async () => {
    const { dbDir, spec, planned } = await fixture(2);
    const manager = new JobManager(dbDir);
    managers.push(manager);
    const job = manager.start({
      mode: "all",
      spec,
      expectedPlanRevision: planned.plan_revision,
      expectedWillParse: planned.will_parse,
    });
    expect(job).toBeDefined();

    const finished = await terminal(manager, job!.id);
    expect(finished.state).toBe("succeeded");
    expect(finished.result).toEqual(expect.objectContaining({ selected_files: 1, inserted: 2 }));
    const log = manager.logs(job!.id, 0)!;
    expect(log.next).toBeGreaterThan(0);
    expect(log.lines.some((entry) => entry.stream === "stderr" && entry.line.includes("[jscan]"))).toBe(true);
    expect(log.lines.some((entry) => entry.stream === "stdout" && entry.line.includes("{"))).toBe(true);

    // Exercise the bounded ring directly; stream integration above proves the same append path.
    const internals = manager as unknown as {
      jobs: unknown[];
      appendLine(job: unknown, stream: "stdout" | "stderr", value: string): void;
    };
    for (let index = 0; index < 510; index++) {
      internals.appendLine(internals.jobs[0], "stderr", `ring-${index}`);
    }
    internals.appendLine(internals.jobs[0], "stderr", "x".repeat(70 * 1024));
    const truncated = manager.logs(job!.id, 0)!;
    expect(truncated.truncated).toBe(true);
    expect(truncated.lines).toHaveLength(500);
    expect(truncated.lines[0].offset).toBe(truncated.from);
    expect(truncated.next).toBe(truncated.lines.at(-1)!.offset + 1);
    expect(Buffer.byteLength(truncated.lines.at(-1)!.line)).toBeLessThanOrEqual(64 * 1024);
    expect(truncated.lines.at(-1)!.line).toContain("line truncated");
    const future = manager.logs(job!.id, truncated.next + 10_000)!;
    expect(future.from).toBe(future.next);
    expect(future.offset).toBe(future.next);
    expect(future.lines).toEqual([]);
  });

  test("refreshes a stale live-source plan at job start", async () => {
    const { directory, dbDir, spec, planned } = await fixture(1);
    await writeFile(join(directory, "job.jsonl"), `${record(0)}\n${record(1)}\n`);
    const manager = new JobManager(dbDir);
    managers.push(manager);
    const job = manager.start({
      mode: "all",
      spec,
      expectedPlanRevision: planned.plan_revision,
      expectedWillParse: planned.will_parse,
      planPolicy: "refresh",
    });

    const finished = await terminal(manager, job!.id);
    expect(finished.state).toBe("succeeded");
    expect(finished.plan_policy).toBe("refresh");
    expect(finished.result).toEqual(expect.objectContaining({ parsed_records: 2, selected_files: 1 }));
    expect(manager.logs(job!.id, 0)!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: expect.stringContaining("refreshing the plan at job start") }),
    ]));
  });

  test("allows only one writer and cancellation reaches a terminal state", async () => {
    const { dbDir, spec, planned } = await fixture(20_000);
    const manager = new JobManager(dbDir);
    managers.push(manager);
    const job = manager.start({
      mode: "all",
      spec,
      expectedPlanRevision: planned.plan_revision,
      expectedWillParse: planned.will_parse,
    });
    expect(job).toBeDefined();
    expect(manager.start({
      mode: "all",
      spec,
      expectedPlanRevision: planned.plan_revision,
      expectedWillParse: planned.will_parse,
    })).toBeUndefined();
    expect(manager.tryAcquireSync()).toBe(false);

    expect(manager.cancel(job!.id)?.state).toBe("cancelling");
    const finished = await terminal(manager, job!.id);
    expect(finished.state).toBe("cancelled");
    expect(manager.activeId).toBeUndefined();
    expect(manager.tryAcquireSync()).toBe(true);
    manager.releaseSync();
  });
});
