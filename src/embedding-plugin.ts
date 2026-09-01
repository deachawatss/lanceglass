import type { EmbeddingDeployment, EmbeddingProvider } from "./embedding-provider";

export const EMBEDDING_PROVIDER_PLUGIN_API_VERSION = 1 as const;

export type EmbeddingProviderEnvironment = Readonly<Record<string, string | undefined>>;

export type EmbeddingEnvironmentVariable = Readonly<{
  name: string;
  required: boolean;
  secret?: boolean;
  defaultValue?: string;
  description: string;
}>;

/**
 * Public source-plugin seam. A plugin owns transport/configuration; the core
 * continues to own candidate selection, validation, persistence, and resume.
 * Plugins are statically registered and reviewed—never downloaded at runtime.
 */
export type EmbeddingProviderPlugin = Readonly<{
  apiVersion: typeof EMBEDDING_PROVIDER_PLUGIN_API_VERSION;
  deployment: EmbeddingDeployment;
  environment: readonly EmbeddingEnvironmentVariable[];
  create(environment: EmbeddingProviderEnvironment): EmbeddingProvider;
}>;

export function defineEmbeddingProviderPlugin(
  plugin: EmbeddingProviderPlugin,
): EmbeddingProviderPlugin {
  if (plugin.apiVersion !== EMBEDDING_PROVIDER_PLUGIN_API_VERSION) {
    throw new Error(
      `unsupported embedding provider plugin API ${plugin.apiVersion}; expected ${EMBEDDING_PROVIDER_PLUGIN_API_VERSION}`,
    );
  }
  if (plugin.deployment.vectorStoreKey !== plugin.deployment.config.space.id) {
    throw new Error(
      `embedding provider ${plugin.deployment.id} vectorStoreKey must equal its embedding space id`,
    );
  }
  const names = plugin.environment.map((item) => item.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`embedding provider ${plugin.deployment.id} repeats an environment variable`);
  }
  for (const item of plugin.environment) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(item.name)) {
      throw new Error(`embedding provider environment name is invalid: ${item.name}`);
    }
    if (item.secret && item.defaultValue !== undefined) {
      throw new Error(
        `embedding provider ${plugin.deployment.id} secret ${item.name} must not have a default value`,
      );
    }
  }
  return Object.freeze({
    ...plugin,
    environment: Object.freeze(plugin.environment.map((item) => Object.freeze({ ...item }))),
  });
}
