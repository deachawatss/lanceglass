root := justfile_directory()
fixture := root / "fixtures/minimal"

lesson-01:
    bun src/cli.ts choose

lesson-02:
    bun install --silent
    bun src/cli.ts init

lesson-03:
    bun src/cli.ts schema

lesson-04:
    bun src/cli.ts normalize --file "{{fixture}}/session.jsonl" --source fixture

lesson-05:
    bun src/cli.ts plan --root "{{fixture}}" --source fixture
    bun src/cli.ts import --root "{{fixture}}" --source fixture --max-files 1

lesson-06:
    bun src/cli.ts status
    bun src/cli.ts events --source fixture --limit 10

lesson-07:
    bun run ui

archive-plan path="$HOME/agent-jsonl-backup":
    bun src/cli.ts plan --root "{{path}}" --source archive

# List provider plugins and show which environment variables are missing.
embed-providers:
    bun src/cli.ts embed providers

# Read-only Workers AI connectivity/model-revision check. Credentials stay in env.
embed-cloudflare-probe:
    bun src/cli.ts embed probe --deployment cloudflare

# Embed one bounded, resumable Cloudflare batch into its isolated vector store.
embed-cloudflare-run limit="20" batch_size="8" source="claude":
    bun src/cli.ts embed run --deployment cloudflare --source "{{source}}" --limit "{{limit}}" --batch-size "{{batch_size}}"

# Read-only dual-4090 connectivity/model-digest check. URLs stay in env.
embed-dual-4090-probe:
    bun src/cli.ts embed probe --deployment dual-4090

# Embed one bounded, resumable dual-4090 batch into the verified Ollama store.
embed-dual-4090-run limit="300" batch_size="8" source="claude":
    bun src/cli.ts embed run --deployment dual-4090 --source "{{source}}" --limit "{{limit}}" --batch-size "{{batch_size}}"

# Verify both remote deployments without opening LanceDB.
embed-both-probe:
    bun src/cli.ts embed probe --deployment cloudflare
    bun src/cli.ts embed probe --deployment dual-4090

# Build both vector spaces from the same bounded plain-data selection.
embed-both-run limit="20" batch_size="8" source="claude":
    bun src/cli.ts embed run --deployment cloudflare --source "{{source}}" --limit "{{limit}}" --batch-size "{{batch_size}}"
    bun src/cli.ts embed run --deployment dual-4090 --source "{{source}}" --limit "{{limit}}" --batch-size "{{batch_size}}"

smoke:
    bun run smoke

ui:
    bun run ui
