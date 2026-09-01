import { dirname, resolve } from "node:path";
import type { PlainDatabase, VectorDatabase } from "./database";
import { EMBEDDING_DEPLOYMENTS, sameEmbeddingSpace } from "./embedding-provider";
import { embeddingText, isEmbeddableEvent } from "./embeddings";
import { bangkokDateKey, parseDateKey, UNKNOWN_PROVENANCE_FOLDER } from "./history";
import { sql } from "./database.plain";
import { EVENT_VECTORS_TABLE } from "./schemas";
import { sha256 } from "./normalize";
import type { EmbeddingEventRow, EventRow, EventVectorRow } from "./types";

export const HISTORY_VECTOR_DEPLOYMENTS = ["dual-4090", "cloudflare"] as const;
export const HISTORY_VECTOR_ACTORS = ["human", "agent"] as const;
export const MAX_HISTORY_VECTOR_POINTS = 500;

export type HistoryVectorDeployment = typeof HISTORY_VECTOR_DEPLOYMENTS[number];
export type HistoryVectorActor = typeof HISTORY_VECTOR_ACTORS[number];

export type HistoryVectorRequest = {
  deployment: HistoryVectorDeployment;
  date: string;
  source: string;
  project: string;
  folder: string;
  session_id: string;
  limit: number;
  actors: readonly HistoryVectorActor[];
};

export class HistoryVectorInputError extends Error {}
export class HistoryVectorStoreError extends Error {}

const ACTOR_ROLES = {
  human: new Set(["human_intent"]),
  agent: new Set(["assistant_answer", "tool_action", "tool_evidence", "summary"]),
} satisfies Record<HistoryVectorActor, ReadonlySet<string>>;

function required(url: URL, name: string, max: number, allowEmpty = false) {
  if (!url.searchParams.has(name)) throw new HistoryVectorInputError(`${name} is required`);
  const value = url.searchParams.get(name)?.trim() ?? "";
  if (!allowEmpty && !value) throw new HistoryVectorInputError(`${name} is required`);
  if (value.length > max || value.includes("\0")) {
    throw new HistoryVectorInputError(`${name} is too long or contains invalid characters`);
  }
  return value;
}

export function parseHistoryVectorRequest(url: URL): HistoryVectorRequest {
  const deployment = required(url, "deployment", 32);
  if (!(HISTORY_VECTOR_DEPLOYMENTS as readonly string[]).includes(deployment)) {
    throw new HistoryVectorInputError("deployment must be dual-4090 or cloudflare");
  }
  const date = required(url, "date", 10);
  try {
    parseDateKey(date);
  } catch (error) {
    throw new HistoryVectorInputError(error instanceof Error ? error.message : String(error));
  }
  const rawLimit = url.searchParams.get("limit")?.trim() || "200";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_VECTOR_POINTS) {
    throw new HistoryVectorInputError(`limit must be an integer from 1 to ${MAX_HISTORY_VECTOR_POINTS}`);
  }
  const rawActors = url.searchParams.getAll("actor");
  const requestedActors = rawActors.length
    ? rawActors.flatMap((value) => value.split(",").map((actor) => actor.trim()))
    : [...HISTORY_VECTOR_ACTORS];
  if (!requestedActors.length || requestedActors.some((actor) =>
    !(HISTORY_VECTOR_ACTORS as readonly string[]).includes(actor)
  )) {
    throw new HistoryVectorInputError("actor must select human, agent, or both");
  }
  const selectedActors = new Set(requestedActors as HistoryVectorActor[]);
  const actors = HISTORY_VECTOR_ACTORS.filter((actor) => selectedActors.has(actor));
  if (!actors.length) {
    throw new HistoryVectorInputError("actor must select at least one of human or agent");
  }
  return {
    deployment: deployment as HistoryVectorDeployment,
    date,
    source: required(url, "source", 128),
    project: required(url, "project", 512, true),
    folder: required(url, "folder", 4_096),
    session_id: required(url, "session_id", 4_096),
    limit,
    actors: [...actors],
  };
}

function matchesActor(row: EventRow, actors: readonly HistoryVectorActor[]) {
  // Unknown/future semantic roles are excluded conservatively until explicitly
  // assigned to a human or agent actor; this prevents silently mislabeling data.
  return actors.some((actor) => ACTOR_ROLES[actor].has(row.semantic_role));
}

function eventOrder(left: EventRow, right: EventRow) {
  return left.timestamp.localeCompare(right.timestamp)
    || left.block_index - right.block_index
    || left.id.localeCompare(right.id);
}

