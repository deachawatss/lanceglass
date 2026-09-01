# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React, TypeScript, Vite, Tailwind CSS, Bun, and embedded LanceDB. The user explicitly requested React and Tailwind for this fresh lab.

## Users

The primary user is a developer who wants raw agent JSONL to become a typed,
inspectable LanceDB database. They work locally and need to see each import
decision before trusting it.

## Product Purpose

Lanceglass is a local-first application for planning, partially importing,
resuming, and inspecting canonical event data. Success means the user can import
one bounded batch, see what remains, run the same operation safely again, and
verify the stored rows.

## Positioning

The lab exposes the ingest ledger—new, changed, known, selected, and remaining files—instead of hiding import state behind a one-click uploader.

## Operating Context

The product runs on localhost beside a CLI and numbered lessons. The core workflow is: select a JSONL root and source label, inspect the plan, import a limited file batch, confirm progress, resume, then inspect canonical events and provenance counts.

## Capabilities and Constraints

- Use a fresh, isolated LanceDB directory; do not modify the user's source JSONL.
- Preserve deterministic, idempotent imports through file hashes and stable event IDs.
- Support partial import through a positive `maxFiles` limit and report selected and remaining file counts.
- Keep the server localhost-only and the interface honest about loading, errors, empty data, and completion.
- This is a smoke-first local tool, not a production multi-user service or a relational ORM.

## Evidence on Hand

- Real fixture data: `fixtures/minimal/session.jsonl` and `fixtures/minimal/z-session.jsonl`.
- Executable CLI and repository code under `src/`.
- A smoke test under `scripts/smoke.ts` is the acceptance proof.
- No claims about private external archives may be fabricated; the UI
  demonstrates only files actually selected and imported.

## Product Principles

1. Show the import decision before writing.
2. Make partial progress explicit and resumable.
3. Teach with real counts, paths, and canonical rows rather than decorative metrics.
4. Keep every local operation small enough to inspect and repeat safely.

## Open Decisions

Visual identity was not supplied. This session will establish a code-led Operate surface appropriate to the explicit React/Tailwind implementation request; that workflow preference is not persisted as a project default.
