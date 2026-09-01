import {
  EMBEDDING_DEPLOYMENTS,
  OllamaEmbeddingProvider,
  OllamaPoolEmbeddingProvider,
  parseOllamaUrls,
  sameEmbeddingSpace,
  type EmbeddingDeployment,
  type EmbeddingProvider,
  type EmbeddingSpace,
} from "./embedding-provider";
import { CloudflareWorkersAIProvider } from "./embedding-providers/cloudflare";
import {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  defineEmbeddingProviderPlugin,
  type EmbeddingEnvironmentVariable,
  type EmbeddingProviderEnvironment,
  type EmbeddingProviderPlugin,
} from "./embedding-plugin";

export {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  defineEmbeddingProviderPlugin,
} from "./embedding-plugin";
export type {
  EmbeddingEnvironmentVariable,
  EmbeddingProviderEnvironment,
  EmbeddingProviderPlugin,
} from "./embedding-plugin";

export type EmbeddingProviderDescription = Readonly<{
  id: string;
  label: string;
  location: EmbeddingDeployment["location"];
  hardware: string;
  provider: string;
  model: string;
  revision: string;
  dimension: number;
  vector_store_key: string;
  configured: boolean;
  missing_environment: readonly string[];
  environment: readonly EmbeddingEnvironmentVariable[];
}>;

const m5OllamaPlugin = defineEmbeddingProviderPlugin({
  apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  deployment: EMBEDDING_DEPLOYMENTS["m5-ollama"],
  environment: [
    {
      name: "M5_OLLAMA_URL",
      required: false,
      defaultValue: "http://127.0.0.1:11434",
      description: "Preferred local Ollama base URL.",
    },
    {
      name: "OLLAMA_URL",
      required: false,
      description: "Legacy fallback when M5_OLLAMA_URL is unset.",
    },
  ],
  create(environment) {
    return new OllamaEmbeddingProvider({
      url: environment.M5_OLLAMA_URL ?? environment.OLLAMA_URL ?? "http://127.0.0.1:11434",
    });
  },
});

const dual4090Plugin = defineEmbeddingProviderPlugin({
  apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  deployment: EMBEDDING_DEPLOYMENTS["dual-4090"],
  environment: [{
    name: "DUAL_4090_OLLAMA_URLS",
    required: true,
    description: "Comma-separated Ollama base URLs used for round-robin batches and failover.",
  }],
  create(environment) {
    return new OllamaPoolEmbeddingProvider({
      urls: parseOllamaUrls(environment.DUAL_4090_OLLAMA_URLS),
    });
  },
});

const cloudflarePlugin = defineEmbeddingProviderPlugin({
  apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  deployment: EMBEDDING_DEPLOYMENTS.cloudflare,
  environment: [
    {
      name: "CLOUDFLARE_ACCOUNT_ID",
      required: true,
      description: "Cloudflare account that can run Workers AI.",
    },
    {
      name: "CLOUDFLARE_API_TOKEN",
      required: true,
      secret: true,
      description: "Bearer token with Workers AI read/run permission.",
    },
    {
      name: "CLOUDFLARE_AI_BASE_URL",
      required: false,
      defaultValue: "https://api.cloudflare.com/client/v4",
      description: "Optional REST base URL for testing or an approved proxy.",
    },
  ],
  create(environment) {
    return new CloudflareWorkersAIProvider({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      apiToken: environment.CLOUDFLARE_API_TOKEN,
      apiBaseUrl: environment.CLOUDFLARE_AI_BASE_URL,
    });
  },
});

export const BUILTIN_EMBEDDING_PROVIDER_PLUGINS = Object.freeze([
  m5OllamaPlugin,
  dual4090Plugin,
  cloudflarePlugin,
]);

export function createEmbeddingProviderRegistry(plugins: readonly EmbeddingProviderPlugin[]) {
  const byId = new Map<string, EmbeddingProviderPlugin>();
  const spacesByStoreKey = new Map<string, EmbeddingSpace>();
  for (const plugin of plugins) {
    const id = plugin.deployment.id;
    if (byId.has(id)) throw new Error(`duplicate embedding provider plugin: ${id}`);
    const { vectorStoreKey } = plugin.deployment;
    const priorSpace = spacesByStoreKey.get(vectorStoreKey);
    if (priorSpace && !sameEmbeddingSpace(priorSpace, plugin.deployment.config.space)) {
      throw new Error(
        `embedding vector store key ${vectorStoreKey} maps to incompatible spaces`,
      );
    }
    byId.set(id, plugin);
    spacesByStoreKey.set(vectorStoreKey, plugin.deployment.config.space);
  }
  const available = [...byId.keys()].sort();

  function get(id: string) {
    const plugin = byId.get(id);
    if (!plugin) {
      throw new Error(
        `unknown embedding deployment ${JSON.stringify(id)}; choose ${available.join(", ")}`,
      );
    }
    return plugin;
  }

  function missingEnvironment(
    plugin: EmbeddingProviderPlugin,
    environment: EmbeddingProviderEnvironment,
  ) {
    return plugin.environment
      .filter((item) => item.required && !environment[item.name]?.trim())
      .map((item) => item.name);
  }

  return Object.freeze({
    plugins: Object.freeze([...plugins]),
    get,
    describe(environment: EmbeddingProviderEnvironment = process.env) {
      return Object.freeze([...byId.values()].map((plugin): EmbeddingProviderDescription => {
        const deployment = plugin.deployment;
        const missing = missingEnvironment(plugin, environment);
        return Object.freeze({
          id: deployment.id,
          label: deployment.label,
          location: deployment.location,
          hardware: deployment.hardware,
          provider: deployment.config.space.provider,
          model: deployment.config.space.model,
          revision: deployment.config.space.revision,
          dimension: deployment.config.space.dimension,
          vector_store_key: deployment.vectorStoreKey,
          configured: missing.length === 0,
          missing_environment: Object.freeze(missing),
          environment: Object.freeze(plugin.environment.map((item) => Object.freeze({
            name: item.name,
            required: item.required,
            ...(item.secret ? { secret: true } : {}),
            ...(item.defaultValue !== undefined ? { defaultValue: item.defaultValue } : {}),
            description: item.description,
          }))),
        });
      }));
    },
    create(id: string, environment: EmbeddingProviderEnvironment = process.env) {
      const plugin = get(id);
      const missing = missingEnvironment(plugin, environment);
      if (missing.length) {
        throw new Error(
          `embedding deployment ${id} is missing environment: ${missing.join(", ")}`,
        );
      }
      const provider = plugin.create(environment);
      if (!sameEmbeddingSpace(provider.space, plugin.deployment.config.space)) {
        throw new Error(
          `embedding provider ${id} returned a space that differs from its deployment contract`,
        );
      }
      return provider;
    },
  });
}

export const embeddingProviderRegistry = createEmbeddingProviderRegistry(
  BUILTIN_EMBEDDING_PROVIDER_PLUGINS,
);
