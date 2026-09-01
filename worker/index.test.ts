import { describe, expect, test } from "bun:test";
import { demoWorker } from "./index";

const env = {
  ASSETS: {
    async fetch(request: Request) {
      return new Response(`asset:${new URL(request.url).pathname}`);
    },
  },
};

async function api(path: string, init?: RequestInit) {
  return demoWorker.fetch(new Request(`https://demo.example${path}`, init), env);
}

describe("static Cloudflare demo", () => {
  test("declares its no-storage boundary", async () => {
    const health = await (await api("/health")).json();
    const statusResponse = await api("/api/status");
    const status = await statusResponse.json();
    expect(health).toMatchObject({ mode: "static-fixture", storage: "none" });
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    expect(status.demo).toEqual({
      enabled: true,
      label: "Static fixture demo",
      storage: "none",
      persistence: "none",
    });
  });

  test("serves the real SPA through the asset binding", async () => {
    expect(await (await api("/admin")).text()).toBe("asset:/admin");
  });

  test("covers event, history, plan, vector, and job contracts", async () => {
    const paths = [
      "/api/events?source=claude&limit=3",
      "/api/events/facets?source=claude",
      "/api/import/intake?source=claude",
      "/api/import/plan?source=claude&plan_state=actionable",
      "/api/history?period=week&date=2026-09-01",
      "/api/jobs",
      "/api/jobs/static-demo-import/log?from=0",
    ];
    for (const path of paths) expect((await api(path)).status).toBe(200);

    const history = await (await api(paths[4]!)).json();
    expect(history.days).toHaveLength(2);
    expect(history.totals.events).toBeGreaterThan(0);

    const plan = await (await api(paths[3]!)).json();
    expect(plan.files).toHaveLength(plan.will_parse);
  });

  test("simulates import deterministically without persistence", async () => {
    const response = await api("/api/jobs/import", { method: "POST", body: "{}" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true, id: "static-demo-import", demo: true });
  });
});
