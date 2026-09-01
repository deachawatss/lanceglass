import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ImportReport, SourceSpec } from "./types";

export type ImportJobMode = "batch" | "all";
export type ImportPlanPolicy = "exact" | "refresh";
export type ImportJobState =
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ImportJobRequest = {
  mode: ImportJobMode;
  spec: SourceSpec;
  expectedPlanRevision: string;
  expectedWillParse: number;
  planPolicy?: ImportPlanPolicy;
  maxFiles?: number;
};

export type JobLogLine = {
  offset: number;
  stream: "stdout" | "stderr";
  line: string;
};

export type ImportJob = {
  id: string;
  kind: "import";
  mode: ImportJobMode;
  state: ImportJobState;
  source: string;
  root: string;
  max_files?: number;
  plan_revision: string;
  expected_will_parse: number;
  plan_policy: ImportPlanPolicy;
  created_at: string;
  started_at: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
  result?: ImportReport;
};

type InternalJob = ImportJob & {
  child?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  done: Promise<void>;
  resolveDone: () => void;
  lines: JobLogLine[];
  nextOffset: number;
  killTimer?: ReturnType<typeof setTimeout>;
};

const MAX_JOBS = 50;
const MAX_LOG_LINES = 500;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 1_500;

function publicJob(job: InternalJob): ImportJob {
  const {
    child: _child,
    done: _done,
    resolveDone: _resolveDone,
    lines: _lines,
    nextOffset: _nextOffset,
    killTimer: _killTimer,
    ...result
  } = job;
  return result;
}

function boundedLine(value: string) {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_LINE_BYTES) return value;
  const suffix = `… [line truncated: ${bytes} bytes]`;
  return Buffer.from(value).subarray(0, MAX_LINE_BYTES - Buffer.byteLength(suffix)).toString() + suffix;
}

export async function drainJobStream(
  stream: ReadableStream<Uint8Array>,
  name: JobLogLine["stream"],
  line: (stream: JobLogLine["stream"], value: string) => void,
  capture?: (chunk: Uint8Array) => void,
) {
  const decoder = new TextDecoder();
  let pending = "";
  let pendingBytes = 0;
  let lineBytes = 0;
  const append = (value: string) => {
    const bytes = Buffer.from(value);
    lineBytes += bytes.byteLength;
    const available = Math.max(0, MAX_LINE_BYTES - 128 - pendingBytes);
    if (!available) return;
    const addition = bytes.subarray(0, available).toString("utf8");
    pending += addition;
    pendingBytes += Buffer.byteLength(addition);
  };
  const emit = () => {
    if (pending.endsWith("\r")) {
      pending = pending.slice(0, -1);
      pendingBytes--;
      lineBytes--;
    }
    const value = lineBytes > pendingBytes
      ? `${pending}… [line truncated: ${lineBytes} bytes]`
      : pending;
    line(name, value);
    pending = "";
    pendingBytes = 0;
    lineBytes = 0;
  };
  for await (const chunk of stream) {
    capture?.(chunk);
    let decoded = decoder.decode(chunk, { stream: true });
    let newline = decoded.indexOf("\n");
    while (newline >= 0) {
      append(decoded.slice(0, newline).replace(/\r$/, ""));
      emit();
      decoded = decoded.slice(newline + 1);
      newline = decoded.indexOf("\n");
    }
    append(decoded);
  }
  append(decoder.decode());
  if (lineBytes) emit();
}

export class JobManager {
  private jobs: InternalJob[] = [];
  private writerOwner: "sync" | string | undefined;
  private syncDone: Promise<void> | undefined;
  private resolveSyncDone: (() => void) | undefined;
  private shuttingDown = false;

  constructor(private readonly dbDir: string) {}

  get activeId() {
    return this.writerOwner && this.writerOwner !== "sync" ? this.writerOwner : undefined;
  }

  isBusy() {
    return Boolean(this.writerOwner);
  }

  tryAcquireSync() {
    if (this.writerOwner || this.shuttingDown) return false;
    this.writerOwner = "sync";
    this.syncDone = new Promise<void>((resolve) => { this.resolveSyncDone = resolve; });
    return true;
  }

  releaseSync() {
    if (this.writerOwner !== "sync") return;
    this.writerOwner = undefined;
    this.resolveSyncDone?.();
    this.resolveSyncDone = undefined;
    this.syncDone = undefined;
  }

  list() {
    return this.jobs.map(publicJob).reverse();
  }

