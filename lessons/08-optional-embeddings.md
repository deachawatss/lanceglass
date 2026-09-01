# 08 — Optional embeddings, after plain import

The Lanceglass has **two physical LanceDB stores** on purpose:

| Store | Default path | Tables | When it may be opened |
|---|---|---|---|
| `database.plain` | `.data/lancedb` | `events`, `event_sources`, `source_files` | every plan/import/UI read |
| `database.vector` | `.data/lancedb.vector[.<space-id>]` | `event_vectors` | only explicit embedding or future semantic search |

The boundary is visible in code:

```ts
const database = await Database.open();

await importSource(database.plain, spec); // no Ollama, no vector connection
await embedPending(database.plain, database.vector, provider, { maxEvents: 300 });
```

## Why not embed during import?

Import must remain a fast, inspectable fact-gathering operation. It normalizes
JSONL into typed rows, provenance, and a file manifest. If a model server is
slow, unavailable, or produces malformed output, ordinary import must still
complete and remain resumable.

Embedding is derived data. It can be rebuilt later from `database.plain`.

## Run the optional step

First import a bounded source and inspect its ordinary rows:

```bash
maw jscan import --source claude --max-files 1
maw jscan events --source claude --limit 20
```

Inspect the provider plugins, probe one without touching LanceDB, then run a
bounded embedding batch:

```bash
ollama pull bge-m3
maw jscan embed providers
maw jscan embed probe --deployment m5-ollama
maw jscan embed run --deployment m5-ollama --source claude --limit 300 --batch-size 8

# Partial pass: one Oracle during inclusive Bangkok calendar days.
maw jscan embed run \
  --deployment dual-4090 \
  --source claude \
  --oracle sample-oracle \
  --since 2026-08-24 \
  --until 2026-08-31 \
  --limit 300 \
  --batch-size 8

# Exact JSONL folder (resolved through event_sources provenance).
maw jscan embed run --source claude --folder ~/.claude/projects/my-project --limit 300
```

The command streams `[jscan] embed …` heartbeats on stderr while keeping its
final JSON report safe on stdout. The built-ins use model `bge-m3`, 1,024
`Float32` components, and `event.text.slice(0, 2000)` as the versioned embedding input.
`--project` and its `--oracle` alias match the normalized project value.
`--since` and `--until` are inclusive `YYYY-MM-DD` dates in Asia/Bangkok.
`--folder` matches files directly inside one provenance folder; it does not
implicitly include nested folders.

## How resume stays correct

For each candidate, the vector store keeps:

```ts
{
  event_id,
  source,          // copied scalar filters for vector search
  project,
  session_id,
  timestamp,
  text_hash,       // hash of the exact text sent to Ollama
  model: "bge-m3",
  dimension: 1024,
  embedded_at,
  vector: Float32Array,
}
```

The next `embed` pass pages candidate events from the plain store, looks up
only the matching vector IDs, and skips rows whose input hash/model/dimension
and copied scope metadata are already current. Completed batches are durable
before the next provider call. If a later call fails, rerun `embed run`: it
keeps completed vectors and continues with the remaining stale rows.

## Paths and reset

For compatibility, `DB_DIR` still means the plain database. You can instead set
both explicit paths:

```bash
PLAIN_DB_DIR=/tmp/jscan.plain \
VECTOR_DB_DIR=/tmp/jscan.vector \
maw jscan embed run --source fixture --limit 10
```

To restart both kinds of data deliberately:

```bash
rm -rf .data/lancedb .data/lancedb.vector
```

Do not delete the plain store just to rebuild vectors. Delete only the vector
store, then rerun `embed`, when you deliberately change the embedding contract.
The scope-metadata schema introduced here changes that contract: an older
`event_vectors` table without `source`, `project`, `session_id`, and `timestamp`
must be rebuilt by removing only `.data/lancedb.vector`.
