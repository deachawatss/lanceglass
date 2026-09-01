import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAB = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function readProcess(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("embedding CLI surface", () => {
  test("embed help is side-effect free", async () => {
    const root = await mkdtemp(join(tmpdir(), "jscan-embed-help-"));
    temporaryDirectories.push(root);
    const plainDirectory = join(root, "plain");
    const vectorDirectory = join(root, "vector");
    const result = await readProcess(Bun.spawn(["bun", "src/cli.ts", "embed", "-h"], {
      cwd: LAB,
      env: {
        ...process.env,
        PLAIN_DB_DIR: plainDirectory,
        VECTOR_DB_DIR: vectorDirectory,
      },
      stdout: "pipe",
      stderr: "pipe",
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("embed providers");
    expect(result.stdout).toContain("embed probe");
    expect(result.stdout).toContain("embed run");
    expect(await stat(plainDirectory).catch(() => null)).toBeNull();
    expect(await stat(vectorDirectory).catch(() => null)).toBeNull();
  });

  test("lists provider readiness without printing credential values", async () => {
    const result = await readProcess(Bun.spawn([
      "bun",
      "src/cli.ts",
      "embed",
      "providers",
    ], {
      cwd: LAB,
      env: {
        ...process.env,
        DUAL_4090_OLLAMA_URLS: "http://gpu1.test,http://gpu2.test",
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_API_TOKEN: "do-not-print-this-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.plugin_api_version).toBe(1);
    expect(output.deployments.map((item: { id: string }) => item.id)).toEqual([
      "m5-ollama",
      "dual-4090",
      "cloudflare",
    ]);
    expect(output.deployments.every((item: { configured: boolean }) => item.configured)).toBe(true);
    expect(result.stdout).not.toContain("do-not-print-this-token");
    expect(result.stdout).not.toContain("http://gpu1.test");
  });
});
