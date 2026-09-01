import {
  DEFAULT_PLAIN_DB_DIR,
  Database,
  defaultVectorDirectoryForSpace,
  sql,
} from "./database";
import {
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_EMBED_LIMIT,
  embedPending,
  embeddingProviderRegistry,
  validateEmbeddingVectors,
  type EmbedProgress,
} from "./embeddings";
import { importSource, plan, preview } from "./importer";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EMBEDDING_TEXT_POLICY,
  EVENT_VECTORS_TABLE,
  schemaDescription,
} from "./schemas";
import { resolveSourceSpec } from "./sources";
import type { ImportProgress, ProgressCallback } from "./types";

const args = Bun.argv.slice(2);
const command = args[0] ?? "help";
const DEFAULT_EMBEDDING_DEPLOYMENT = "m5-ollama";

function option(name: string, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function integer(name: string, fallback: number) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}

function sourceSpec() {
  return resolveSourceSpec(option("root"), option("source"));
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

async function optionalVectorStatus(db: Awaited<ReturnType<typeof Database.open>>) {
  let present: boolean | null = null;
  let tables: string[] = [];
  try {
    present = await db.vector.exists();
    if (!present) {
      return { directory: db.vector.directory, present, health: "missing", error: null, tables, event_vectors: 0 };
    }
    tables = await db.vector.tableNames();
    return {
      directory: db.vector.directory,
      present,
      health: "healthy",
      error: null,
      tables,
      event_vectors: await db.vector.eventVectors().count(),
    };
  } catch (error) {
    return {
      directory: db.vector.directory,
      present,
      health: "error",
      error: error instanceof Error ? error.message : String(error),
      tables,
      event_vectors: null,
    };
  }
}

type CliProgress = {
  phase: string;
  status: "start" | "progress" | "complete";
  current: number;
};

function throttledProgressRenderer<T extends CliProgress>(format: (progress: T) => string) {
  const configuredInterval = Number(process.env.JSCAN_PROGRESS_INTERVAL_MS ?? 1_000);
  const intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : 1_000;
  const lastWrite = new Map<string, number>();
  const sawWork = new Set<string>();
  let latest: T | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  const write = (progress: T) => {
    lastWrite.set(progress.phase, Date.now());
    process.stderr.write(format(progress));
  };

  const stopHeartbeat = () => {
    latest = undefined;
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = undefined;
  };

  const scheduleHeartbeat = (reset = false) => {
    if (reset && heartbeat) clearTimeout(heartbeat);
    if ((!reset && heartbeat) || !latest) return;
    heartbeat = setTimeout(() => {
      heartbeat = undefined;
      if (!latest) return;
      // A long first unit of work has no fresh counter yet, but it is still
      // alive. Emit it as progress rather than repeating a misleading start.
      write({ ...latest, status: "progress" } as T);
      scheduleHeartbeat();
    }, intervalMs);
    heartbeat.unref();
  };

  return (progress: T) => {
    const now = Date.now();
    const boundary = progress.status !== "progress";
    const firstWork = progress.status === "progress" && !sawWork.has(progress.phase);
    if (progress.status === "complete") {
      write(progress);
      stopHeartbeat();
      return;
    }

    latest = progress;
    scheduleHeartbeat();
    if (!boundary && !firstWork && now - (lastWrite.get(progress.phase) ?? 0) < intervalMs) return;
    if (progress.status === "progress") sawWork.add(progress.phase);
    write(progress);
    scheduleHeartbeat(true);
  };
}

function progressRenderer(): ProgressCallback {
  return throttledProgressRenderer<ImportProgress>((progress) => {
    const count = progress.total == null
      ? String(progress.current)
      : `${progress.current}/${progress.total}`;
    const details = progress.phase === "import" && progress.status !== "start"
      ? ` records=${progress.parsed_records ?? 0} blocks=${progress.blocks ?? 0}`
        + ` inserted=${progress.inserted ?? 0} duplicates=${progress.duplicates ?? 0}`
        + ` corrupt=${progress.corrupt ?? 0}`
      : "";
    const path = progress.path ? ` ${progress.path}` : "";
    return `[jscan] ${progress.phase} ${progress.status} ${count}${details}${path}\n`;
  });
}

function embedProgressRenderer() {
  return throttledProgressRenderer<EmbedProgress>((progress) =>
    `[jscan] embed ${progress.status} ${progress.current}/${progress.total}`
      + ` scanned=${progress.scanned} eligible=${progress.eligible}`
      + ` current=${progress.up_to_date} selected=${progress.selected}`
      + ` embedded=${progress.embedded}`
      + ` more=${progress.more_may_remain ? "yes" : "no"}\n`
  );
}

function embedAction() {
  const value = args[1];
  if (value === "-h" || value === "--help" || value === "help") return "help";
  return !value || value.startsWith("--") ? "run" : value;
}

function embedHelp() {
  console.log(`lanceglass embedding providers

  bun src/cli.ts embed providers
  bun src/cli.ts embed probe [--deployment ${DEFAULT_EMBEDDING_DEPLOYMENT}] [--text <text>]
  bun src/cli.ts embed run [--deployment ${DEFAULT_EMBEDDING_DEPLOYMENT}] [--source claude|codex|fixture] [--project <oracle>|--oracle <oracle>] [--folder <directory>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit ${DEFAULT_EMBED_LIMIT}] [--batch-size ${DEFAULT_EMBED_BATCH_SIZE}] [--retries 2]

Backward compatible: "embed --source ..." is the same as "embed run --source ...".
Credentials are read from the environment and are never accepted as CLI values.
`);
}

function help() {
  console.log(`lanceglass (local-first JSONL history)

  bun src/cli.ts choose
  bun src/cli.ts init
  bun src/cli.ts schema
  bun src/cli.ts normalize --file <session.jsonl> [--source fixture]
  bun src/cli.ts plan [--source claude|codex|fixture] [--root <directory>]
  bun src/cli.ts import [--source claude|codex|fixture] [--root <directory>] [--max-files 1] [--expect-plan <revision>] [--expect-count <n>]
  bun src/cli.ts embed <providers|probe|run> [--deployment ${DEFAULT_EMBEDDING_DEPLOYMENT}]
  bun src/cli.ts status
  bun src/cli.ts events [--source claude] [--limit 20]

Default source: Claude Code at ~/.claude/projects. Use --source codex for ~/.codex/sessions.
`);
}

switch (command) {
  case "choose":
    print({
      selected: "LanceDB",
      mode: "fresh isolated learning database",
      reasons: [
        "local embedded database",
        "explicit Apache Arrow schemas",
        "typed ordinary tables now, optional vectors after import",
        "no database server or account",
      ],
      orm: "Typed Repository/Data Mapper; not a relational ORM.",
    });
    break;

  case "init": {
    const db = await Database.open();
    const tables = await db.plain.create();
    print({
      database: db.plain.directory,
      tables,
      databases: {
        plain: { directory: db.plain.directory, tables },
        vector: { directory: db.vector.directory, tables: await db.vector.tableNames() },
      },
    });
    break;
  }

  case "schema":
    print(schemaDescription());
    break;

  case "normalize": {
    const file = option("file");
    if (!file) throw new Error("missing --file <session.jsonl>");
    print(await preview(file, option("source", "fixture")));
    break;
  }

  case "plan": {
    const db = await Database.open();
    const report = await plan(db.plain, sourceSpec(), progressRenderer());
    const { files: _files, ...summary } = report;
    print(summary);
    break;
  }

  case "import": {
    const db = await Database.open();
    const maxFiles = option("max-files");
    const expectedPlanRevision = option("expect-plan");
    const expectedWillParse = option("expect-count");
    print(await importSource(db.plain, sourceSpec(), {
      maxFiles: maxFiles ? integer("max-files", 1) : undefined,
      expectedPlanRevision: expectedPlanRevision || undefined,
      expectedWillParse: expectedWillParse ? integer("expect-count", 0) : undefined,
      onProgress: progressRenderer(),
    }));
    break;
  }

  case "embed": {
    const action = embedAction();
    if (action === "help") {
      embedHelp();
      break;
    }
    if (action === "providers") {
      print({
        plugin_api_version: 1,
        default_deployment: DEFAULT_EMBEDDING_DEPLOYMENT,
        deployments: embeddingProviderRegistry.describe(),
      });
      break;
    }

    const deploymentId = option("deployment", DEFAULT_EMBEDDING_DEPLOYMENT);
    const plugin = embeddingProviderRegistry.get(deploymentId);
    const provider = embeddingProviderRegistry.create(deploymentId);
    if (action === "probe") {
      const probeText = option(
        "text",
        "Lanceglass embedding provider connectivity probe.",
      );
      const vectors = validateEmbeddingVectors(
        await provider.embed([probeText]),
        1,
        provider.space.dimension,
      );
      const norm = Math.sqrt(vectors[0]!.reduce((sum, value) => sum + value * value, 0));
      print({
        deployment: deploymentId,
        ok: true,
        embedding_space_id: provider.space.id,
        provider: provider.space.provider,
        model: provider.space.model,
        revision: provider.space.revision,
        vectors: vectors.length,
        dimension: vectors[0]!.length,
        norm,
      });
      break;
    }
    if (action !== "run") {
      throw new Error(`unknown embed action ${JSON.stringify(action)}; choose providers, probe, or run`);
    }

    const plainDirectory = process.env.PLAIN_DB_DIR ?? process.env.DB_DIR ?? DEFAULT_PLAIN_DB_DIR;
    const vectorDirectory = process.env.VECTOR_DB_DIR ?? defaultVectorDirectoryForSpace(
      plainDirectory,
      plugin.deployment.vectorStoreKey,
    );
    const db = await Database.open(plainDirectory, vectorDirectory, provider.space);
    const report = await embedPending(db.plain, db.vector, provider, {
      source: option("source") || undefined,
      project: option("project") || option("oracle") || undefined,
      folder: option("folder") || undefined,
      since: option("since") || undefined,
      until: option("until") || undefined,
      maxEvents: integer("limit", DEFAULT_EMBED_LIMIT),
      batchSize: integer("batch-size", DEFAULT_EMBED_BATCH_SIZE),
      retries: integer("retries", 2),
      onProgress: embedProgressRenderer(),
    });
    print({ deployment: deploymentId, vector_database: vectorDirectory, ...report });
    break;
  }

  case "status": {
    const db = await Database.open();
    const tables = await db.plain.create();
    const vector = await optionalVectorStatus(db);
    const sourceRows = await db.plain.files().list();
    const sources = [...new Set(sourceRows.map((row) => row.source))].sort();
    print({
      database: db.plain.directory,
      tables,
      databases: {
        plain: { directory: db.plain.directory, tables },
        vector,
      },
      counts: {
        events: await db.plain.events().count(),
        event_sources: await db.plain.occurrences().count(),
        source_files: await db.plain.files().count(),
        event_vectors: vector.event_vectors,
      },
      embeddings: {
        table: EVENT_VECTORS_TABLE,
        model: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSION,
        text_policy: EMBEDDING_TEXT_POLICY,
      },
      sources: Object.fromEntries(await Promise.all(sources.map(async (source) => [source, {
        events: await db.plain.events().count(source),
        event_sources: await db.plain.occurrences().count(source),
        source_files: await db.plain.files().count(source),
      }]))),
    });
    break;
  }

  case "events": {
    const db = await Database.open();
    const table = await db.plain.table("events");
    const source = option("source");
    let query = table.query();
    if (source) query = query.where(`source = ${sql(source)}`);
    print(await query.select([
      "id", "timestamp", "project", "semantic_role", "block_type", "source", "text",
    ]).limit(Math.min(integer("limit", 20), 200)).toArray());
    break;
  }

  case "help":
  case "--help":
  case "-h":
    help();
    break;

  default:
    help();
    throw new Error(`unknown command: ${command}`);
}
