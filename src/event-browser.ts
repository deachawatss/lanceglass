import { basename, dirname } from "node:path";
import { throwIfAborted } from "./database.plain";
import type { EventRow, EventSourceRow } from "./types";

type Facet = { value: string; count: number };

type EventBrowserEventRepository = {
  latestExact(source?: string, project?: string, limit?: number, eventKeys?: ReadonlySet<string>, signal?: AbortSignal): Promise<{ rows: EventRow[]; total: number }>;
  projectCounts(source?: string, signal?: AbortSignal): Promise<Facet[]>;
  keysForProject(source: string, project: string, signal?: AbortSignal): Promise<Set<string>>;
  count(source?: string): Promise<number>;
};

type EventBrowserOccurrenceRepository = {
  eventKeysInFolder(source: string, folder: string, signal?: AbortSignal): Promise<Set<string>>;
  pathsForEvents(events: readonly Pick<EventRow, "id" | "source">[], signal?: AbortSignal): Promise<EventSourceRow[]>;
  folderCounts(source: string, eventKeys: ReadonlySet<string>, signal?: AbortSignal): Promise<Facet[]>;
  count(source?: string): Promise<number>;
};

export type EventBrowserStore = {
  events(): EventBrowserEventRepository;
  occurrences(): EventBrowserOccurrenceRepository;
};

function eventKey(source: string, eventId: string) {
  return `${source}\0${eventId}`;
}

export async function loadEventPage(
  store: EventBrowserStore,
  source: string,
  project: string,
  folder: string,
  limit: number,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const events = store.events();
  const occurrences = store.occurrences();
  const folderKeys = folder ? await occurrences.eventKeysInFolder(source, folder, signal) : undefined;
  const page = await events.latestExact(source, project, limit, folderKeys, signal);
  const provenance = await occurrences.pathsForEvents(page.rows, signal);
  throwIfAborted(signal);
  const pathsByEvent = new Map<string, string[]>();
  for (const occurrence of provenance) {
    const key = eventKey(occurrence.source, occurrence.event_id);
    const paths = pathsByEvent.get(key) ?? [];
    if (!paths.includes(occurrence.file_path)) paths.push(occurrence.file_path);
    pathsByEvent.set(key, paths);
  }

  return {
    events: page.rows.map((event) => {
      const paths = [...(pathsByEvent.get(eventKey(event.source, event.id)) ?? [])].sort();
      const filePath = paths.find((path) => !folder || dirname(path) === folder) ?? paths[0];
      return filePath ? { ...event, file_path: filePath, folder: dirname(filePath) } : event;
    }),
    source,
    project,
    folder,
    limit,
    total: page.total,
    // Facets are loaded separately so the first visible rows are never held
    // behind multi-million-row project/folder aggregation.
    facets: { projects: [], folders: [] },
  };
}

async function calculateEventFacets(store: EventBrowserStore, source: string, project: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const projects = await store.events().projectCounts(source, signal);
  const folders = project
    ? (await store.occurrences().folderCounts(
      source,
      await store.events().keysForProject(source, project, signal),
      signal,
    )).map((facet) => ({ ...facet, label: basename(facet.value) }))
    : [];
  throwIfAborted(signal);
  return { source, project, facets: { projects, folders } };
}

type FacetResponse = Awaited<ReturnType<typeof calculateEventFacets>>;
const facetCache = new Map<string, { revision: string; value: FacetResponse }>();

export async function loadEventFacets(
  store: EventBrowserStore,
  source: string,
  project: string,
  cacheNamespace = "",
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  if (!cacheNamespace) return calculateEventFacets(store, source, project, signal);
  const [eventCount, occurrenceCount] = await Promise.all([
    store.events().count(source),
    store.occurrences().count(source),
  ]);
  throwIfAborted(signal);
  const revision = `${eventCount}:${occurrenceCount}`;
  const cacheKey = `${cacheNamespace}\0${source}\0${project}`;
  const cached = facetCache.get(cacheKey);
  if (cached?.revision === revision) return cached.value;
  const value = await calculateEventFacets(store, source, project, signal);
  facetCache.set(cacheKey, { revision, value });
  return value;
}
