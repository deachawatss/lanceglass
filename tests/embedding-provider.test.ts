import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACTIVE_EMBEDDING_SPACE,
  CLOUDFLARE_EMBEDDING_SPACE,
  CLOUDFLARE_REVISION_PROBE_TEXT,
  EMBEDDING_DEPLOYMENTS,
  OllamaPoolEmbeddingProvider,
  defineEmbeddingDeployment,
  defineEmbeddingSpace,
  sameEmbeddingSpace,
  wrapEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
} from "../src/embedding-provider";
import {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
  createEmbeddingProviderRegistry,
  defineEmbeddingProviderPlugin,
  embeddingProviderRegistry,
} from "../src/embedding-plugins";
import { CloudflareWorkersAIProvider } from "../src/embedding-providers/cloudflare";

function float32Fingerprint(vector: number[]) {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return createHash("sha256").update(bytes).digest("hex");
}

describe("embedding provider contract", () => {
  test("describes the current Ollama model as one complete embedding space", () => {
    expect(ACTIVE_EMBEDDING_SPACE).toEqual({
      id: "ollama-bge-m3-790764642607-1024-cosine-text-v1",
      provider: "ollama",
      model: "bge-m3",
      revision: "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab",
      dimension: 1_024,
      distance: "cosine",
      textPolicy: "event.text.slice(0,2000)@v1",
    });
    expect(Object.isFrozen(ACTIVE_EMBEDDING_SPACE)).toBe(true);
  });

  test("does not equate providers merely because model and dimension match", () => {
    const remote = defineEmbeddingSpace({
      ...ACTIVE_EMBEDDING_SPACE,
      id: "cloudflare-bge-m3-1024-cosine-text-v1",
      provider: "cloudflare-workers-ai",
      revision: "cloudflare-managed",
    });

    expect(sameEmbeddingSpace(ACTIVE_EMBEDDING_SPACE, remote)).toBe(false);
  });

  test("prepares external configuration with credential environment names", () => {
    const configs: EmbeddingProviderConfig[] = [
      {
        kind: "openai-compatible",
        endpoint: {
          baseUrlEnv: "DUAL_4090_EMBEDDING_URL",
          apiKeyEnv: "DUAL_4090_EMBEDDING_API_KEY",
        },
        space: defineEmbeddingSpace({
          id: "gpu2-bge-m3-1024-cosine-text-v1",
          provider: "openai-compatible",
          model: "bge-m3",
          revision: "pinned-container-digest",
          dimension: 1_024,
          distance: "cosine",
          textPolicy: "event.text.slice(0,2000)@v1",
        }),
      },
      {
        kind: "cloudflare-workers-ai",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_API_TOKEN",
        space: defineEmbeddingSpace({
          id: "cloudflare-bge-m3-1024-cosine-text-v1",
          provider: "cloudflare-workers-ai",
          model: "@cf/baai/bge-m3",
          revision: "cloudflare-managed",
          dimension: 1_024,
          distance: "cosine",
          textPolicy: "event.text.slice(0,2000)@v1",
        }),
      },
    ];

    expect(configs.map((config) => config.kind)).toEqual([
      "openai-compatible",
      "cloudflare-workers-ai",
    ]);
  });

  test("publishes three deployment descriptors without credentials", () => {
    expect(Object.keys(EMBEDDING_DEPLOYMENTS)).toEqual([
      "m5-ollama",
      "dual-4090",
      "cloudflare",
    ]);

    expect(EMBEDDING_DEPLOYMENTS["m5-ollama"]).toMatchObject({
      location: "local",
      hardware: "apple-m5",
      config: {
        kind: "ollama",
        endpoint: {
          baseUrlEnv: "M5_OLLAMA_URL",
          defaultBaseUrl: "http://127.0.0.1:11434",
        },
      },
    });
    expect(EMBEDDING_DEPLOYMENTS["dual-4090"]).toMatchObject({
      location: "lan",
      hardware: "2x-nvidia-rtx-4090",
      config: {
        kind: "ollama-pool",
        baseUrlsEnv: "DUAL_4090_OLLAMA_URLS",
      },
    });
    expect(EMBEDDING_DEPLOYMENTS.cloudflare).toMatchObject({
      location: "cloud",
      hardware: "cloudflare-managed",
      config: {
        kind: "cloudflare-workers-ai",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_API_TOKEN",
      },
    });

    const deployments = Object.values(EMBEDDING_DEPLOYMENTS);
    expect(new Set(deployments.map((item) => item.vectorStoreKey)).size).toBe(2);
    expect(EMBEDDING_DEPLOYMENTS["dual-4090"].vectorStoreKey)
      .toBe(EMBEDDING_DEPLOYMENTS["m5-ollama"].vectorStoreKey);
    expect(EMBEDDING_DEPLOYMENTS.cloudflare.vectorStoreKey)
      .not.toBe(EMBEDDING_DEPLOYMENTS["m5-ollama"].vectorStoreKey);
    for (const deployment of deployments) {
      expect(deployment.vectorStoreKey).toBe(deployment.config.space.id);
      expect(Object.isFrozen(deployment)).toBe(true);
      expect(JSON.stringify(deployment)).not.toContain("api-key-value");
    }
  });

  test("balances Ollama batches across endpoints and fails over behind one interface", async () => {
    const hits = [0, 0];
    const server = (index: number, seed: number) => Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/tags") {
          return Response.json({
            models: [{
              name: "bge-m3:latest",
              digest: ACTIVE_EMBEDDING_SPACE.revision,
            }],
          });
        }
        hits[index]++;
        const body = await request.json() as { input: string[] };
        return Response.json({ embeddings: body.input.map(() => [seed]) });
      },
    });
    const first = server(0, 1);
    const second = server(1, 2);

    try {
      const provider: EmbeddingProvider = new OllamaPoolEmbeddingProvider({
        urls: [first.url.toString(), second.url.toString()],
        timeoutMs: 1_000,
      });
      expect(await provider.embed(["first"])).toEqual([[1]]);
      expect(await provider.embed(["second"])).toEqual([[2]]);
      await first.stop(true);
      expect(await provider.embed(["fail over"])).toEqual([[2]]);
      expect(hits).toEqual([1, 2]);
    } finally {
      await first.stop(true);
      await second.stop(true);
    }
  });

  test("embeds one large batch concurrently across every Ollama endpoint", async () => {
    let active = 0;
    let maxActive = 0;
    const received: string[][] = [[], []];
    const server = (index: number) => Bun.serve({
      port: 0,
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: ACTIVE_EMBEDDING_SPACE.revision }],
          });
        }
        const body = await request.json() as { input: string[] };
        received[index] = body.input;
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(120);
        active--;
        return Response.json({
          embeddings: body.input.map((text) => [Number(text.slice(1))]),
        });
      },
    });
    const first = server(0);
    const second = server(1);

    try {
      const provider = new OllamaPoolEmbeddingProvider({
        urls: [first.url.toString(), second.url.toString()],
        timeoutMs: 1_000,
      });
      const startedAt = performance.now();
      const vectors = await provider.embed(["t0", "t1", "t2", "t3"]);
      const elapsedMs = performance.now() - startedAt;

      expect(vectors).toEqual([[0], [1], [2], [3]]);
      expect(received).toEqual([["t0", "t1"], ["t2", "t3"]]);
      expect(maxActive).toBe(2);
      expect(elapsedMs).toBeLessThan(220);
    } finally {
      await first.stop(true);
      await second.stop(true);
    }
  });

  test("fails over one concurrent shard and preserves original vector order", async () => {
    const received: string[][] = [];
    const failing = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: ACTIVE_EMBEDDING_SPACE.revision }],
          });
        }
        const body = await request.json() as { input: string[] };
        received.push(body.input);
        return new Response("gpu unavailable", { status: 503 });
      },
    });
    const healthy = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: ACTIVE_EMBEDDING_SPACE.revision }],
          });
        }
        const body = await request.json() as { input: string[] };
        received.push(body.input);
        return Response.json({
          embeddings: body.input.map((text) => [Number(text.slice(1))]),
        });
      },
    });

    try {
      const provider = new OllamaPoolEmbeddingProvider({
        urls: [failing.url.toString(), healthy.url.toString()],
        timeoutMs: 1_000,
      });
      expect(await provider.embed(["t0", "t1", "t2", "t3", "t4"])).toEqual([
        [0],
        [1],
        [2],
        [3],
        [4],
      ]);
      expect(received).toContainEqual(["t0", "t1", "t2"]);
      expect(received).toContainEqual(["t3", "t4"]);
      expect(received.filter((batch) => batch.join(",") === "t0,t1,t2")).toHaveLength(2);
    } finally {
      await failing.stop(true);
      await healthy.stop(true);
    }
  });

  test("refuses a mismatched Ollama revision and fails over before embedding", async () => {
    let badEmbedRequests = 0;
    const bad = Bun.serve({
      port: 0,
      fetch(request: Request) {
        if (new URL(request.url).pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: "different-model-digest" }],
          });
        }
        badEmbedRequests++;
        return Response.json({ embeddings: [[1]] });
      },
    });
    const good = Bun.serve({
      port: 0,
      fetch(request: Request) {
        if (new URL(request.url).pathname === "/api/tags") {
          return Response.json({
            models: [{ name: "bge-m3:latest", digest: ACTIVE_EMBEDDING_SPACE.revision }],
          });
        }
        return Response.json({ embeddings: [[2]] });
      },
    });

    try {
      const provider = new OllamaPoolEmbeddingProvider({
        urls: [bad.url.toString(), good.url.toString()],
        timeoutMs: 1_000,
      });
      expect(await provider.embed(["compatible space only"])).toEqual([[2]]);
      expect(badEmbedRequests).toBe(0);
    } finally {
      await bad.stop(true);
      await good.stop(true);
    }
  });

  test("wraps an incompatible response shape behind the one provider interface", async () => {
    const wrapped: EmbeddingProvider = wrapEmbeddingProvider({
      space: CLOUDFLARE_EMBEDDING_SPACE,
      request: async (texts) => ({
        result: {
          data: texts.map((_, index) => Array(1_024).fill(index + 1)),
        },
      }),
      toVectors: (response) => {
        const body = response as { result: { data: number[][] } };
        return body.result.data;
      },
    });

    const vectors = await wrapped.embed(["one", "two"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1_024);
    expect(vectors[1]?.[0]).toBe(2);
  });

  test("calls Cloudflare Workers AI through the canonical provider interface", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const probeVector = Array(1_024).fill(0);
    probeVector[0] = 1;
    const testSpace = defineEmbeddingSpace({
      id: "cloudflare-test-model-r1-1024-cosine-text-v1",
      provider: "cloudflare-workers-ai",
      model: "@cf/test/model",
      revision: `probe-f32-sha256:${float32Fingerprint(probeVector)}`,
      dimension: 1_024,
      distance: "cosine",
      textPolicy: "event.text.slice(0,2000)@v1",
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        const body = await request.json() as { text: string[] };
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        const isProbe = body.text.length === 1 &&
          body.text[0] === CLOUDFLARE_REVISION_PROBE_TEXT;
        return Response.json({
          success: true,
          result: {
            shape: [body.text.length, 1_024],
            data: isProbe
              ? [probeVector]
              : body.text.map((_, index) => Array(1_024).fill(index + 1)),
          },
        });
      },
    });

    try {
      const provider: EmbeddingProvider = new CloudflareWorkersAIProvider({
        accountId: "account-1",
        apiToken: "secret-token",
        apiBaseUrl: server.url.toString(),
        timeoutMs: 1_000,
        space: testSpace,
      });
      const vectors = await provider.embed(["one", "two"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(1_024);
      expect(requests).toEqual([
        {
          path: "/accounts/account-1/ai/run/@cf/test/model",
          authorization: "Bearer secret-token",
          body: { text: [CLOUDFLARE_REVISION_PROBE_TEXT] },
        },
        {
          path: "/accounts/account-1/ai/run/@cf/test/model",
          authorization: "Bearer secret-token",
          body: { text: ["one", "two"] },
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("reports Cloudflare failures without exposing credentials", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        success: false,
        errors: [{ code: 10_000, message: "denied Bearer do-not-leak" }],
        debug: "do-not-leak",
      }, {
        status: 401,
      }),
    });
    try {
      const provider = new CloudflareWorkersAIProvider({
        accountId: "account-1",
        apiToken: "do-not-leak",
        apiBaseUrl: server.url.toString(),
        timeoutMs: 1_000,
      });
      let message = "";
      try {
        await provider.embed(["one"]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Cloudflare Workers AI failed (401)");
      expect(message).toContain("[10000] denied Bearer [REDACTED]");
      expect(message).not.toContain("do-not-leak");
    } finally {
      await server.stop(true);
    }
  });

  test("refuses a changed managed Cloudflare model before returning user vectors", async () => {
    let receivedTexts: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request: Request) {
        receivedTexts = (await request.json() as { text: string[] }).text;
        return Response.json({
          success: true,
          result: {
            shape: [receivedTexts.length, 1_024],
            data: receivedTexts.map(() => Array(1_024).fill(1)),
          },
        });
      },
    });
    try {
      const provider = new CloudflareWorkersAIProvider({
        accountId: "account-1",
        apiToken: "secret-token",
        apiBaseUrl: server.url.toString(),
        timeoutMs: 1_000,
      });
      await expect(provider.embed(["user text"])).rejects.toThrow(
        "Cloudflare Workers AI model fingerprint mismatch",
      );
      expect(receivedTexts).toEqual([CLOUDFLARE_REVISION_PROBE_TEXT]);
    } finally {
      await server.stop(true);
    }
  });

  test("registers provider plugins without exposing credential values", () => {
    const descriptions = embeddingProviderRegistry.describe({
      CLOUDFLARE_ACCOUNT_ID: "account-1",
      CLOUDFLARE_API_TOKEN: "secret-token",
    });
    expect(descriptions.map((item) => item.id)).toEqual([
      "m5-ollama",
      "dual-4090",
      "cloudflare",
    ]);
    expect(descriptions.find((item) => item.id === "cloudflare")).toMatchObject({
      configured: true,
      provider: "cloudflare-workers-ai",
      dimension: 1_024,
      missing_environment: [],
    });
    expect(descriptions.find((item) => item.id === "dual-4090")).toMatchObject({
      configured: false,
      missing_environment: ["DUAL_4090_OLLAMA_URLS"],
    });
    expect(JSON.stringify(descriptions)).not.toContain("secret-token");
    expect(embeddingProviderRegistry.create("cloudflare", {
      CLOUDFLARE_ACCOUNT_ID: "account-1",
      CLOUDFLARE_API_TOKEN: "secret-token",
    })).toBeInstanceOf(CloudflareWorkersAIProvider);
  });

  test("rejects duplicate source plugins and missing plugin configuration", () => {
    const plugin = defineEmbeddingProviderPlugin({
      apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
      deployment: EMBEDDING_DEPLOYMENTS["dual-4090"],
      environment: [{
        name: "CUSTOM_URL",
        required: true,
        description: "Required test endpoint.",
      }],
      create: () => ({
        space: ACTIVE_EMBEDDING_SPACE,
        embed: async () => [],
      }),
    });
    expect(() => createEmbeddingProviderRegistry([plugin, plugin])).toThrow(
      "duplicate embedding provider plugin",
    );
    const registry = createEmbeddingProviderRegistry([plugin]);
    expect(() => registry.create("dual-4090", {})).toThrow(
      "missing environment: CUSTOM_URL",
    );
    expect(() => registry.create("missing", {})).toThrow("unknown embedding deployment");
  });

  test("rejects provider factories that return a different embedding space", () => {
    const plugin = defineEmbeddingProviderPlugin({
      apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
      deployment: EMBEDDING_DEPLOYMENTS["m5-ollama"],
      environment: [],
      create: () => ({
        space: CLOUDFLARE_EMBEDDING_SPACE,
        embed: async () => [],
      }),
    });
    expect(() => createEmbeddingProviderRegistry([plugin]).create("m5-ollama", {}))
      .toThrow("returned a space that differs from its deployment contract");
  });

  test("rejects one vector store key mapped to incompatible spaces", () => {
    const incompatible = defineEmbeddingSpace({
      ...ACTIVE_EMBEDDING_SPACE,
      provider: "community-native",
    });
    const plugins = [ACTIVE_EMBEDDING_SPACE, incompatible].map((space, index) =>
      defineEmbeddingProviderPlugin({
        apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
        deployment: defineEmbeddingDeployment({
          id: `collision-${index}`,
          label: `Collision ${index}`,
          location: "local",
          hardware: "test",
          config: { kind: `test-${index}`, space },
        }),
        environment: [],
        create: () => ({ space, embed: async () => [] }),
      })
    );
    expect(() => createEmbeddingProviderRegistry(plugins))
      .toThrow("maps to incompatible spaces");
  });

  test("rejects secret defaults and returns copied public environment metadata", () => {
    expect(() => defineEmbeddingProviderPlugin({
      apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
      deployment: EMBEDDING_DEPLOYMENTS.cloudflare,
      environment: [{
        name: "BAD_SECRET",
        required: false,
        secret: true,
        defaultValue: "must-not-publish",
        description: "Invalid secret default.",
      }],
      create: () => ({ space: CLOUDFLARE_EMBEDDING_SPACE, embed: async () => [] }),
    })).toThrow("secret BAD_SECRET must not have a default value");

    const description = embeddingProviderRegistry.describe({})
      .find((item) => item.id === "cloudflare")!;
    expect(description.environment).not.toBe(
      embeddingProviderRegistry.get("cloudflare").environment,
    );
    expect(JSON.stringify(description.environment)).not.toContain("must-not-publish");
  });

  test("accepts a contributor-defined deployment without changing core unions", async () => {
    const space = defineEmbeddingSpace({
      id: "contributor-model-r1-3-cosine-text-v1",
      provider: "community-native",
      model: "contributor/model",
      revision: "r1",
      dimension: 3,
      distance: "cosine",
      textPolicy: "event.text.slice(0,2000)@v1",
    });
    const plugin = defineEmbeddingProviderPlugin({
      apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
      deployment: defineEmbeddingDeployment({
        id: "contributor-http",
        label: "Contributor HTTP provider",
        location: "lan",
        hardware: "community-defined",
        config: { kind: "contributor-http", endpointEnv: "CONTRIBUTOR_URL", space },
      }),
      environment: [{
        name: "CONTRIBUTOR_URL",
        required: true,
        description: "Contributor endpoint.",
      }],
      create: () => ({ space, embed: async (texts) => texts.map(() => [1, 0, 0]) }),
    });
    const registry = createEmbeddingProviderRegistry([plugin]);
    const provider = registry.create("contributor-http", {
      CONTRIBUTOR_URL: "http://provider.test",
    });

    expect(registry.describe({ CONTRIBUTOR_URL: "http://provider.test" })).toEqual([
      expect.objectContaining({
        id: "contributor-http",
        provider: "community-native",
        configured: true,
        vector_store_key: space.id,
      }),
    ]);
    expect(await provider.embed(["one", "two"])).toEqual([[1, 0, 0], [1, 0, 0]]);
  });

  test("rejects ambiguous embedding-space identity", () => {
    expect(() => defineEmbeddingSpace({
      ...ACTIVE_EMBEDDING_SPACE,
      revision: "",
    })).toThrow("embedding space revision must not be empty");
    expect(() => defineEmbeddingSpace({
      ...ACTIVE_EMBEDDING_SPACE,
      dimension: 0,
    })).toThrow("embedding space dimension must be a positive integer");
    expect(() => defineEmbeddingSpace({
      ...ACTIVE_EMBEDDING_SPACE,
      id: "unsafe/path",
    })).toThrow("embedding space id must use only");
  });
});
