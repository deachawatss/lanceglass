import {
  Bool,
  Field,
  Float32,
  Float64,
  FixedSizeList,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";
import type { EmbeddingSpace } from "./embedding-provider";

const string = (name: string) => new Field(name, new Utf8(), false);
const integer = (name: string) => new Field(name, new Int32(), false);
const number = (name: string) => new Field(name, new Float64(), false);
const boolean = (name: string) => new Field(name, new Bool(), false);

// Embeddings intentionally live outside SCHEMAS. Core JSONL imports create
// only their three ordinary tables; this optional table appears on the first
// successful embedding batch.
export const EVENT_VECTORS_TABLE = "event_vectors";
export const EMBEDDING_MODEL = "bge-m3";
export const EMBEDDING_REVISION =
  "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
export const EMBEDDING_SPACE_ID = "ollama-bge-m3-790764642607-1024-cosine-text-v1";
export const EMBEDDING_DIMENSION = 1_024;
export const EMBEDDING_TEXT_LIMIT = 2_000;
export const EMBEDDING_TEXT_POLICY = "event.text.slice(0,2000)@v1";

export type EventVectorSpaceContract = EmbeddingSpace;

export const ACTIVE_EVENT_VECTOR_CONTRACT: EventVectorSpaceContract = Object.freeze({
  id: EMBEDDING_SPACE_ID,
  provider: "ollama",
  model: EMBEDDING_MODEL,
  revision: EMBEDDING_REVISION,
  dimension: EMBEDDING_DIMENSION,
  distance: "cosine",
  textPolicy: EMBEDDING_TEXT_POLICY,
});

export const SCHEMAS = {
  events: new Schema([
    string("id"),
    string("event_uuid"),
    integer("block_index"),
    string("session_id"),
    string("parent_uuid"),
    string("timestamp"),
    string("project"),
    string("envelope_type"),
    string("block_type"),
    string("semantic_role"),
    string("tool_name"),
    string("tool_use_id"),
    boolean("is_error"),
    string("text"),
    string("text_hash"),
    string("source"),
  ]),
  event_sources: new Schema([
    string("id"),
    string("event_id"),
    string("source"),
    string("file_path"),
    string("file_hash"),
    integer("source_line"),
    string("observed_text_hash"),
  ]),
  source_files: new Schema([
    string("id"),
    string("source"),
    string("path"),
    number("size"),
    number("mtime_ms"),
    string("sha256"),
    string("state"),
    string("imported_at"),
    integer("parsed_records"),
    integer("inserted_events"),
    integer("duplicate_events"),
    integer("corrupt_lines"),
  ]),
} as const;

export function eventVectorSchema(space: EventVectorSpaceContract) {
  return new Schema([
    string("event_id"),
    string("source"),
    string("project"),
    string("session_id"),
    string("timestamp"),
    string("text_hash"),
    string("model"),
    integer("dimension"),
    string("embedded_at"),
    new Field(
      "vector",
      new FixedSizeList(
        space.dimension,
        new Field("item", new Float32(), false),
      ),
      false,
    ),
  ], new Map([
    ["embedding_space_id", space.id],
    ["embedding_provider", space.provider],
    ["embedding_model", space.model],
    ["embedding_revision", space.revision],
    ["embedding_dimension", String(space.dimension)],
    ["embedding_distance", space.distance],
    ["embedding_text_policy", space.textPolicy],
  ]));
}

export const EVENT_VECTOR_SCHEMA = eventVectorSchema(ACTIVE_EVENT_VECTOR_CONTRACT);

export function schemaDescription() {
  return Object.fromEntries(Object.entries(SCHEMAS).map(([table, schema]) => [
    table,
    schema.fields.map((field) => `${field.name}: ${field.type}`),
  ]));
}
