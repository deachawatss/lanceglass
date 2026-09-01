import { createHash } from "node:crypto";
import {
  CLOUDFLARE_EMBEDDING_SPACE,
  CLOUDFLARE_REVISION_PROBE_TEXT,
  EmbeddingValidationError,
  defineEmbeddingSpace,
  type EmbeddingProvider,
  type EmbeddingSpace,
} from "../embedding-provider";

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const REVISION_PREFIX = "probe-f32-sha256:";

export type CloudflareWorkersAIProviderOptions = {
  accountId?: string;
  apiToken?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof globalThis.fetch;
  /** Custom Cloudflare models must declare and verify their own isolated space. */
  space?: EmbeddingSpace;
};

function required(value: string | undefined, environmentName: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${environmentName} is required for Cloudflare Workers AI`);
  return normalized;
}

function float32Fingerprint(vector: number[]) {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return createHash("sha256").update(bytes).digest("hex");
}

function vectorsFromResponse(response: unknown, expectedCount: number) {
  const body = response as {
    success?: unknown;
    result?: { data?: unknown; shape?: unknown };
  };
  if (body.success !== true || !Array.isArray(body.result?.data)) {
    throw new EmbeddingValidationError("Cloudflare Workers AI returned no embedding data");
  }
  if (body.result.data.length !== expectedCount) {
    throw new EmbeddingValidationError(
      `Cloudflare Workers AI response count mismatch: expected ${expectedCount}, got ${body.result.data.length}`,
    );
  }
  return body.result.data as number[][];
}

function verifyRevisionProbe(vector: number[], space: EmbeddingSpace) {
  if (vector.length !== space.dimension) {
    throw new EmbeddingValidationError(
      `Cloudflare Workers AI revision probe has dimension ${vector.length}; expected ${space.dimension}`,
    );
  }
  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new EmbeddingValidationError(
      "Cloudflare Workers AI revision probe contains a non-finite value",
    );
  }
  const expected = space.revision.startsWith(REVISION_PREFIX)
    ? space.revision.slice(REVISION_PREFIX.length)
    : "";
  const actual = float32Fingerprint(vector);
  if (!expected || actual !== expected) {
    throw new EmbeddingValidationError(
      `Cloudflare Workers AI model fingerprint mismatch: expected ${expected || "a pinned fingerprint"}, got ${actual}`,
    );
  }
}

function redactRemoteMessage(message: string, apiToken: string) {
  return message
    .split(apiToken).join("[REDACTED]")
    .replace(/Bearer\s+[^\s,;"'}]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

async function cloudflareErrorDetail(response: Response, apiToken: string) {
  const body = await response.json().catch(() => undefined) as {
    errors?: Array<{ code?: unknown; message?: unknown }>;
  } | undefined;
  const approved = Array.isArray(body?.errors)
    ? body.errors.slice(0, 3).flatMap((error) => {
      if (typeof error?.message !== "string") return [];
      const code = typeof error.code === "number" || typeof error.code === "string"
        ? `[${String(error.code)}] `
        : "";
      return [`${code}${error.message}`];
    })
    : [];
  const detail = approved.join("; ") || response.statusText.trim() || "request rejected";
  return redactRemoteMessage(detail, apiToken);
}

/**
 * Cloudflare Workers AI native REST adapter.
 *
 * A deterministic single-text probe runs before the first user batch. Workers
 * AI exposes no model digest, so the adapter refuses to write into the pinned
 * vector space if the managed model output changes.
 */
export class CloudflareWorkersAIProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpace;
  readonly accountId: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  readonly #apiToken: string;
  readonly #fetcher: typeof globalThis.fetch;
  #verification: Promise<void> | undefined;

  constructor(options: CloudflareWorkersAIProviderOptions = {}) {
    this.space = defineEmbeddingSpace(options.space ?? CLOUDFLARE_EMBEDDING_SPACE);
    if (this.space.provider !== "cloudflare-workers-ai") {
      throw new Error("Cloudflare Workers AI space provider must be cloudflare-workers-ai");
    }
    if (!this.space.revision.startsWith(REVISION_PREFIX)) {
      throw new Error(
        `Cloudflare Workers AI space ${this.space.id} must use a pinned ${REVISION_PREFIX} revision`,
      );
    }
    this.accountId = required(
      options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
      "CLOUDFLARE_ACCOUNT_ID",
    );
    this.#apiToken = required(
      options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN,
      "CLOUDFLARE_API_TOKEN",
    );
    this.apiBaseUrl = (
      options.apiBaseUrl ?? process.env.CLOUDFLARE_AI_BASE_URL ?? DEFAULT_API_BASE_URL
    ).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetcher = options.fetcher ?? globalThis.fetch;
  }

  async #request(texts: string[]) {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.space.model}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const detail = await cloudflareErrorDetail(response, this.#apiToken);
      throw new Error(`Cloudflare Workers AI failed (${response.status}): ${detail}`);
    }
    return vectorsFromResponse(await response.json(), texts.length);
  }

  async #ensureRevision() {
    this.#verification ??= this.#request([CLOUDFLARE_REVISION_PROBE_TEXT])
      .then((vectors) => verifyRevisionProbe(vectors[0]!, this.space));
    try {
      await this.#verification;
    } catch (error) {
      this.#verification = undefined;
      throw error;
    }
  }

  async embed(texts: string[]) {
    if (!texts.length) return [];
    await this.#ensureRevision();
    return this.#request(texts);
  }
}
