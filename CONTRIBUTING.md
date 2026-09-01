# Contributing to Lanceglass

Thank you for helping make private agent history easier to inspect.

## Start with the fixture

```bash
bun install --frozen-lockfile
bun run smoke
```

Do not use private session data in a reproduction. Extend `fixtures/minimal` or
create synthetic records in a temporary directory instead.

## Change discipline

1. Add or update a focused regression test.
2. Keep plain import independent from vector providers.
3. Preserve stable IDs, provenance, resumability, and bounded reads/writes.
4. Update README or extension contracts when a public interface changes.
5. Run `bun run smoke` before opening a pull request.

## Provider and visualization plugins

- Embedding providers must follow
  [`docs/embedding-provider-plugins.md`](docs/embedding-provider-plugins.md).
- Vector visualizations must follow
  [`docs/vector-visualization-plugins.md`](docs/vector-visualization-plugins.md).

Never put secrets in plugin metadata. Declare environment-variable names only.

## Pull requests

Explain the user-visible outcome, test evidence, data/privacy impact, and any
remaining risk. Small, reviewable commits are preferred.
