import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  EMBEDDING_SPACE_ID,
  EMBEDDING_TEXT_POLICY,
} from "./schemas";

export const BUILTIN_EMBEDDING_PROVIDER_KINDS = [
  "ollama",
  "openai-compatible",
  "cloudflare-workers-ai",
] as const;

export type BuiltinEmbeddingProviderKind =
  typeof BUILTIN_EMBEDDING_PROVIDER_KINDS[number];

/** Built-ins stay discoverable while source plugins may name a new transport. */
export type EmbeddingProviderKind =
  | BuiltinEmbeddingProviderKind
  | (string & {});

export type EmbeddingDistance = "cosine" | "l2" | "dot";

export type EmbeddingSpace = Readonly<{
  /** Stable storage identity. Never reuse this ID for a changed contract. */
  id: string;
  provider: EmbeddingProviderKind;
  model: string;
  /** Immutable model digest/version when known; use unversioned explicitly otherwise. */
  revision: string;
  dimension: number;
  distance: EmbeddingDistance;
  textPolicy: string;
}>;

export function defineEmbeddingSpace(space: EmbeddingSpace): EmbeddingSpace {
  for (const [name, value] of [
    ["id", space.id],
    ["model", space.model],
    ["revision", space.revision],
    ["text policy", space.textPolicy],
  ] as const) {
    if (!value.trim()) throw new Error(`embedding space ${name} must not be empty`);
  }
  if (!Number.isInteger(space.dimension) || space.dimension <= 0) {
    throw new Error("embedding space dimension must be a positive integer");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(space.id)) {
    throw new Error(
      "embedding space id must use only letters, numbers, dots, underscores, and hyphens",
    );
  }
  return Object.freeze({ ...space });
}

export function sameEmbeddingSpace(left: EmbeddingSpace, right: EmbeddingSpace) {
  return left.id === right.id &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.revision === right.revision &&
    left.dimension === right.dimension &&
    left.distance === right.distance &&
    left.textPolicy === right.textPolicy;
}

export const ACTIVE_EMBEDDING_SPACE = defineEmbeddingSpace({
  id: EMBEDDING_SPACE_ID,
  provider: "ollama",
  model: EMBEDDING_MODEL,
  revision: EMBEDDING_REVISION,
  dimension: EMBEDDING_DIMENSION,
  distance: "cosine",
  textPolicy: EMBEDDING_TEXT_POLICY,
});

/** Verified identical to M5 Ollama; deployment hardware is not a vector space. */
export const DUAL_4090_EMBEDDING_SPACE = ACTIVE_EMBEDDING_SPACE;

export const CLOUDFLARE_EMBEDDING_SPACE = defineEmbeddingSpace({
  id: "cloudflare-bge-m3-8bddd3ea514a-1024-cosine-text-v1",
  provider: "cloudflare-workers-ai",
  model: "@cf/baai/bge-m3",
  // Workers AI does not expose a model digest. This is the Float32 SHA-256 of
  // CLOUDFLARE_REVISION_PROBE_TEXT, stable across repeated independent probes.
  revision: "probe-f32-sha256:8bddd3ea514a586ab90e4568f0664ae82b97672184c2e875c7d1d35931c911a6",
  dimension: EMBEDDING_DIMENSION,
  distance: "cosine",
  textPolicy: EMBEDDING_TEXT_POLICY,
});

export const CLOUDFLARE_REVISION_PROBE_TEXT =
  "jsonl-core-log embedding-space revision probe v1";

export type EmbeddingEndpointConfig = Readonly<{
  /** Environment variable containing the endpoint base URL. */
  baseUrlEnv: string;
  /** Safe local fallback; remote deployments should not provide one. */
  defaultBaseUrl?: string;
  /** Environment variable containing a bearer token, never the token itself. */
  apiKeyEnv?: string;
}>;

export type OllamaProviderConfig = Readonly<{
  kind: "ollama";
  endpoint: EmbeddingEndpointConfig;
  space: EmbeddingSpace;
}>;

export type OllamaPoolProviderConfig = Readonly<{
  kind: "ollama-pool";
  /** Comma-separated Ollama base URLs; the adapter owns balancing and failover. */
  baseUrlsEnv: string;
  space: EmbeddingSpace;
}>;

/**
 * Preparation for OpenAI itself and self-hosted services such as TEI.
 * Configuration names the environment variable, never the credential value.
 */
export type OpenAICompatibleProviderConfig = Readonly<{
  kind: "openai-compatible";
  endpoint: EmbeddingEndpointConfig;
  space: EmbeddingSpace;
}>;

