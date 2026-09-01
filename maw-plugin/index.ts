import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type InvokeContext = {
  source?: string;
  args?: unknown;
  writer?: (...values: unknown[]) => unknown | PromiseLike<unknown>;
  errorWriter?: (...values: unknown[]) => unknown | PromiseLike<unknown>;
  signal?: AbortSignal;
};

type InvokeResult = { ok: boolean; output?: string; error?: string };
type ChildSignal = "SIGINT" | "SIGTERM";
type SignalProcess = {
  once(event: ChildSignal, listener: () => void): void;
  off(event: ChildSignal, listener: () => void): void;
};
type OutputStream = {
  write(value: string, callback: (error?: Error | null) => void): boolean;
};

export const command = {
  name: "jsonl-scanner",
  description: "Import and inspect JSONL through the Lanceglass LanceDB engine.",
};

const entryDirectory = dirname(realpathSync(fileURLToPath(import.meta.url)));

function projectRoot() {
  const sourceRoot = resolve(entryDirectory, "..");
  if (existsSync(join(sourceRoot, "src", "cli.ts"))) return sourceRoot;

  const marker = join(entryDirectory, "project-root.txt");
  if (!existsSync(marker)) throw new Error(`missing installed project root marker: ${marker}`);
  const installedRoot = readFileSync(marker, "utf8").trim();
  if (!existsSync(join(installedRoot, "src", "cli.ts"))) {
    throw new Error(`Lanceglass source not found: ${installedRoot}`);
  }
  return installedRoot;
}

function option(args: string[], name: string, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function forward(
  stream: ReadableStream<Uint8Array>,
  emit: (...values: unknown[]) => unknown | PromiseLike<unknown>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) await emit(line);
  }
  pending += decoder.decode();
  if (pending) await emit(pending);
}

async function run(
  commandLine: string[],
  root: string,
  emitStdout: (...values: unknown[]) => unknown | PromiseLike<unknown>,
  emitStderr: (...values: unknown[]) => unknown | PromiseLike<unknown>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = Bun.spawn(commandLine, {
    cwd: root,
    env: { ...process.env },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = forward(child.stdout, emitStdout);
  const stderr = forward(child.stderr, emitStderr);
  const terminate = (childSignal: ChildSignal = "SIGTERM") => {
    if (child.exitCode === null) child.kill(childSignal);
  };
  const onSigint = () => terminate("SIGINT");
  const onSigterm = () => terminate("SIGTERM");
  const onAbort = () => terminate();
  const signalProcess = process as unknown as SignalProcess;
  signalProcess.once("SIGINT", onSigint);
  signalProcess.once("SIGTERM", onSigterm);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [, , code] = await Promise.all([stdout, stderr, child.exited]);
    signal?.throwIfAborted();
    return code;
  } catch (error) {
    terminate();
    await Promise.allSettled([stdout, stderr, child.exited]);
    throw error;
  } finally {
    signalProcess.off("SIGINT", onSigint);
    signalProcess.off("SIGTERM", onSigterm);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function help(emit: (...values: unknown[]) => unknown | PromiseLike<unknown>) {
  await emit("Lanceglass · LanceDB via maw");
  await emit("");
  await emit("  maw jscan choose");
  await emit("  maw jscan init");
  await emit("  maw jscan schema");
  await emit("  maw jscan normalize --file <session.jsonl> [--source fixture]");
  await emit("  maw jscan plan [--source claude|codex|fixture] [--root <directory>]");
  await emit("  maw jscan import [--source claude|codex|fixture] [--root <directory>] [--max-files 1]");
  await emit("  maw jscan embed providers");
  await emit("  maw jscan embed probe [--deployment m5-ollama|dual-4090|cloudflare]");
  await emit("  maw jscan embed run [--deployment m5-ollama|dual-4090|cloudflare] [--source claude|codex|fixture] [--project <oracle>|--oracle <oracle>] [--folder <directory>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit 300] [--batch-size 8]");
  await emit("  maw jscan status");
  await emit("  maw jscan events [--source claude|codex|fixture] [--limit 20]");
  await emit("  maw jscan ui [--port 4320]");
  await emit("");
  await emit("Default: Claude Code (~/.claude/projects). Codex: --source codex.");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const output: string[] = [];
  const emit = async (...values: unknown[]) => {
    if (ctx.writer) await ctx.writer(...values);
    else output.push(values.map(String).join(" "));
  };
  const emitError = ctx.errorWriter ?? ((...values: unknown[]) => writeStream(
    process.stderr,
    values.map(String).join(" ") + "\n",
  ));
  const done = (ok: boolean, error?: string): InvokeResult => ({
    ok,
    error,
    output: output.join("\n") || undefined,
  });

  try {
    const args = (ctx.source === "cli" ? ctx.args as string[] : []) ?? [];
    const subcommand = args[0] ?? "help";
    if (["help", "--help", "-h"].includes(subcommand)) {
      await help(emit);
      return done(true);
    }

    const root = projectRoot();
    if (subcommand === "ui") {
      const buildCode = await run(["bun", "run", "ui:build"], root, emit, emitError, ctx.signal);
      if (buildCode !== 0) return done(false, `UI build exited ${buildCode}`);

      const port = option(args.slice(1), "port", process.env.PORT ?? "4320");
      const priorPort = process.env.PORT;
      process.env.PORT = port;
      await emit(`starting Lanceglass on http://127.0.0.1:${port}`);
      const code = await run(["bun", "src/server.ts"], root, emit, emitError, ctx.signal);
      if (priorPort === undefined) delete process.env.PORT;
      else process.env.PORT = priorPort;
      return done(code === 0, code === 0 ? undefined : `UI server exited ${code}`);
    }

    const code = await run(["bun", "src/cli.ts", ...args], root, emit, emitError, ctx.signal);
    return done(code === 0, code === 0 ? undefined : `LanceDB CLI exited ${code}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await emitError(`error: ${message}`);
    } catch {
      // The original child/read/write failure is the useful handler result.
    }
    return done(false, message);
  }
}

function writeStream(stream: OutputStream, value: string) {
  return new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}

if (import.meta.main) {
  const write = (...values: unknown[]) => writeStream(process.stdout, values.map(String).join(" ") + "\n");
  const writeError = (...values: unknown[]) => writeStream(process.stderr, values.map(String).join(" ") + "\n");
  const result = await handler({
    source: "cli",
    args: process.argv.slice(2),
    writer: write,
    errorWriter: writeError,
  });
  if (result.output) await write(result.output);
  process.exitCode = result.ok ? 0 : 1;
}
