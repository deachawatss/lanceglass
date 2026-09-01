import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import handler from "./index";

const encoder = new TextEncoder();
const realSpawn = Bun.spawn.bind(Bun);
let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
const labRoot = resolve(import.meta.dir, "..");

beforeEach(() => {
  spawn = spyOn(Bun, "spawn");
});
afterEach(() => spawn.mockRestore());

function completedChild(stdout: string, stderr = "") {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (stdout) controller.enqueue(encoder.encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderr) controller.enqueue(encoder.encode(stderr));
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    exitCode: 0,
    kill() {},
  };
}

function runningChild() {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let exited = false;
  const child = {
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => { stdout = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => { stderr = controller; } }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }).then((code) => {
      exited = true;
      return code;
    }),
    exitCode: null as number | null,
    signals: [] as string[],
    kill(signal = "SIGTERM") {
      if (this.exitCode !== null) return;
      this.signals.push(String(signal));
      this.exitCode = 143;
      stdout.close();
      stderr.close();
      resolveExit(143);
    },
  };
  return { child, stdout, stderr, didExit: () => exited };
}

describe("maw plugin streaming", () => {
  test("awaits each stdout sink write before forwarding the next line", async () => {
    spawn.mockReturnValue(completedChild("first\nsecond\n") as never);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const lines: string[] = [];

    const result = handler({
      source: "cli",
      args: ["plan"],
      writer: async (value) => {
        lines.push(String(value));
        if (lines.length === 1) await blocked;
      },
      errorWriter: () => {},
    });

    await Bun.sleep(0);
    expect(lines).toEqual(["first"]);
    release();
    expect(await result).toEqual({ ok: true, error: undefined, output: undefined });
    expect(lines).toEqual(["first", "second"]);
  });

  test("terminates and awaits the child when a sink write fails", async () => {
    const running = runningChild();
    spawn.mockReturnValue(running.child as never);
    running.stdout.enqueue(encoder.encode("result\n"));

    const result = await handler({
      source: "cli",
      args: ["plan"],
      writer: () => { throw new Error("stdout closed"); },
      errorWriter: () => {},
    });

    expect(result).toEqual({ ok: false, error: "stdout closed", output: undefined });
    expect(running.child.signals).toEqual(["SIGTERM"]);
    expect(running.didExit()).toBe(true);
  });

  test("returns the original failure when error reporting also fails", async () => {
    const running = runningChild();
    spawn.mockReturnValue(running.child as never);
    running.stderr.enqueue(encoder.encode("progress\n"));

    const result = await handler({
      source: "cli",
      args: ["plan"],
      errorWriter: () => { throw new Error("stderr closed"); },
    });

    expect(result).toEqual({ ok: false, error: "stderr closed", output: undefined });
    expect(running.child.signals).toEqual(["SIGTERM"]);
    expect(running.didExit()).toBe(true);
  });

  test("propagates AbortSignal cancellation and awaits child exit", async () => {
    const running = runningChild();
    spawn.mockReturnValue(running.child as never);
    const controller = new AbortController();
    const result = handler({
      source: "cli",
      args: ["plan"],
      signal: controller.signal,
      errorWriter: () => {},
    });

    await Bun.sleep(0);
    controller.abort(new Error("cancelled"));

    expect(await result).toEqual({ ok: false, error: "cancelled", output: undefined });
    expect(running.child.signals).toEqual(["SIGTERM"]);
    expect(running.didExit()).toBe(true);
  });

  test("forwards termination signals to the child and removes its listeners", async () => {
    const running = runningChild();
    spawn.mockReturnValue(running.child as never);
    const priorListeners = process.listenerCount("SIGINT");
    const result = handler({
      source: "cli",
      args: ["plan"],
      errorWriter: () => {},
    });

    await Bun.sleep(0);
    expect(process.listenerCount("SIGINT")).toBe(priorListeners + 1);
    process.emit("SIGINT");

    expect(await result).toEqual({ ok: false, error: "LanceDB CLI exited 143", output: undefined });
    expect(running.child.signals).toEqual(["SIGINT"]);
    expect(running.didExit()).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(priorListeners);
  });

  test("real CLI preserves a large JSON result for a slow stdout consumer", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "jscan-maw-stream-"));
    const fixture = join(temporary, "fixture");
    const database = join(temporary, "database");
    const session = join(fixture, "large-session.jsonl");
    try {
      mkdirSync(fixture);
      const records = Array.from({ length: 200 }, (_, index) => JSON.stringify({
        type: "user",
        uuid: `large-${index}`,
        sessionId: "large-stream-session",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        cwd: "/stream-regression",
        message: { role: "user", content: `${index}: ${"payload ".repeat(256)}` },
      })).join("\n") + "\n";
      writeFileSync(session, records);
      const env = { ...process.env, DB_DIR: database };
      const imported = realSpawn([
        "bun", "src/cli.ts", "import", "--root", fixture, "--source", "fixture",
      ], { cwd: labRoot, env, stdout: "pipe", stderr: "pipe" });
      const [importCode, importStdout, importStderr] = await Promise.all([
        imported.exited,
        new Response(imported.stdout).text(),
        new Response(imported.stderr).text(),
      ]);
      expect(importCode, importStderr).toBe(0);
      expect(JSON.parse(importStdout).inserted).toBe(200);

      const plugin = realSpawn([
        "bun", "maw-plugin/index.ts", "events", "--source", "fixture", "--limit", "200",
      ], { cwd: labRoot, env, stdout: "pipe", stderr: "pipe" });
      const stderr = new Response(plugin.stderr).text();
      const reader = plugin.stdout.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        await Bun.sleep(2);
      }
      const code = await plugin.exited;
      const errors = await stderr;
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const events = JSON.parse(new TextDecoder().decode(bytes));

      expect(code, errors).toBe(0);
      expect(events).toHaveLength(200);
      expect(events[199].text).toContain("payload payload");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});