export type CloudflareWorkersAIProviderConfig = Readonly<{
  kind: "cloudflare-workers-ai";
  accountIdEnv: string;
  apiTokenEnv: string;
  apiBaseUrlEnv?: string;
  space: EmbeddingSpace;
}>;

export type EmbeddingProviderConfig =
  | OllamaProviderConfig
  | OllamaPoolProviderConfig
  | OpenAICompatibleProviderConfig
  | CloudflareWorkersAIProviderConfig;

export type EmbeddingProviderConfigBase = Readonly<{
  kind: string;
  space: EmbeddingSpace;
}>;

export type EmbeddingDeploymentId = string;

export type EmbeddingDeployment<
  Config extends EmbeddingProviderConfigBase = EmbeddingProviderConfigBase,
> = Readonly<{
  id: EmbeddingDeploymentId;
  label: string;
  location: "local" | "lan" | "cloud";
  hardware: string;
  config: Config;
  /** Stable routing key: deployments sharing a proven space share one store. */
  vectorStoreKey: string;
}>;

export function defineEmbeddingDeployment<Config extends EmbeddingProviderConfigBase>(
  deployment: Omit<EmbeddingDeployment<Config>, "vectorStoreKey">,
): EmbeddingDeployment<Config> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(deployment.id)) {
    throw new Error(
      "embedding deployment id must use only letters, numbers, dots, underscores, and hyphens",
    );
  }
  if (!deployment.label.trim()) throw new Error("embedding deployment label must not be empty");
  const configurable = deployment.config as Config & { endpoint?: Record<string, unknown> };
  const config = configurable.endpoint
    ? Object.freeze({
      ...configurable,
      endpoint: Object.freeze({ ...configurable.endpoint }),
    }) as Config
    : Object.freeze({ ...configurable }) as Config;
  return Object.freeze({
    ...deployment,
    config,
    vectorStoreKey: config.space.id,
  });
}

export const EMBEDDING_DEPLOYMENTS: Readonly<
  Record<"m5-ollama" | "dual-4090" | "cloudflare", EmbeddingDeployment>
> = Object.freeze({
  "m5-ollama": defineEmbeddingDeployment({
    id: "m5-ollama",
    label: "M5 · Ollama",
    location: "local",
    hardware: "apple-m5",
    config: {
      kind: "ollama",
      endpoint: {
        baseUrlEnv: "M5_OLLAMA_URL",
        defaultBaseUrl: "http://127.0.0.1:11434",
      },
      space: ACTIVE_EMBEDDING_SPACE,
    },
  }),
  "dual-4090": defineEmbeddingDeployment({
    id: "dual-4090",
    label: "2× RTX 4090 · Ollama pool",
    location: "lan",
    hardware: "2x-nvidia-rtx-4090",
    config: {
      kind: "ollama-pool",
      baseUrlsEnv: "DUAL_4090_OLLAMA_URLS",
      space: DUAL_4090_EMBEDDING_SPACE,
    },
  }),
  cloudflare: defineEmbeddingDeployment({
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    location: "cloud",
    hardware: "cloudflare-managed",
    config: {
      kind: "cloudflare-workers-ai",
      accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
      apiTokenEnv: "CLOUDFLARE_API_TOKEN",
      apiBaseUrlEnv: "CLOUDFLARE_AI_BASE_URL",
      space: CLOUDFLARE_EMBEDDING_SPACE,
    },
  }),
});

export type EmbeddingProvider = {
  readonly space: EmbeddingSpace;
  embed(texts: string[]): Promise<number[][]>;
};

/**
 * Adapts any transport response to the one canonical provider interface.
 * Shape conversion belongs here; count, dimension, and numeric validation stay
 * centralized in the embedding pipeline.
 */
export function wrapEmbeddingProvider(options: Readonly<{
  space: EmbeddingSpace;
  request: (texts: string[]) => Promise<unknown>;
  toVectors: (response: unknown) => number[][];
}>): EmbeddingProvider {
  return Object.freeze({
    space: options.space,
    async embed(texts: string[]) {
      return options.toVectors(await options.request(texts));
    },
  });
}

export type OllamaEmbeddingProviderOptions = {
  url?: string;
  timeoutMs?: number;
};

export type OllamaPoolEmbeddingProviderOptions = {
  urls?: string[];
  timeoutMs?: number;
};

export class EmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingValidationError";
  }
}

