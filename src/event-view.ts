import { basename, dirname } from "node:path";
import type { EventRow, EventSourceRow } from "./types";

function eventKey(source: string, eventId: string) {
  return `${source}\0${eventId}`;
}

export function buildEventView(
  sourceEvents: EventRow[],
  occurrences: EventSourceRow[],
  source: string,
  project: string,
  folder: string,
  limit: number,
) {
  const eventKeys = new Set(sourceEvents.map((event) => eventKey(event.source, event.id)));
  const projectEventKeys = new Set(
    sourceEvents
      .filter((event) => !project || event.project === project)
      .map((event) => eventKey(event.source, event.id)),
  );
  const pathsByEvent = new Map<string, string[]>();
  const folderEvents = new Map<string, Set<string>>();
  const projectCounts = new Map<string, number>();

  for (const event of sourceEvents) {
    projectCounts.set(event.project, (projectCounts.get(event.project) ?? 0) + 1);
  }

  for (const occurrence of occurrences) {
    const key = eventKey(occurrence.source, occurrence.event_id);
    if (!eventKeys.has(key)) continue;

    const paths = pathsByEvent.get(key) ?? [];
    if (!paths.includes(occurrence.file_path)) paths.push(occurrence.file_path);
    pathsByEvent.set(key, paths);

    // Folder choices describe the currently selected project. Project choices
    // intentionally remain scoped only by source so users can switch projects.
    if (!projectEventKeys.has(key)) continue;
    const parent = dirname(occurrence.file_path);
    const keys = folderEvents.get(parent) ?? new Set<string>();
    keys.add(key);
    folderEvents.set(parent, keys);
  }

  const projects = [...projectCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
  const folders = [...folderEvents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, keys]) => ({ value, label: basename(value), count: keys.size }));

  const filtered = sourceEvents
    .filter((event) => !project || event.project === project)
    .filter((event) => {
      if (!folder) return true;
      return pathsByEvent
        .get(eventKey(event.source, event.id))
        ?.some((path) => dirname(path) === folder);
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  return {
    events: filtered.slice(0, limit).map((event) => {
      const paths = [...(pathsByEvent.get(eventKey(event.source, event.id)) ?? [])].sort();
      const filePath = paths.find((path) => !folder || dirname(path) === folder) ?? paths[0];
      return filePath
        ? { ...event, file_path: filePath, folder: dirname(filePath) }
        : event;
    }),
    source,
    project,
    folder,
    limit,
    total: filtered.length,
    facets: { projects, folders },
  };
}
