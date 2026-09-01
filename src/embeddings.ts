import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PlainDatabase, VectorDatabase } from "./database";
import {
  ACTIVE_EMBEDDING_SPACE,
  EmbeddingValidationError,
  sameEmbeddingSpace,
  type EmbeddingProvider,
} from "./embedding-provider";
import { parseDateKey } from "./history";
import { sha256 } from "./normalize";
import {
  EMBEDDING_TEXT_LIMIT,
  EVENT_VECTORS_TABLE,
} from "./schemas";
import type { EmbeddingEventRow, EventVectorRow } from "./types";

export {
  ACTIVE_EMBEDDING_SPACE,
  CLOUDFLARE_EMBEDDING_SPACE,
  DUAL_4090_EMBEDDING_SPACE,
  EMBEDDING_DEPLOYMENTS,
  EmbeddingValidationError,
  OllamaEmbeddingProvider,
  OllamaPoolEmbeddingProvider,
  defineEmbeddingSpace,
  sameEmbeddingSpace,
  wrapEmbeddingProvider,
} from "./embedding-provider";
export type {
  CloudflareWorkersAIProviderConfig,
  EmbeddingDistance,
  EmbeddingDeployment,
  EmbeddingDeploymentId,
  EmbeddingEndpointConfig,
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderKind,
  EmbeddingSpace,
  OllamaEmbeddingProviderOptions,
  OllamaPoolEmbeddingProviderOptions,
  OllamaPoolProviderConfig,
  OllamaProviderConfig,
  OpenAICompatibleProviderConfig,
} from "./embedding-provider";
export {
  BUILTIN_EMBEDDING_PROVIDER_PLUGINS,
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  createEmbeddingProviderRegistry,
  defineEmbeddingProviderPlugin,
  embeddingProviderRegistry,
} from "./embedding-plugins";
export type {
  EmbeddingEnvironmentVariable,
  EmbeddingProviderDescription,
  EmbeddingProviderEnvironment,
  EmbeddingProviderPlugin,
} from "./embedding-plugins";
export { CloudflareWorkersAIProvider } from "./embedding-providers/cloudflare";
export type { CloudflareWorkersAIProviderOptions } from "./embedding-providers/cloudflare";

export const EMBEDDING_MIN_CHARACTERS = 80;
export const DEFAULT_EMBED_BATCH_SIZE = 8;
export const DEFAULT_EMBED_LIMIT = 300;
export const EMBEDDING_PAGE_SIZE = 256;
export const EMBEDDING_ID_CHUNK_SIZE = 256;

export type EmbedProgress = {
  phase: "embed";
  status: "start" | "progress" | "complete";
  current: number;
  total: number;
  scanned: number;
  eligible: number;
  up_to_date: number;
  selected: number;
  embedded: number;
  more_may_remain: boolean;
};

export type EmbedOptions = {
  source?: string;
  project?: string;
  folder?: string;
  since?: string;
  until?: string;
  maxEvents?: number;
  batchSize?: number;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: EmbedProgress) => void;
};

export type EmbedReport = {
  embedding_space_id: string;
  provider: string;
  model: string;
  revision: string;
  dimension: number;
  text_policy: string;
  source?: string;
  project?: string;
  folder?: string;
  since?: string;
  until?: string;
  scanned: number;
  eligible: number;
  up_to_date: number;
  selected: number;
  embedded: number;
  more_may_remain: boolean;
  vectors: number;
};

type Candidate = {
  event: EmbeddingEventRow;
  text: string;
  textHash: string;
};

const ROLE_PRIORITY: Record<EmbeddingEventRow["semantic_role"], number> = {
  human_intent: 0,
  summary: 1,
  assistant_answer: 2,
  tool_action: 3,
  tool_evidence: 3,
};

const EMBEDDING_ROLES = [
  "human_intent",
  "summary",
  "assistant_answer",
] as const;

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

