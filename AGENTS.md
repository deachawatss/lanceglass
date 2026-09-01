# Lanceglass contributor instructions

## Product invariants

- Import writes only to the plain LanceDB store. Embedding is always explicit.
- Never mix incompatible embedding spaces in one physical vector store.
- Never commit real JSONL histories, `.data/`, credentials, or generated maw
  checkout markers.
- Preserve idempotent resume behavior and stable canonical/provenance IDs.
- Keep the browser, direct CLI, and maw adapter on the same core implementation.

## Release identity

- `package.json#version` is authoritative and uses `YY.M.D[-alpha.HMM|-beta.HMM]`
  in the `Asia/Bangkok` calendar.
- `maw-plugin/plugin.json` must carry the same version.
- `bun run version:check` verifies alignment.

## Required verification

Run the smallest focused test while editing, then run the full public gate before
handoff:

```bash
bun run smoke
```

The gate includes version alignment, TypeScript, production UI build, the full
test suite, and a fresh isolated end-to-end fixture smoke run.

## Public-safety rule

Use synthetic fixture names and generic paths such as `/Users/example`. Do not
paste captured session contents, private repository names, LAN addresses, tokens,
account IDs, or local absolute checkout paths into source, tests, docs, images,
or commit messages.