async function provenanceEventIds(
  plain: PlainDatabase,
  source: string,
  eventIds: string[],
  folder?: string,
) {
  const observed = new Set<string>();
  const target = folder === undefined ? undefined : resolve(folder);
  const table = await plain.connection.openTable("event_sources");
  for (let offset = 0; offset < eventIds.length; offset += 256) {
    const chunk = eventIds.slice(offset, offset + 256);
    const occurrences = await table.query()
      .where(`source = ${sql(source)} AND event_id IN (${chunk.map(sql).join(", ")})`)
      .select(["event_id", "file_path"])
      .toArray() as unknown as Array<{ event_id: string; file_path: string }>;
    for (const occurrence of occurrences) {
      if (target === undefined || dirname(resolve(occurrence.file_path)) === target) {
        observed.add(occurrence.event_id);
      }
    }
  }
  return observed;
}

async function exactlyScopedEligibleEvents(
  plain: PlainDatabase,
  request: HistoryVectorRequest,
) {
  const names = await plain.tableNames();
  if (!names.includes("events")) return [];
  const rows = await (await plain.connection.openTable("events")).query()
    .where([
      `source = ${sql(request.source)}`,
      `project = ${sql(request.project)}`,
      `session_id = ${sql(request.session_id)}`,
    ].join(" AND "))
    .toArray() as unknown as EventRow[];
  const eligible = rows
    .filter((row) => bangkokDateKey(row.timestamp) === request.date)
    .filter((row) => matchesActor(row, request.actors))
    .filter((row) => isEmbeddableEvent(row as EmbeddingEventRow))
    .sort(eventOrder);
  if (!eligible.length) return [];
  if (!names.includes("event_sources")) {
    return request.folder === UNKNOWN_PROVENANCE_FOLDER ? eligible : [];
  }

  if (request.folder === UNKNOWN_PROVENANCE_FOLDER) {
    const observed = await provenanceEventIds(
      plain,
      request.source,
      eligible.map((row) => row.id),
    );
    return eligible.filter((row) => !observed.has(row.id));
  }

  const idsInFolder = await provenanceEventIds(
    plain,
    request.source,
    eligible.map((row) => row.id),
    request.folder,
  );

  return eligible.filter((row) => idsInFolder.has(row.id));
}

function dot(left: Float32Array, right: Float32Array) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result += left[index]! * right[index]!;
  }
  return result;
}

function normalizedAxes(vectors: Float32Array[]) {
  if (vectors.length <= 1) {
    return {
      coordinates: vectors.map(() => [0, 0, 0] as const),
      explainedVariance: null,
    };
  }
  const dimension = vectors[0]!.length;
  const mean = new Float64Array(dimension);
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) mean[index]! += vector[index]! / vectors.length;
  }
  const centered = vectors.map((vector) => {
    const result = new Float32Array(dimension);
    for (let index = 0; index < dimension; index += 1) result[index] = vector[index]! - mean[index]!;
    return result;
  });
  const components: Float32Array[] = [];
  const capturedVariance: number[] = [];
  const totalVariance = centered.reduce((sum, row) => sum + dot(row, row), 0);
  let seed = 42;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let axis = 0; axis < 3; axis += 1) {
    let component = Float32Array.from({ length: dimension }, random);
    for (let iteration = 0; iteration < 48; iteration += 1) {
      const next = new Float32Array(dimension);
      for (const row of centered) {
        const weight = dot(row, component);
        for (let index = 0; index < dimension; index += 1) next[index]! += weight * row[index]!;
      }
      for (const previous of components) {
        const overlap = dot(next, previous);
        for (let index = 0; index < dimension; index += 1) next[index]! -= overlap * previous[index]!;
      }
      const norm = Math.sqrt(dot(next, next));
      if (!Number.isFinite(norm) || norm < 1e-9) {
        component = new Float32Array(dimension);
        break;
      }
      for (let index = 0; index < dimension; index += 1) next[index]! /= norm;
      component = next;
    }
    components.push(component);
    capturedVariance.push(centered.reduce(
      (sum, row) => sum + dot(row, component) ** 2,
      0,
    ));
  }

  const raw = centered.map((row) => components.map((component) => dot(row, component)));
  for (let axis = 0; axis < 3; axis += 1) {
    const values = raw.map((coordinate) => coordinate[axis]!).sort((left, right) => left - right);
    const low = values[Math.floor(values.length * 0.05)]!;
    const high = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!;
    const span = high - low;
    for (const coordinate of raw) {
      coordinate[axis] = span > 1e-12
        ? Math.max(-1, Math.min(1, ((coordinate[axis]! - low) / span) * 2 - 1))
        : 0;
    }
  }
  return {
    coordinates: raw.map((coordinate) => [
      coordinate[0]!,
      coordinate[1]!,
      coordinate[2]!,
    ] as const),
    explainedVariance: totalVariance > 0
      ? Math.max(0, Math.min(1, capturedVariance.reduce((sum, value) => sum + value, 0) / totalVariance))
      : null,
  };
}

