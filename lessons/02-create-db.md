# 02 — Create the database

## Goal

Create a fresh database inside this lab and make table creation safe to repeat.

## Data model

The lab separates three questions:

```text
events         What canonical JSONL blocks have we learned?
event_sources  Where was each canonical block observed?
source_files   Is this input file new or already known?
```

The database path is always this lab's `.data/lancedb` unless an explicit Lab 2 override is supplied. It must never fall back to another lab's data directory.

## Do

Start from zero and run the smoke path:

```bash
rm -rf .data/lancedb
just smoke
```

Inspect `.data/lancedb` after the command. Run `just smoke` again; table creation must remain idempotent.

## Stop condition

`.data/lancedb` exists, the required tables can be opened, and a second smoke run does not fail because the tables already exist.