function nextDateKey(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function bangkokDayStart(value: string) {
  return new Date(`${value}T00:00:00+07:00`).toISOString();
}

export function embeddingDateRange(since?: string, until?: string) {
  if (since) parseDateKey(since, "since");
  if (until) parseDateKey(until, "until");
  if (since && until && since > until) {
    throw new Error("since must not be after until");
  }
  return {
    sinceInclusive: since ? bangkokDayStart(since) : undefined,
    untilExclusive: until ? bangkokDayStart(nextDateKey(until)) : undefined,
  };
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export function embeddingText(text: string) {
  return text.slice(0, EMBEDDING_TEXT_LIMIT);
}

export function isEmbeddableEvent(event: EmbeddingEventRow) {
  if (ROLE_PRIORITY[event.semantic_role] > 2) return false;
  if (!["text", "summary", "input_text", "output_text"].includes(event.block_type)) {
    return false;
  }
  const text = embeddingText(event.text);
  const trimmed = text.trimStart();
  return text.trim().length > EMBEDDING_MIN_CHARACTERS &&
    !trimmed.startsWith("<system-reminder>") &&
    !trimmed.startsWith("[Image: source:");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function assertProviderContract(
  provider: EmbeddingProvider,
  vectorDatabase: VectorDatabase,
) {
  const expected = vectorDatabase.space;
  const actual = provider.space;
  if (!sameEmbeddingSpace(actual, expected)) {
    throw new Error(
      `vector store expects embedding space ${expected.id}; got ${actual.id}; ` +
        `use a separate ${EVENT_VECTORS_TABLE} store for each embedding space`,
    );
  }
}

export function validateEmbeddingVectors(
  value: unknown,
  expectedCount: number,
  dimension: number,
) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new EmbeddingValidationError(
      `embedding response count mismatch: expected ${expectedCount}, got ${
        Array.isArray(value) ? value.length : "non-array"
      }`,
    );
  }

  return value.map((raw, index) => {
    if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) {
      throw new EmbeddingValidationError(`embedding ${index} is not an array`);
    }
    const numbers = Array.from(raw as ArrayLike<unknown>);
    if (numbers.length !== dimension) {
      throw new EmbeddingValidationError(
        `embedding ${index} has dimension ${numbers.length}; expected ${dimension}`,
      );
    }
    if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new EmbeddingValidationError(`embedding ${index} contains a non-finite value`);
    }
    const vector = Float32Array.from(numbers as number[]);
    if ([...vector].some((item) => !Number.isFinite(item))) {
      throw new EmbeddingValidationError(`embedding ${index} overflows Float32`);
    }
    const normSquared = vector.reduce((sum, item) => sum + item * item, 0);
    if (!Number.isFinite(normSquared) || normSquared <= 0) {
      throw new EmbeddingValidationError(`embedding ${index} has zero norm`);
    }
    return vector;
  });
}

