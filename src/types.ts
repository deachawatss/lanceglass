export type SemanticRole =
  | "human_intent"
  | "assistant_answer"
  | "tool_action"
  | "tool_evidence"
  | "summary";

export type EventRow = {
  id: string;
  event_uuid: string;
  block_index: number;
  session_id: string;
  parent_uuid: string;
  timestamp: string;
  project: string;
  envelope_type: string;
  block_type: string;
  semantic_role: SemanticRole;
  tool_name: string;
  tool_use_id: string;
  is_error: boolean;
  text: string;
  text_hash: string;
  source: string;
};

export type EmbeddingEventRow = Pick<
  EventRow,
  | "id"
  | "session_id"
  | "timestamp"
  | "project"
  | "block_type"
  | "semantic_role"
  | "text"
  | "source"
>;

export type EventVectorRow = {
  event_id: string;
  // Scalar scope metadata is deliberately copied into the vector store so a
  // later ANN query can pre-filter without joining across physical databases.
  source: string;
  project: string;
  session_id: string;
  timestamp: string;
  // This hashes the exact text sent to the embedding provider, rather than
  // EventRow.text_hash (which tracks the untruncated source block).
  text_hash: string;
  model: string;
  dimension: number;
  embedded_at: string;
  vector: Float32Array;
};

export type EventVectorMetadata = Omit<EventVectorRow, "vector">;

export type EventSourceRow = {
  id: string;
  event_id: string;
  source: string;
  file_path: string;
  file_hash: string;
  source_line: number;
  observed_text_hash: string;
};

export type SourceFileRow = {
  id: string;
  source: string;
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
  state: "pending" | "imported" | "requires_reconcile" | "failed";
  imported_at: string;
  parsed_records: number;
  inserted_events: number;
  duplicate_events: number;
  corrupt_lines: number;
};

export type SourceSpec = {
  source: string;
  root: string;
};

export type FilePlan = {
  id: string;
  source: string;
  path: string;
  size: number;
  mtimeMs: number;
  state: "new" | "changed" | "unchanged" | "shrunk";
};

export type PlanReport = {
  source: string;
  root: string;
  plan_revision: string;
  found: number;
  new: number;
  changed: number;
  unchanged: number;
  shrunk: number;
  will_parse: number;
  files: FilePlan[];
};

export type IntakeReport = {
  source: string;
  root: string;
  checked_at: string;
  found: number;
  new: number;
  changed: number;
  indexed: number;
  reconcile: number;
  actionable: number;
};

export type ImportReport = Omit<PlanReport, "files"> & {
  selected_files: number;
  remaining_files: number;
  partial: boolean;
  parsed_records: number;
  blocks: number;
  inserted: number;
  duplicates: number;
  occurrences_inserted: number;
  corrupt: number;
};

export type ImportProgress = {
  phase: "scan" | "plan" | "import";
  status: "start" | "progress" | "complete";
  current: number;
  total?: number;
  path?: string;
  parsed_records?: number;
  blocks?: number;
  inserted?: number;
  duplicates?: number;
  corrupt?: number;
};

export type ProgressCallback = (progress: ImportProgress) => void;

export type ImportOptions = {
  maxFiles?: number;
  expectedPlanRevision?: string;
  expectedWillParse?: number;
  onProgress?: ProgressCallback;
};
