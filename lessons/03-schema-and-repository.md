# 03 — Typed ORM-like repository

## Goal

Keep database details behind a small typed boundary.

This is **ORM-like**, not a full ORM. TypeScript row types describe what application code uses; runtime Arrow schemas describe what LanceDB stores; repositories own table operations. Callers should not scatter raw table names, filters, or row shapes throughout the importer, CLI, and UI.

## Read in this order

1. the domain row types
2. the runtime Arrow schemas
3. the database connection rooted at `.data/lancedb`
4. the repositories used by import, CLI, and UI code

The repository boundary should make these operations obvious:

- initialize/open tables
- find a source file by stable identity
- insert a canonical event only when it is new
- record source provenance
- list/count rows for CLI and UI reads

## Do

Run the real cumulative path rather than isolated unit tests:

```bash
just smoke
```

## Stop condition

The importer, CLI, and UI reach LanceDB through typed repository methods, and the smoke command can create and read the database without a test framework.