async function embedBatch(
  provider: EmbeddingProvider,
  texts: string[],
  retries: number,
  retryDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return validateEmbeddingVectors(
        await provider.embed(texts),
        texts.length,
        provider.space.dimension,
      );
    } catch (error) {
      if (error instanceof EmbeddingValidationError || attempt >= retries) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

type LockOwner = {
  token?: unknown;
  pid?: unknown;
  started_at?: unknown;
};

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

async function acquireEmbeddingLock(vectorDatabase: VectorDatabase) {
  const lockPath = `${vectorDatabase.directory}.${EVENT_VECTORS_TABLE}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });

  // Write a complete unique candidate first, then atomically hard-link it to
  // the stable lock path. A contender can therefore never observe a created
  // lock with missing ownership data.
  const token = randomUUID();
  const candidatePath = `${lockPath}.${token}.candidate`;
  const owner = { token, pid: process.pid, started_at: new Date().toISOString() };
  await writeFile(candidatePath, JSON.stringify(owner), { flag: "wx" });
  try {
    await link(candidatePath, lockPath);
  } catch (error) {
    await unlink(candidatePath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const activeOwner = await readLockOwner(lockPath);
    const ownerDescription = Number.isInteger(activeOwner?.pid)
      ? ` (pid ${activeOwner!.pid})`
      : "";
    throw new Error(
      `${EVENT_VECTORS_TABLE} writer is already active for ${vectorDatabase.directory}${ownerDescription}; wait for it to finish`,
    );
  }
  await unlink(candidatePath).catch(() => {});

  return async () => {
    // Do not delete a lock replaced by another owner after a failed/crashed
    // process. The random token makes release ownership explicit.
    if ((await readLockOwner(lockPath))?.token === token) {
      await unlink(lockPath).catch(() => {});
    }
  };
}

export async function embedPending(
  plain: PlainDatabase,
  vectorDatabase: VectorDatabase,
  provider: EmbeddingProvider,
  options: EmbedOptions = {},
): Promise<EmbedReport> {
  assertProviderContract(provider, vectorDatabase);
  const space = provider.space;
  const release = await acquireEmbeddingLock(vectorDatabase);
  try {
    const maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_EMBED_LIMIT, "maxEvents");
    const batchSize = positiveInteger(options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE, "batchSize");
    const retries = nonNegativeInteger(options.retries ?? 2, "retries");
    const retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? 500, "retryDelayMs");
    const sleep = options.sleep ?? delay;
    const project = options.project?.trim() || undefined;
    const folder = options.folder ? resolve(options.folder) : undefined;
    const dateRange = embeddingDateRange(options.since, options.until);

    const pageSize = Math.min(maxEvents, EMBEDDING_PAGE_SIZE);
    const selected: Candidate[] = [];
    let scanned = 0;
    let eligible = 0;
    let upToDate = 0;
    let moreMayRemain = false;

    const folderEventIds = folder
      ? await plain.occurrences().eventIdsInFolder(options.source ?? "", folder)
      : undefined;
    const eventIdChunks: Array<string[] | undefined> = folderEventIds
      ? chunks(folderEventIds, EMBEDDING_ID_CHUNK_SIZE)
      : [undefined];

    // Page candidates from LanceDB and fetch vector metadata only for IDs in
    // the current page. `--limit 1` therefore reads one candidate instead of
    // materializing the full corpus and vector table in JavaScript. Folder
    // provenance becomes bounded event-ID chunks before touching vectors.
    scanRoles: for (const role of EMBEDDING_ROLES) {
      for (const eventIds of eventIdChunks) {
        let offset = 0;
        for (;;) {
          const page = await plain.events().embeddingPage({
            source: options.source,
            project,
            ...dateRange,
            eventIds,
            semanticRole: role,
            minimumCharacters: EMBEDDING_MIN_CHARACTERS,
            offset,
            limit: pageSize,
          });
          if (!page.length) break;
          offset += page.length;
          scanned += page.length;
          const existing = await vectorDatabase.eventVectors().metadataForEventIds(
            page.map((event) => event.id),
          );

          for (const event of page) {
            // The SQL predicate handles the common path. Keep this semantic
            // guard as a defense for hand-written rows and future normalizers.
            if (!isEmbeddableEvent(event)) continue;
            eligible++;
            const text = embeddingText(event.text);
            const textHash = sha256(text);
            const vector = existing.get(event.id);
            if (vector?.text_hash === textHash &&
              vector.model === space.model &&
              vector.dimension === space.dimension &&
              vector.source === event.source &&
              vector.project === event.project &&
              vector.session_id === event.session_id &&
              vector.timestamp === event.timestamp) {
              upToDate++;
              continue;
            }
            selected.push({ event, text, textHash });
            if (selected.length === maxEvents) {
              moreMayRemain = true;
              break scanRoles;
            }
          }
          if (page.length < pageSize) break;
        }
      }
    }

    let embedded = 0;
    const reportProgress = (status: EmbedProgress["status"]) => options.onProgress?.({
      phase: "embed",
      status,
      current: embedded,
      total: selected.length,
      scanned,
      eligible,
      up_to_date: upToDate,
      selected: selected.length,
      embedded,
      more_may_remain: moreMayRemain,
    });
    reportProgress("start");

    for (let index = 0; index < selected.length; index += batchSize) {
      const batch = selected.slice(index, index + batchSize);
      const vectors = await embedBatch(
        provider,
        batch.map((candidate) => candidate.text),
        retries,
        retryDelayMs,
        sleep,
      );
      const rows: EventVectorRow[] = batch.map((candidate, offset) => ({
        event_id: candidate.event.id,
        source: candidate.event.source,
        project: candidate.event.project,
        session_id: candidate.event.session_id,
        timestamp: candidate.event.timestamp,
        text_hash: candidate.textHash,
        model: space.model,
        dimension: space.dimension,
        embedded_at: new Date().toISOString(),
        vector: vectors[offset]!,
      }));
      embedded += await vectorDatabase.eventVectors().upsert(rows);
      reportProgress("progress");
    }

    reportProgress("complete");
    return {
      embedding_space_id: space.id,
      provider: space.provider,
      model: space.model,
      revision: space.revision,
      dimension: space.dimension,
      text_policy: space.textPolicy,
      source: options.source || undefined,
      project,
      folder,
      since: options.since || undefined,
      until: options.until || undefined,
      scanned,
      eligible,
      up_to_date: upToDate,
      selected: selected.length,
      embedded,
      more_may_remain: moreMayRemain,
      vectors: await vectorDatabase.eventVectors().count(),
    };
  } finally {
    await release();
  }
}