async function verifyOllamaEndpoint(
  url: string,
  space: EmbeddingSpace,
  timeoutMs: number,
) {
  const response = await fetch(`${url.replace(/\/$/, "")}/api/tags`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/tags failed at ${url} (${response.status})`);
  }
  const body = await response.json() as {
    models?: Array<{ name?: unknown; model?: unknown; digest?: unknown }>;
  };
  const names = new Set([space.model, `${space.model}:latest`]);
  const model = body.models?.find((item) =>
    (typeof item.name === "string" && names.has(item.name)) ||
    (typeof item.model === "string" && names.has(item.model))
  );
  if (!model) throw new Error(`Ollama model ${space.model} is not installed at ${url}`);
  if (space.revision !== "unversioned" && model.digest !== space.revision) {
    throw new Error(
      `Ollama model revision mismatch at ${url}: expected ${space.revision}, got ${
        typeof model.digest === "string" ? model.digest : "missing"
      }`,
    );
  }
}

async function ensureOllamaEndpoint(
  verified: Map<string, Promise<void>>,
  url: string,
  space: EmbeddingSpace,
  timeoutMs: number,
) {
  let pending = verified.get(url);
  if (!pending) {
    pending = verifyOllamaEndpoint(url, space, timeoutMs);
    verified.set(url, pending);
  }
  try {
    await pending;
  } catch (error) {
    verified.delete(url);
    throw error;
  }
}

async function requestOllamaEmbeddings(
  url: string,
  space: EmbeddingSpace,
  texts: string[],
  timeoutMs: number,
) {
  const response = await fetch(`${url.replace(/\/$/, "")}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: space.model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Ollama /api/embed failed at ${url} (${response.status}): ${body}`);
  }
  const body = await response.json() as { embeddings?: unknown };
  if (!Array.isArray(body.embeddings)) {
    throw new EmbeddingValidationError(
      `Ollama /api/embed response from ${url} has no embeddings array`,
    );
  }
  return body.embeddings as number[][];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly url: string;
  readonly space = ACTIVE_EMBEDDING_SPACE;
  readonly timeoutMs: number;
  readonly #verified = new Map<string, Promise<void>>();

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    this.url = options.url ??
      process.env.M5_OLLAMA_URL ??
      process.env.OLLAMA_URL ??
      "http://127.0.0.1:11434";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async embed(texts: string[]) {
    if (!texts.length) return [];
    await ensureOllamaEndpoint(this.#verified, this.url, this.space, this.timeoutMs);
    return requestOllamaEmbeddings(this.url, this.space, texts, this.timeoutMs);
  }
}

export function parseOllamaUrls(value: string | undefined) {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export class OllamaPoolEmbeddingProvider implements EmbeddingProvider {
  readonly urls: readonly string[];
  readonly space = DUAL_4090_EMBEDDING_SPACE;
  readonly timeoutMs: number;
  #cursor = 0;
  readonly #verified = new Map<string, Promise<void>>();

  constructor(options: OllamaPoolEmbeddingProviderOptions = {}) {
    const urls = options.urls ?? parseOllamaUrls(process.env.DUAL_4090_OLLAMA_URLS);
    if (!urls.length) {
      throw new Error("DUAL_4090_OLLAMA_URLS must contain at least one Ollama endpoint");
    }
    this.urls = Object.freeze([...new Set(urls.map((url) => url.replace(/\/$/, "")))]);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async embed(texts: string[]) {
    if (!texts.length) return [];
    if (texts.length === 1) {
      const start = this.#cursor++ % this.urls.length;
      return this.#embedShard(texts, start);
    }

    const shardCount = Math.min(texts.length, this.urls.length);
    const baseSize = Math.floor(texts.length / shardCount);
    const largerShardCount = texts.length % shardCount;
    let start = 0;
    const shards = Array.from({ length: shardCount }, (_, endpointIndex) => {
      const size = baseSize + (endpointIndex < largerShardCount ? 1 : 0);
      const shard = {
        endpointIndex,
        start,
        texts: texts.slice(start, start + size),
      };
      start += size;
      return shard;
    });

    const completed = await Promise.all(shards.map(async (shard) => ({
      start: shard.start,
      vectors: await this.#embedShard(shard.texts, shard.endpointIndex),
    })));
    const vectors = new Array<number[]>(texts.length);
    for (const shard of completed) {
      for (let index = 0; index < shard.vectors.length; index++) {
        vectors[shard.start + index] = shard.vectors[index]!;
      }
    }
    return vectors;
  }

  async #embedShard(texts: string[], primaryEndpointIndex: number) {
    const failures: string[] = [];
    for (let offset = 0; offset < this.urls.length; offset++) {
      const url = this.urls[(primaryEndpointIndex + offset) % this.urls.length]!;
      try {
        await ensureOllamaEndpoint(this.#verified, url, this.space, this.timeoutMs);
        return await requestOllamaEmbeddings(url, this.space, texts, this.timeoutMs);
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`all Ollama pool endpoints failed: ${failures.join(" | ")}`);
  }
}
