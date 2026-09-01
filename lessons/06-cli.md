# 06 — CLI

## Goal

Inspect the same repository used by the importer without opening LanceDB internals manually.

The CLI should expose a small learning surface:

- initialize or inspect database state
- normalize/import an explicit fixture or root
- show `new` versus `known`
- list status/counts and recent canonical events
- search or filter rows when supported by the implementation

Prefer structured output so both a human and the smoke script can inspect it.
Progress is a separate stream: in an interactive terminal, live phase/heartbeat
lines go to `stderr`, while the one final machine-readable report goes to
`stdout`. This prevents a long LanceDB merge from looking frozen without
corrupting JSON consumers. The current maw dev-plugin host buffers both streams
until exit when stderr has no TTY (for example, CI or redirected execution), so
live redirected output requires a future maw host streaming mode rather than
mixing progress into stdout.

The installed maw adapter exposes the same commands without duplicating importer
logic. For example:

```bash
maw jscan import --root fixtures/minimal --source fixture --max-files 1
maw jscan status
```

`--max-files 1` bounds the write batch, not the discovery pass. The importer
still scans and compares the full root first so it can accurately report what is
new, unchanged, changed, or still remaining.

## Do

Run the cumulative smoke command and locate the CLI phase in its output:

```bash
just smoke
```

Then inspect the `justfile` for the individual CLI recipes that the smoke workflow composes. Use those recipes for exploration; keep `just smoke` as the verification gate.

## Stop condition

The CLI can read the fixture import from `.data/lancedb` and clearly reports database counts plus the new/known import result.
