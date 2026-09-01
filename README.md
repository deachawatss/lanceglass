# Lanceglass

> A local-first looking glass for Claude Code and Codex JSONL histories.

[![CI](https://github.com/Soul-Brews-Studio/lanceglass/actions/workflows/ci.yml/badge.svg)](https://github.com/Soul-Brews-Studio/lanceglass/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-67d391.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v26.9.1--alpha.1401-6f8cff.svg)](package.json)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)
[![LanceDB](https://img.shields.io/badge/database-LanceDB-6f8cff.svg)](https://lancedb.com)

Lanceglass turns append-only agent session logs into a typed, inspectable
LanceDB. It detects new and changed JSONL files, imports idempotently, preserves
provenance, reconstructs work history, and can build optional embedding spaces
without coupling vectors to ingestion.

Everything runs on your machine. The bundled fixture proves the complete path
without reading your real agent history.

![Lanceglass architecture](docs/lanceglass-architecture.visual-check.2048x1320.dark.png)

See every durable Events, Import, Jobs, History, and Vector Map state in the
[GitHub-renderable UI state gallery](docs/ui-state-gallery.md).

**[Open the public static fixture demo](https://lanceglass-fixture-demo.laris.workers.dev/)** —
the production React UI with 1,000 bundled synthetic events. It uses no KV,
no D1, no database binding, and no persistence; import actions are deterministic
simulations that reset to the same fixture state.

## Why Lanceglass

- **Know what changed before writing.** A metadata-only intake scan shows new,
  changed, known, and reconcile-required files.
- **Import safely.** Stable event, block, occurrence, and file identities make
  bounded retries idempotent.
- **Keep evidence attached.** Canonical events remain connected to source files,
  folders, sessions, projects, timestamps, and semantic roles.
- **Read work as history.** Browse by day, week, month, source, project, folder,
  or session instead of opening thousands of JSONL files.
- **Embed later.** Plain rows and vector indexes live in separate LanceDB stores.
  Import never contacts an embedding service.
- **Use one engine everywhere.** The browser, direct CLI, and optional `maw`
  adapter all call the same typed repositories and importer.

## Privacy boundary

Lanceglass is designed for private local histories:

- `.data/`, `.env*`, generated plugin bundles, and UI builds are git-ignored.
- Claude Code and Codex roots are local filesystem presets only.
- No telemetry or automatic network upload is implemented.
- Embeddings are disabled during import and require an explicit deployment.
- Remote provider credentials are read from environment variables, never stored
  in configuration or printed by provider inspection.
- Each incompatible embedding space gets a separate physical vector store.

Before publishing a fork, run the repository's public-safety checks described in
[SECURITY.md](SECURITY.md). Never commit real session logs or LanceDB data.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3 or newer. `just` is convenient but not
required.

```bash
git clone https://github.com/Soul-Brews-Studio/lanceglass.git
cd lanceglass
bun install --frozen-lockfile
bun run smoke
```

The smoke gate builds the production UI, creates isolated temporary databases,
normalizes only the bundled fixtures, imports a partial batch, resumes through
HTTP, proves idempotency, checks history/vector boundaries, and serves the built
application. A successful run ends with `SMOKE PASS`.

Start the local app:

```bash
bun run ui
# http://127.0.0.1:4320
```

## Import agent histories

Claude Code is the default preset; Codex is explicit:

```bash
# Read-only plans
bun src/cli.ts plan --source claude
bun src/cli.ts plan --source codex

# Bounded, resumable imports
bun src/cli.ts import --source claude --max-files 10
bun src/cli.ts import --source codex --max-files 10

# Inspect the resulting rows
bun src/cli.ts status
bun src/cli.ts events --source claude --limit 20
```

Default roots are `~/.claude/projects` and `~/.codex/sessions`. Use `--root` to
point at another directory. The fixture remains the safest first run:

```bash
bun src/cli.ts plan --root fixtures/minimal --source fixture
bun src/cli.ts import --root fixtures/minimal --source fixture --max-files 1
```

Long imports stream progress to stderr while the final JSON report stays on
stdout, so piping to `jq` remains safe.

## What gets stored

The plain database owns three logical strata:

| Table | Purpose |
| --- | --- |
| `events` | Canonical normalized text/tool blocks with stable IDs |
| `event_sources` | Provenance occurrences connecting events to files and folders |
| `source_files` | Import manifest, snapshot hashes, progress, and recovery state |

The optional vector database owns `event_vectors`. It is opened only by an
explicit embedding command. See the step-by-step schema and repository lesson in
[`lessons/03-schema-and-repository.md`](lessons/03-schema-and-repository.md).

## Optional embeddings

List deployment readiness without printing credential values:

```bash
bun src/cli.ts embed providers
bun src/cli.ts embed probe --deployment m5-ollama
bun src/cli.ts embed run --deployment m5-ollama \
  --source claude --limit 300 --batch-size 8
```

Built-in adapters cover a local Ollama instance, a multi-endpoint Ollama pool,
and Cloudflare Workers AI. They all implement one `EmbeddingProvider` interface,
but incompatible model revisions never share a vector store. Provider selection
is explicit and scoped runs can be limited by project, folder, or Bangkok date
range.

Read [`docs/embedding-provider-plugins.md`](docs/embedding-provider-plugins.md)
for the provider contract and
[`docs/vector-visualization-plugins.md`](docs/vector-visualization-plugins.md)
for the 2D/3D visualization registry.

## Browser workspaces

- **Events** — bounded canonical stream with source/project/folder filters.
- **History** — day/week/month work reconstruction and session drill-down.
- **Vector map** — scoped 2D or 3D PCA projection across selected vector spaces.
- **Jobs** — live import output, cancellation, results, and full hash inspection.

Fast Inspect returns only actionable files using tracked file metadata. Full
content-hash inspection is deliberately separated into Jobs.

## Optional maw adapter

If [`maw`](https://github.com/Soul-Brews-Studio/maw-js) is installed:

```bash
bun run maw:install
maw jscan plan --source claude
maw jscan import --source claude --max-files 10
maw jscan ui --port 4320
```

The generated adapter contains a local checkout marker and is intentionally not
tracked or published as source history.

## Learn the engine

The repository keeps the original smoke-first course:

1. [Choose LanceDB](lessons/01-choose-db.md)
2. [Create isolated stores](lessons/02-create-db.md)
3. [Typed repository boundary](lessons/03-schema-and-repository.md)
4. [Normalize JSONL](lessons/04-normalize-jsonl.md)
5. [Import and deduplicate](lessons/05-import-and-dedupe.md)
6. [Use the CLI](lessons/06-cli.md)
7. [Run the UI](lessons/07-ui.md)
8. [Add optional embeddings](lessons/08-optional-embeddings.md)

The [documentation index](docs/README.md) links the interactive system diagram,
the complete screenshot gallery, and both extension contracts.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run ui:build
bun run smoke
```

`bun run smoke` is the release gate. It currently covers 163 focused tests plus
a nine-stage end-to-end fixture run.

## Project map

```text
src/          typed schemas, repositories, normalization, import, history, vectors
ui/           React application and visualization plugins
tests/        backend and integration tests
fixtures/     synthetic JSONL only
lessons/      smoke-first learning path
docs/         architecture and extension contracts
maw-plugin/   optional local CLI adapter
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security and privacy issues should follow
[SECURITY.md](SECURITY.md), not a public issue.

## License

MIT © 2026 [Soul Brews Studio](https://github.com/Soul-Brews-Studio)
