import { describe, expect, test } from "bun:test";
import {
  appOwnedHistoryVectorState,
  historyVectorCloseAction,
  readWorkspaceLocation,
  workspaceHref,
  type WorkspaceLocation,
} from "./location";

const baseLocation = (overrides: Partial<WorkspaceLocation> = {}): WorkspaceLocation => ({
  workspace: "events",
  job: "",
  source: null,
  project: "",
  folder: "",
  view: "stream",
  historyPeriod: "week",
  historyDate: "",
  vectorOperation: "",
  vectorSession: "",
  vectorDate: "",
  vectorSource: "",
  vectorProject: "",
  vectorFolder: "",
  vectorProviders: ["dual-4090"],
  vectorActors: ["human", "agent"],
  vectorView: "3d",
  vectorBreadth: "session",
  ...overrides,
});

describe("workspace URL state", () => {
  test("marks app-opened vector inspector history entries without dropping router state", () => {
    expect(appOwnedHistoryVectorState({ routerIndex: 4 })).toEqual({
      routerIndex: 4,
      lanceglass: "history-vector",
    });
    expect(appOwnedHistoryVectorState(null)).toEqual({
      lanceglass: "history-vector",
    });
  });

  test("closes app-opened vector inspectors with Back but replaces direct links", () => {
    expect(historyVectorCloseAction(appOwnedHistoryVectorState({ routerIndex: 4 }))).toBe("back");
    expect(historyVectorCloseAction(null)).toBe("replace");
    expect(historyVectorCloseAction({ routerIndex: 4 })).toBe("replace");
    expect(historyVectorCloseAction({ lanceglass: "another-entry" })).toBe("replace");
  });

  test("defaults old links to Events without inventing an event source", () => {
    expect(readWorkspaceLocation({ search: "" } as Location)).toEqual({
      workspace: "events",
      job: "",
      source: null,
      project: "",
      folder: "",
      view: "stream",
      historyPeriod: "week",
      historyDate: "",
      vectorOperation: "",
      vectorSession: "",
      vectorDate: "",
      vectorSource: "",
      vectorProject: "",
      vectorFolder: "",
      vectorProviders: ["dual-4090"],
      vectorActors: ["human", "agent"],
      vectorView: "3d",
      vectorBreadth: "session",
    });
  });

  test("round-trips a selected job and the retained event scope", () => {
    const href = workspaceHref("/admin", baseLocation({
      workspace: "jobs",
      job: "job/with spaces",
      source: "claude",
      project: "demo-oracle",
      folder: "/Users/example/.claude/projects/demo",
      view: "visualize",
      historyPeriod: "month",
      historyDate: "2026-08-31",
      vectorOperation: "",
      vectorSession: "",
      vectorDate: "",
      vectorSource: "",
      vectorProject: "",
      vectorFolder: "",
      vectorProviders: ["dual-4090"],
      vectorActors: ["human", "agent"],
      vectorView: "3d",
      vectorBreadth: "session",
    }));
    const url = new URL(href, "http://127.0.0.1");

    expect(url.pathname).toBe("/admin");
    expect(readWorkspaceLocation(url)).toEqual(baseLocation({
      workspace: "jobs",
      job: "job/with spaces",
      source: "claude",
      project: "demo-oracle",
      folder: "/Users/example/.claude/projects/demo",
      view: "visualize",
      historyPeriod: "month",
      historyDate: "2026-08-31",
    }));
  });

  test("round-trips the History workspace, period, date, and filters", () => {
    const href = workspaceHref("/", baseLocation({
      workspace: "history",
      source: "claude",
      project: "sample-oracle",
      folder: "/Users/example/.claude/projects/sample-oracle",
      historyPeriod: "month",
      historyDate: "2026-08-31",
    }));
    const url = new URL(href, "http://127.0.0.1");

    expect(url.search).toBe(
      "?workspace=history&source=claude&project=sample-oracle&folder=%2FUsers%2Fexample%2F.claude%2Fprojects%2Fsample-oracle&view=stream&period=month&date=2026-08-31",
    );
    expect(readWorkspaceLocation(url)).toEqual(baseLocation({
      workspace: "history",
      source: "claude",
      project: "sample-oracle",
      folder: "/Users/example/.claude/projects/sample-oracle",
      historyPeriod: "month",
      historyDate: "2026-08-31",
    }));
  });

  test("round-trips a scoped History vector operation with both providers, actor filters, and 3D view", () => {
    const href = workspaceHref("/", baseLocation({
      workspace: "history",
      vectorOperation: "vectors",
      vectorSession: "session/42",
      vectorDate: "2026-08-31",
      vectorSource: "claude",
      vectorProject: "sample-oracle",
      vectorFolder: "/Users/example/.claude/projects/sample-oracle",
      vectorProviders: ["dual-4090", "cloudflare"],
      vectorActors: ["human"],
      vectorView: "3d",
      vectorBreadth: "session",
    }));
    const url = new URL(href, "http://127.0.0.1");

    expect(readWorkspaceLocation(url)).toEqual(baseLocation({
      workspace: "history",
      vectorOperation: "vectors",
      vectorSession: "session/42",
      vectorDate: "2026-08-31",
      vectorSource: "claude",
      vectorProject: "sample-oracle",
      vectorFolder: "/Users/example/.claude/projects/sample-oracle",
      vectorProviders: ["dual-4090", "cloudflare"],
      vectorActors: ["human"],
      vectorView: "3d",
      vectorBreadth: "session",
    }));
    expect(url.searchParams.getAll("vector_provider")).toEqual(["dual-4090", "cloudflare"]);
    expect(url.searchParams.getAll("vector_actor")).toEqual(["human"]);
    expect(url.searchParams.get("vector_view")).toBe("3d");
  });

  test("keeps legacy single-provider links and normalizes invalid vector controls", () => {
    const location = readWorkspaceLocation({
      search: "?workspace=history&operate=vectors&vector_session=session-1&vector_date=2026-08-31" +
        "&vector_source=claude&vector_project=&vector_folder=%2Farchive%2Fneo" +
        "&vector_provider=cloudflare&vector_provider=unknown&vector_actor=agent&vector_actor=robot&vector_view=space",
    } as Location);

    expect(location.vectorProviders).toEqual(["cloudflare"]);
    expect(location.vectorActors).toEqual(["agent"]);
    expect(location.vectorView).toBe("3d");
    expect(location.vectorOperation).toBe("vectors");
    expect(location.vectorSession).toBe("session-1");
  });

  test("clears a malformed vector operation without losing History filters", () => {
    const location = readWorkspaceLocation({
      search: "?workspace=history&source=claude&project=sample-oracle&period=month&date=2026-08-31" +
        "&operate=vectors&vector_session=session-1&vector_date=not-a-date",
    } as Location);

    expect(location).toEqual(baseLocation({
      workspace: "history",
      source: "claude",
      project: "sample-oracle",
      historyPeriod: "month",
      historyDate: "2026-08-31",
    }));
  });

  test("normalizes invalid workspace, History period, date, and view values", () => {
    const location = readWorkspaceLocation({
      search: "?workspace=unknown&period=year&date=2026-02-30&view=grid&source=claude",
    } as Location);

    expect(location).toEqual(baseLocation({ source: "claude" }));
  });

  for (const date of [
    "2026-8-31",
    "2026-00-01",
    "2026-13-01",
    "2026-04-31",
    "not-a-date",
  ]) {
    test(`rejects invalid History date ${date}`, () => {
      expect(readWorkspaceLocation({ search: `?date=${date}` } as Location).historyDate).toBe("");
    });
  }

  for (const historyPeriod of ["day", "week", "month"] as const) {
    test(`preserves the ${historyPeriod} History period across workspace switches`, () => {
      const retained = baseLocation({
        workspace: "events",
        source: "codex",
        project: "home-oracle",
        folder: "/Users/example/.codex/sessions/2026/08",
        historyPeriod,
        historyDate: "2026-08-30",
      });
      const eventsUrl = new URL(workspaceHref("/", retained), "http://127.0.0.1");
      const jobsUrl = new URL(
        workspaceHref("/", { ...readWorkspaceLocation(eventsUrl), workspace: "jobs", job: "job-42" }),
        "http://127.0.0.1",
      );
      const historyUrl = new URL(
        workspaceHref("/", { ...readWorkspaceLocation(jobsUrl), workspace: "history" }),
        "http://127.0.0.1",
      );

      expect(readWorkspaceLocation(historyUrl)).toEqual({
        ...retained,
        workspace: "history",
        job: "",
      });
      expect(jobsUrl.searchParams.get("job")).toBe("job-42");
      expect(historyUrl.searchParams.has("job")).toBe(false);
    });
  }

  test("uses an explicit sentinel for all sources", () => {
    const href = workspaceHref("/", baseLocation({
      workspace: "events",
      job: "ignored",
      source: "",
    }));
    const url = new URL(href, "http://127.0.0.1");

    expect(url.searchParams.get("source")).toBe("*");
    expect(url.searchParams.has("job")).toBe(false);
    expect(readWorkspaceLocation(url).source).toBe("");
  });

  test("keeps old filtered links backward-compatible", () => {
    expect(readWorkspaceLocation({
      search: "?source=claude&project=sample-oracle&folder=%2Farchive%2Fneo&view=visualize",
    } as Location)).toEqual(baseLocation({
      source: "claude",
      project: "sample-oracle",
      folder: "/archive/neo",
      view: "visualize",
    }));
  });
});
