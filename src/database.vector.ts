import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { DataType, Precision } from "apache-arrow";
import { stat } from "node:fs/promises";
import {
  ACTIVE_EVENT_VECTOR_CONTRACT,
  EVENT_VECTORS_TABLE,
  eventVectorSchema,
  type EventVectorSpaceContract,
} from "./schemas";
import { sql } from "./database.plain";
import type { EventVectorMetadata, EventVectorRow } from "./types";

/**
 * The optional semantic store. Read methods do not connect when its directory
 * does not exist, keeping normal import/status work vector-free.
 */
export class VectorDatabase {
  private connectionPromise: Promise<Connection> | undefined;

  constructor(
    readonly directory: string,
    readonly space: EventVectorSpaceContract = ACTIVE_EVENT_VECTOR_CONTRACT,
  ) {}

  async exists() {
    try {
      return (await stat(this.directory)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async connectionIfPresent(): Promise<Connection | undefined> {
    if (!(await this.exists())) return undefined;
    return this.connectionForWrite();
  }

  async connectionForWrite(): Promise<Connection> {
    this.connectionPromise ??= lancedb.connect(this.directory);
    return this.connectionPromise;
  }

  async tableNames() {
    const connection = await this.connectionIfPresent();
    return connection ? (await connection.tableNames()).sort() : [];
  }

  eventVectors() { return new EventVectorRepository(this); }
}

function vectorContractError(reason: string) {
  return new Error(
    `${EVENT_VECTORS_TABLE} contract mismatch (${reason}); rebuild ${EVENT_VECTORS_TABLE} before embedding`,
  );
}

async function assertEventVectorContract(table: Table, space: EventVectorSpaceContract) {
  const schema = await table.schema();
  const expectedMetadata = {
    embedding_space_id: space.id,
    embedding_provider: space.provider,
    embedding_model: space.model,
    embedding_revision: space.revision,
    embedding_dimension: String(space.dimension),
    embedding_distance: space.distance,
    embedding_text_policy: space.textPolicy,
  };
  for (const [name, expected] of Object.entries(expectedMetadata)) {
    if (schema.metadata.get(name) !== expected) {
      throw vectorContractError(`${name} is not ${JSON.stringify(expected)}`);
    }
  }

  const expectedSchema = eventVectorSchema(space);
  if (schema.fields.length !== expectedSchema.fields.length) {
    throw vectorContractError("field count differs from the active embedding schema");
  }
  for (const [index, expected] of expectedSchema.fields.entries()) {
    const actual = schema.fields[index];
    if (!actual || actual.name !== expected.name ||
      actual.nullable !== expected.nullable ||
      actual.type.toString() !== expected.type.toString()) {
      throw vectorContractError(`field ${expected.name} differs from the active embedding schema`);
    }
  }

  const vector = schema.fields.find((field) => field.name === "vector");
  if (!vector || !DataType.isFixedSizeList(vector.type)) {
    throw vectorContractError("vector is not FixedSizeList<Float32>");
  }
  if (vector.type.listSize !== space.dimension) {
    throw vectorContractError(`vector dimension is not ${space.dimension}`);
  }
  if (!DataType.isFloat(vector.type.valueType) ||
    vector.type.valueType.precision !== Precision.SINGLE) {
    throw vectorContractError("vector values are not Float32");
  }
}

export class EventVectorRepository {
  constructor(private readonly db: VectorDatabase) {}

  private async existingTable(): Promise<Table | undefined> {
    const connection = await this.db.connectionIfPresent();
    if (!connection || !(await connection.tableNames()).includes(EVENT_VECTORS_TABLE)) return undefined;
    const table = await connection.openTable(EVENT_VECTORS_TABLE);
    await assertEventVectorContract(table, this.db.space);
    return table;
  }

  private async writableTable(): Promise<Table> {
    const existing = await this.existingTable();
    if (existing) return existing;

    const table = await (await this.db.connectionForWrite()).createEmptyTable(
      EVENT_VECTORS_TABLE,
      eventVectorSchema(this.db.space),
      { mode: "create", existOk: true },
    );
    await assertEventVectorContract(table, this.db.space);
    return table;
  }

  async count() {
    const table = await this.existingTable();
    return table ? table.countRows() : 0;
  }

  async metadata(): Promise<EventVectorMetadata[]> {
    const table = await this.existingTable();
    if (!table) return [];
    const rows = await table.query().select([
      "event_id", "source", "project", "session_id", "timestamp",
      "text_hash", "model", "dimension", "embedded_at",
    ]).toArray() as unknown as EventVectorMetadata[];
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.event_id)) {
        throw new Error(`${EVENT_VECTORS_TABLE} contains duplicate event_id ${row.event_id}`);
      }
      ids.add(row.event_id);
    }
    return rows;
  }

  async metadataForEventIds(eventIds: string[]) {
    const ids = [...new Set(eventIds)];
    const table = await this.existingTable();
    if (!table || !ids.length) return new Map<string, EventVectorMetadata>();

    const rowsByEventId = new Map<string, EventVectorMetadata>();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const chunk = ids.slice(offset, offset + 256);
      const rows = await table.query()
        .where(`event_id IN (${chunk.map(sql).join(", ")})`)
        .select([
          "event_id", "source", "project", "session_id", "timestamp",
          "text_hash", "model", "dimension", "embedded_at",
        ])
        .toArray() as unknown as EventVectorMetadata[];
      for (const row of rows) {
        if (rowsByEventId.has(row.event_id)) {
          throw new Error(`${EVENT_VECTORS_TABLE} contains duplicate event_id ${row.event_id}`);
        }
        rowsByEventId.set(row.event_id, row);
      }
    }
    return rowsByEventId;
  }

  async rowsForEventIds(eventIds: string[]): Promise<Map<string, EventVectorRow>> {
    const ids = [...new Set(eventIds)];
    const table = await this.existingTable();
    if (!table || !ids.length) return new Map();

    const rowsByEventId = new Map<string, EventVectorRow>();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const chunk = ids.slice(offset, offset + 256);
      const rows = await table.query()
        .where(`event_id IN (${chunk.map(sql).join(", ")})`)
        .select([
          "event_id", "source", "project", "session_id", "timestamp",
          "text_hash", "model", "dimension", "embedded_at", "vector",
        ])
        .toArray() as unknown as Array<Omit<EventVectorRow, "vector"> & { vector: ArrayLike<number> }>;
      for (const raw of rows) {
        if (rowsByEventId.has(raw.event_id)) {
          throw new Error(`${EVENT_VECTORS_TABLE} contains duplicate event_id ${raw.event_id}`);
        }
        rowsByEventId.set(raw.event_id, {
          ...raw,
          vector: Float32Array.from(raw.vector),
        });
      }
    }
    return rowsByEventId;
  }

  async upsert(rows: EventVectorRow[]) {
    const unique = [...new Map(rows.map((row) => [row.event_id, row])).values()];
    if (!unique.length) return 0;
    await (await this.writableTable())
      .mergeInsert("event_id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(unique);
    return unique.length;
  }
}