  get(id: string) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    return job ? publicJob(job) : undefined;
  }

  logs(id: string, from: number) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) return undefined;
    const earliest = job.lines[0]?.offset ?? job.nextOffset;
    const requested = Math.max(0, Math.trunc(from));
    const truncated = requested < earliest;
    const effective = Math.min(Math.max(requested, earliest), job.nextOffset);
    return {
      job: publicJob(job),
      offset: effective,
      from: effective,
      next: job.nextOffset,
      truncated,
      lines: job.lines.filter((entry) => entry.offset >= effective),
    };
  }

  start(request: ImportJobRequest) {
    if (this.writerOwner || this.shuttingDown) return undefined;
    const id = randomUUID();
    this.writerOwner = id;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const now = new Date().toISOString();
    const job: InternalJob = {
      id,
      kind: "import",
      mode: request.mode,
      state: "running",
      source: request.spec.source,
      root: request.spec.root,
      max_files: request.mode === "batch" ? request.maxFiles : undefined,
      plan_revision: request.expectedPlanRevision,
      expected_will_parse: request.expectedWillParse,
      plan_policy: request.planPolicy ?? "exact",
      created_at: now,
      started_at: now,
      done,
      resolveDone,
      lines: [],
      nextOffset: 0,
    };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.splice(0, this.jobs.length - MAX_JOBS);
    this.run(job, request);
    return publicJob(job);
  }

  cancel(id: string) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) return undefined;
    if (job.state !== "running" && job.state !== "cancelling") return publicJob(job);
    if (job.state === "running") {
      job.state = "cancelling";
      job.child?.kill("SIGTERM");
      job.killTimer = setTimeout(() => {
        if (job.state === "cancelling") job.child?.kill("SIGKILL");
      }, KILL_GRACE_MS);
      job.killTimer.unref();
    }
    return publicJob(job);
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.writerOwner === "sync") {
      await this.syncDone;
      return;
    }
    const active = this.activeId;
    if (!active) return;
    const job = this.jobs.find((candidate) => candidate.id === active);
    if (!job) return;
    this.cancel(active);
    await job.done;
  }

  private appendLine(job: InternalJob, stream: JobLogLine["stream"], value: string) {
    job.lines.push({ offset: job.nextOffset++, stream, line: boundedLine(value) });
    if (job.lines.length > MAX_LOG_LINES) job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
  }

  private finish(job: InternalJob, state: ImportJobState, error?: string) {
    if (job.killTimer) clearTimeout(job.killTimer);
    job.state = state;
    job.finished_at = new Date().toISOString();
    if (error) job.error = error;
    if (this.writerOwner === job.id) this.writerOwner = undefined;
    job.resolveDone();
  }

  private async run(job: InternalJob, request: ImportJobRequest) {
    const argv = [
      process.execPath,
      "src/cli.ts",
      "import",
      "--root", request.spec.root,
      "--source", request.spec.source,
    ];
    if ((request.planPolicy ?? "exact") === "exact") {
      argv.push(
        "--expect-plan", request.expectedPlanRevision,
        "--expect-count", String(request.expectedWillParse),
      );
    } else {
      this.appendLine(
        job,
        "stderr",
        `[jscan] live source: refreshing the plan at job start; confirmation saw ${request.expectedWillParse} pending file(s)`,
      );
    }
    if (request.mode === "batch") argv.push("--max-files", String(request.maxFiles));

    let stdoutBytes = 0;
    let stdoutOverflow = false;
    const stdoutChunks: Uint8Array[] = [];
    try {
      job.child = Bun.spawn(argv, {
        cwd: join(import.meta.dir, ".."),
        // Import jobs have no reason to know about vectors. Set both names so
        // an inherited PLAIN_DB_DIR cannot accidentally point the child at a
        // different ordinary store than the server that started it.
        env: { ...process.env, DB_DIR: this.dbDir, PLAIN_DB_DIR: this.dbDir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      this.appendLine(job, "stderr", error instanceof Error ? error.message : String(error));
      this.finish(job, "failed", "failed to spawn import process");
      return;
    }

    const stdout = drainJobStream(
      job.child.stdout,
      "stdout",
      (stream, value) => this.appendLine(job, stream, value),
      (chunk) => {
        if (stdoutOverflow) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_RESULT_BYTES) {
          stdoutOverflow = true;
          stdoutChunks.length = 0;
          return;
        }
        stdoutChunks.push(chunk.slice());
      },
    );
    const stderr = drainJobStream(
      job.child.stderr,
      "stderr",
      (stream, value) => this.appendLine(job, stream, value),
    );

    let exitCode: number;
    try {
      exitCode = await job.child.exited;
      job.exit_code = exitCode;
      const drains = await Promise.allSettled([stdout, stderr]);
      const drainFailure = drains.find((result) => result.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      if (drainFailure) throw drainFailure.reason;
    } catch (error) {
      this.finish(job, job.state === "cancelling" ? "cancelled" : "failed",
        `import process failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (job.state === "cancelling") {
      this.finish(job, "cancelled");
      return;
    }
    if (exitCode !== 0) {
      this.finish(job, "failed", `import exited with code ${exitCode}`);
      return;
    }
    if (stdoutOverflow) {
      this.finish(job, "failed", "import result exceeded output limit");
      return;
    }
    try {
      const bytes = Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk)));
      job.result = JSON.parse(bytes.toString("utf8")) as ImportReport;
      this.finish(job, "succeeded");
    } catch (error) {
      this.finish(job, "failed", `invalid import result: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
