# Embedding provider plugins

Lanceglass keeps import, embedding transport, and vector persistence as
separate modules. A provider plugin changes **where vectors come from** without
changing candidate selection, validation, resume logic, or LanceDB writes.

## Stable v1 seam

The deep module has two small interfaces:

```ts
type EmbeddingProvider = {
  readonly space: EmbeddingSpace;
  embed(texts: string[]): Promise<number[][]>;
};

type EmbeddingProviderPlugin = {
  readonly apiVersion: 1;
  readonly deployment: EmbeddingDeployment;
  readonly environment: readonly EmbeddingEnvironmentVariable[];
  create(environment: Readonly<Record<string, string | undefined>>): EmbeddingProvider;
};
```

The adapter owns HTTP shape, authentication headers, endpoint verification,
load balancing, and failover. The core owns input selection, output count,
dimension, finite-number and non-zero validation, locking, incremental upsert,
and progress. Credential **names** are public metadata; credential values stay
in environment variables and must never appear in argv, logs, descriptors, or
tests.

Plugins are source plugins: reviewed static imports compiled with the app. The
registry never downloads or executes a remote package. This makes ordinary pull
requests extensible without turning a provider name into arbitrary code
execution.

## Add a provider

1. Add one adapter under `src/embedding-providers/`.
2. Give it a unique, immutable `EmbeddingSpace`. Never reuse a space ID after
   changing model weights, revision, dimension, distance, or text policy.
3. Define its deployment and environment metadata with
   `defineEmbeddingDeployment()` and `defineEmbeddingProviderPlugin()`.
4. Statically add the plugin to `BUILTIN_EMBEDDING_PROVIDER_PLUGINS` in
   `src/embedding-plugins.ts`.
5. Add transport, credential-redaction, output-shape, revision-mismatch,
   registry, and isolated-vector-store tests.
6. Run `bun run smoke`.

Minimal adapter:

```ts
import {
  defineEmbeddingDeployment,
  defineEmbeddingSpace,
  type EmbeddingProvider,
} from "../embedding-provider";
import {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  defineEmbeddingProviderPlugin,
} from "../embedding-plugin";

const space = defineEmbeddingSpace({
  id: "example-model-revision-768-cosine-text-v1",
  provider: "example-native",
  model: "example/model",
  revision: "immutable-model-revision",
  dimension: 768,
  distance: "cosine",
  textPolicy: "event.text.slice(0,2000)@v1",
});

class ExampleProvider implements EmbeddingProvider {
  readonly space = space;
  constructor(private readonly url: string) {}
  async embed(texts: string[]) {
    // Build provider-specific request and return one number[] per input.
    return requestExample(this.url, texts);
  }
}

export const examplePlugin = defineEmbeddingProviderPlugin({
  apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  deployment: defineEmbeddingDeployment({
    id: "example",
    label: "Example embedding server",
    location: "lan",
    hardware: "contributor-defined",
    config: { kind: "example-http", endpointEnv: "EXAMPLE_EMBED_URL", space },
  }),
  environment: [{
    name: "EXAMPLE_EMBED_URL",
    required: true,
    description: "Example embedding endpoint.",
  }],
  create(env) {
    return new ExampleProvider(env.EXAMPLE_EMBED_URL!);
  },
});
```

## Built-ins

| Deployment | Adapter | Space/store behavior |
| --- | --- | --- |
| `m5-ollama` | one local Ollama endpoint | shares the pinned Ollama BGE-M3 store |
| `dual-4090` | round-robin/failover Ollama pool | shares that store only because digest and probes were verified |
| `cloudflare` | Workers AI native REST | isolated store; managed model is guarded by a deterministic probe fingerprint |

```bash
maw jscan embed providers
maw jscan embed probe --deployment cloudflare
maw jscan embed run --deployment dual-4090 --source claude --limit 100
```

`probe` never opens LanceDB. `run` chooses a vector directory by embedding-space
ID unless `VECTOR_DB_DIR` explicitly overrides it; a mismatched schema is
rejected before writes.

## Cloudflare contract

The adapter uses Cloudflare's native Workers AI endpoint:

```text
POST /client/v4/accounts/{account}/ai/run/@cf/baai/bge-m3
Authorization: Bearer $CLOUDFLARE_API_TOKEN
Content-Type: application/json

{"text":["one text","another text"]}
```

Cloudflare documents the model and REST shape but not a public model digest.
The adapter therefore sends one deterministic single-text revision probe before
its first user batch, hashes the returned Float32 bytes, and refuses a
fingerprint mismatch. The probe is separate because Workers AI can produce tiny
batch-shape-dependent floating-point differences for the same text.
The pinned fingerprint was stable across repeated independent probes.

Primary references:

- <https://developers.cloudflare.com/workers-ai/models/bge-m3/>
- <https://developers.cloudflare.com/workers-ai/get-started/rest-api/>
- <https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/>

## Publication boundary

Provider plugins declare environment-variable names but never credentials or
secret defaults. Public contributions must use synthetic endpoints and tests,
pass the full smoke gate, and follow the repository security policy.
