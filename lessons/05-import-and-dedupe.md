# 05 — Import: new vs known

## Goal

Import one bounded file batch, inspect what remains, resume, then recognize the same input as already known.

There are two useful levels of identity:

```text
source file identity   decides whether a file is new or known
canonical event identity decides whether a normalized block is new or known globally
```

Keeping provenance separate lets a known canonical event be observed from another file without duplicating the event itself.

## Do

Reset the disposable database, then run the cumulative smoke check:

```bash
rm -rf .data/lancedb
just smoke
```

The smoke workflow should process the two fixture files in small batches:

1. plan: reports two new files
2. first pass with `--max-files 1`: selects one and reports one remaining
3. resume: imports the second and reports zero remaining
4. repeat: reports both files known and adds no duplicate canonical rows

This is an end-to-end smoke assertion, not a unit test case.

## Fast intake vs exact plan

`GET /api/import/intake?root=...&source=...` is the lightweight observation
path used by the UI every 30 seconds. It scans JSONL metadata and compares the
source-file manifest, so it can report `new`, `changed`, `indexed`, and
`reconcile` counts without hashing contents or writing any table.

`GET /api/import/plan` is the exact inspection path. It hashes known files,
returns every file state, and defaults the dialog to `new`; choose `unchanged`
to inspect the already indexed set. The response also carries a deterministic
`plan_revision`. Background jobs recompute the plan in the child and reject a
changed revision, pending count, or shrunk file before creating tables or
writing rows.

During a write, event and provenance buffers are committed every 5,000 blocks.
Stable IDs make a retry idempotent, while the source-file manifest is saved only
after the complete file has been parsed and flushed.

The importer snapshots exactly the byte length observed during preflight, then
hashes and parses that immutable on-disk prefix. If a live JSONL file is appended
while the import runs, those new bytes stay out of the current provenance hash
and are picked up as a changed file on the next idempotent pass.

## Stop condition

The partial report moves `remaining_files` from `1` to `0`, while the canonical row count remains stable after the repeated import.