function assertVectors(rows: EventVectorRow[], dimension: number) {
  for (const row of rows) {
    if (row.dimension !== dimension || row.vector.length !== dimension) {
      throw new Error(`event ${row.event_id} has invalid vector dimension`);
    }
    for (const value of row.vector) {
      if (!Number.isFinite(value)) throw new Error(`event ${row.event_id} has a non-finite vector`);
    }
  }
}

function evenlySample<T>(rows: T[], limit: number) {
  if (rows.length <= limit) return rows;
  if (limit === 1) return [rows[Math.floor(rows.length / 2)]!];
  const last = rows.length - 1;
  return Array.from({ length: limit }, (_, index) =>
    rows[Math.round((index * last) / (limit - 1))]!
  );
}

export async function visualizeHistoryVectors(
  plain: PlainDatabase,
  vectorDatabase: VectorDatabase,
  request: HistoryVectorRequest,
) {
  const expectedSpace = EMBEDDING_DEPLOYMENTS[request.deployment].config.space;
  if (!sameEmbeddingSpace(vectorDatabase.space, expectedSpace)) {
    throw new HistoryVectorStoreError("selected vector store does not match the requested embedding space");
  }
  const eligible = await exactlyScopedEligibleEvents(plain, request);
  const common = {
    deployment: request.deployment,
    scope: {
      date: request.date,
      source: request.source,
      project: request.project,
      folder: request.folder,
      session_id: request.session_id,
      actors: [...request.actors],
    },
    limit: request.limit,
    space: {
      id: expectedSpace.id,
      provider: expectedSpace.provider,
      model: expectedSpace.model,
      revision: expectedSpace.revision,
      dimension: expectedSpace.dimension,
      distance: expectedSpace.distance,
      text_policy: expectedSpace.textPolicy,
    },
  };

  if (!(await vectorDatabase.exists())) {
    return {
      ...common,
      available: false,
      status: "missing_store" as const,
      coverage: { eligible: eligible.length, embedded: 0, missing: eligible.length, sampled: 0 },
      projection: { method: "deterministic-pca-3d", explained_variance: null },
      points: [],
      error: `No ${request.deployment} vector store is connected.`,
    };
  }

  try {
    if (!(await vectorDatabase.tableNames()).includes(EVENT_VECTORS_TABLE)) {
      return {
        ...common,
        available: false,
        status: "missing_store" as const,
        coverage: { eligible: eligible.length, embedded: 0, missing: eligible.length, sampled: 0 },
        projection: { method: "deterministic-pca-3d", explained_variance: null },
        points: [],
        error: `No ${request.deployment} vector table is connected.`,
      };
    }
    const metadata = await vectorDatabase.eventVectors().metadataForEventIds(eligible.map((row) => row.id));
    const embeddedEvents = eligible.filter((row) => {
      const vector = metadata.get(row.id);
      return vector?.text_hash === sha256(embeddingText(row.text)) &&
        vector.model === expectedSpace.model &&
        vector.dimension === expectedSpace.dimension;
    });
    const selectedEvents = evenlySample(embeddedEvents, request.limit);
    const rowsById = await vectorDatabase.eventVectors().rowsForEventIds(selectedEvents.map((row) => row.id));
    const vectorRows = selectedEvents.map((event) => rowsById.get(event.id)).filter(Boolean) as EventVectorRow[];
    assertVectors(vectorRows, expectedSpace.dimension);
    const projection = normalizedAxes(vectorRows.map((row) => row.vector));
    const eventsById = new Map(selectedEvents.map((event) => [event.id, event]));
    const points = vectorRows.map((row, index) => {
      const event = eventsById.get(row.event_id)!;
      return {
        event_id: event.id,
        x: projection.coordinates[index]![0],
        y: projection.coordinates[index]![1],
        z: projection.coordinates[index]![2],
        timestamp: event.timestamp,
        source: event.source,
        project: event.project,
        session_id: event.session_id,
        block_type: event.block_type,
        semantic_role: event.semantic_role,
        tool_name: event.tool_name,
        text_preview: event.text.trim().replace(/\s+/g, " ").slice(0, 180),
      };
    });
    return {
      ...common,
      available: true,
      status: "ready" as const,
      coverage: {
        eligible: eligible.length,
        embedded: embeddedEvents.length,
        missing: eligible.length - embeddedEvents.length,
        sampled: points.length,
      },
      projection: {
        method: "deterministic-pca-3d",
        explained_variance: projection.explainedVariance,
      },
      points,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HistoryVectorStoreError(`selected vector store is malformed: ${reason.slice(0, 240)}`);
  }
}
