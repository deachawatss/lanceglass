import { dirname } from "node:path";
import type { EventRow, EventSourceRow } from "./types";

export const HISTORY_TIME_ZONE = "Asia/Bangkok";
export const HISTORY_PERIODS = ["day", "week", "month"] as const;
export const UNKNOWN_PROVENANCE_FOLDER = "[unknown provenance]";

export type HistoryPeriod = typeof HISTORY_PERIODS[number];

export type HistoryFilters = {
  source: string;
  project: string;
  folder: string;
};

export type HistorySessionSummary = {
  session_id: string;
  source: string;
  project: string;
  folder: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  preview: string;
  continues_before: boolean;
  continues_after: boolean;
};

export type HistoryGroup = {
  source: string;
  project: string;
  folder: string;
  event_count: number;
  session_count: number;
  sessions: HistorySessionSummary[];
};

export type HistoryDay = {
  date: string;
  event_count: number;
  session_count: number;
  groups: HistoryGroup[];
};

export type HistoryResponse = {
  time_zone: typeof HISTORY_TIME_ZONE;
  period: HistoryPeriod;
  date: string;
  anchor: string;
  start: string;
  end: string;
  source: string;
  project: string;
  folder: string;
  totals: {
    days: number;
    active_days: number;
    events: number;
    sessions: number;
    sources: number;
    projects: number;
    folders: number;
  };
  days: HistoryDay[];
};

export type HistorySessionEvent = Pick<
  EventRow,
  "id" | "timestamp" | "block_index" | "block_type" | "semantic_role" | "tool_name" | "text"
>;

export type HistorySessionResponse = {
  time_zone: typeof HISTORY_TIME_ZONE;
  date: string;
  source: string;
  project: string;
  folder: string;
  session_id: string;
  offset: number;
  limit: number;
  total: number;
  selected_day_events: number;
  next_offset: number | null;
  events: HistorySessionEvent[];
};

export class HistoryInputError extends Error {}

type EnrichedEvent = EventRow & { folder: string };

type HistoryOptions = HistoryFilters & {
  period: HistoryPeriod;
  date: string;
  today?: string;
  sessionSpans?: Map<string, { first: string; last: string }>;
};

type HistorySessionOptions = HistoryFilters & {
  date: string;
  session_id: string;
  offset: number;
  limit: number;
};

const bangkokDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HISTORY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function bangkokDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = bangkokDateFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function todayInBangkok(now = new Date()) {
  return bangkokDateKey(now)!;
}

export function parseHistoryPeriod(value: string): HistoryPeriod {
  if ((HISTORY_PERIODS as readonly string[]).includes(value)) return value as HistoryPeriod;
  throw new HistoryInputError("period must be day, week, or month");
}

export function parseDateKey(value: string, name = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HistoryInputError(`${name} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new HistoryInputError(`${name} is not a valid calendar date`);
  }
  return value;
}

function dateFromKey(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number) {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

function monthEnd(value: string) {
  const date = dateFromKey(value);
  return dateKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

export function historyWindow(period: HistoryPeriod, date: string, today = todayInBangkok()) {
  parseDateKey(date);
  parseDateKey(today, "today");
  if (date > today) throw new HistoryInputError("date must not be in the future");

  if (period === "day") return { start: date, end: date };

  if (period === "week") {
    const weekday = dateFromKey(date).getUTCDay();
    const start = shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
    const naturalEnd = shiftDate(start, 6);
    return { start, end: today >= start && today <= naturalEnd ? today : naturalEnd };
  }

  const start = `${date.slice(0, 7)}-01`;
  const naturalEnd = monthEnd(date);
  return { start, end: today >= start && today <= naturalEnd ? today : naturalEnd };
}

function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function chooseFolders(
  events: EventRow[],
  occurrences: EventSourceRow[],
  folderFilter: string,
) {
  const eventIds = new Set(events.map((event) => `${event.source}\0${event.id}`));
  const foldersByEvent = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.source}\0${occurrence.event_id}`;
    if (!eventIds.has(key)) continue;
    const folders = foldersByEvent.get(key) ?? new Set<string>();
    folders.add(dirname(occurrence.file_path));
    foldersByEvent.set(key, folders);
  }

  const enriched: EnrichedEvent[] = [];
  for (const event of events) {
    const observedFolders = [...(foldersByEvent.get(`${event.source}\0${event.id}`) ?? [])].sort();
    const folders = observedFolders.length > 0
      ? observedFolders
      : [UNKNOWN_PROVENANCE_FOLDER];
    const selectedFolders = folderFilter
      ? folders.filter((candidate) => candidate === folderFilter)
      : folders;
    for (const folder of selectedFolders) enriched.push({ ...event, folder });
  }
  return enriched;
}

function filteredEvents(
  events: EventRow[],
  occurrences: EventSourceRow[],
  filters: HistoryFilters,
) {
  return chooseFolders(
    events
      .filter((event) => !filters.source || event.source === filters.source)
      .filter((event) => !filters.project || event.project === filters.project),
    occurrences,
    filters.folder,
  );
}

function eventOrder(left: EventRow, right: EventRow) {
  return left.timestamp.localeCompare(right.timestamp)
    || left.block_index - right.block_index
    || left.id.localeCompare(right.id);
}

function canonicalSessionIdentity(event: EnrichedEvent) {
  // A session can contain a summary with no cwd/project even when its other
  // blocks have one. Session identity is source-scoped; project/folder remain
  // part of scoped grouping below.
  return `${event.source}\0${event.session_id}`;
}

function scopedSessionIdentity(event: EnrichedEvent) {
  return `${event.source}\0${event.project}\0${event.folder}\0${event.session_id}`;
}

export type HistorySessionSpan = { first: string; last: string };
export type HistorySessionSpanMap = Map<string, HistorySessionSpan>;

export function makeHistorySessionSpanKey(
  source: string,
  project: string,
  folder: string,
  sessionId: string,
) {
  return `${source}\0${project}\0${folder}\0${sessionId}`;
}

function eventIdentity(event: EnrichedEvent) {
  return `${event.source}\0${event.id}`;
}

function groupIdentity(event: EnrichedEvent) {
  return `${event.source}\0${event.project}\0${event.folder}`;
}

function firstPreview(events: EnrichedEvent[]) {
  const human = events.find((event) => event.semantic_role === "human_intent" && event.text.trim());
  return ((human ?? events.find((event) => event.text.trim()))?.text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 280);
}

export function buildHistory(
  events: EventRow[],
  occurrences: EventSourceRow[],
  options: HistoryOptions,
): HistoryResponse {
  const period = parseHistoryPeriod(options.period);
  const today = options.today ?? todayInBangkok();
  const { start, end } = historyWindow(period, options.date, today);
  const filtered = filteredEvents(events, occurrences, options).sort(eventOrder);
  const allSessionDates = new Map<string, HistorySessionSpan>(
    options.sessionSpans ? [...options.sessionSpans] : [],
  );

  if (!options.sessionSpans?.size) {
    for (const event of filtered) {
      const date = bangkokDateKey(event.timestamp);
      if (!date) continue;
      const key = scopedSessionIdentity(event);
      const span = allSessionDates.get(key);
      if (!span) {
        allSessionDates.set(key, { first: date, last: date });
      } else {
        if (date < span.first) span.first = date;
        if (date > span.last) span.last = date;
      }
    }
  }

  const selected = filtered.filter((event) => {
    const date = bangkokDateKey(event.timestamp);
    return date !== null && date >= start && date <= end;
  });
  const dayMap = new Map<string, EnrichedEvent[]>();
  for (const event of selected) {
    const date = bangkokDateKey(event.timestamp)!;
    const rows = dayMap.get(date) ?? [];
    rows.push(event);
    dayMap.set(date, rows);
  }

  const days = datesBetween(start, end).map<HistoryDay>((date) => {
    const dayEvents = dayMap.get(date) ?? [];
    const groupsByKey = new Map<string, EnrichedEvent[]>();
    for (const event of dayEvents) {
      const key = groupIdentity(event);
      const rows = groupsByKey.get(key) ?? [];
      rows.push(event);
      groupsByKey.set(key, rows);
    }

    const groups = [...groupsByKey.values()].map<HistoryGroup>((groupEvents) => {
      const sessionsByKey = new Map<string, EnrichedEvent[]>();
      for (const event of groupEvents) {
        const key = scopedSessionIdentity(event);
        const rows = sessionsByKey.get(key) ?? [];
        rows.push(event);
        sessionsByKey.set(key, rows);
      }
      const first = groupEvents[0];
      const sessions = [...sessionsByKey.entries()].map<HistorySessionSummary>(([key, rows]) => {
        rows.sort(eventOrder);
        const span = allSessionDates.get(key) ?? { first: date, last: date };
        return {
          session_id: rows[0].session_id,
          source: rows[0].source,
          project: rows[0].project,
          folder: rows[0].folder,
          started_at: rows[0].timestamp,
          ended_at: rows.at(-1)!.timestamp,
          event_count: rows.length,
          preview: firstPreview(rows),
          continues_before: span.first < date,
          continues_after: span.last > date,
        };
      }).sort((left, right) => left.started_at.localeCompare(right.started_at)
        || left.session_id.localeCompare(right.session_id));
      return {
        source: first.source,
        project: first.project,
        folder: first.folder,
        event_count: groupEvents.length,
        session_count: sessions.length,
        sessions,
      };
    }).sort((left, right) => left.source.localeCompare(right.source)
      || left.project.localeCompare(right.project)
      || left.folder.localeCompare(right.folder));

    return {
      date,
      event_count: new Set(dayEvents.map(eventIdentity)).size,
      session_count: new Set(dayEvents.map(canonicalSessionIdentity)).size,
      groups,
    };
  });

  const selectedSessionIds = new Set(selected.map(canonicalSessionIdentity));
  return {
    time_zone: HISTORY_TIME_ZONE,
    period,
    date: options.date,
    anchor: options.date,
    start,
    end,
    source: options.source,
    project: options.project,
    folder: options.folder,
    totals: {
      days: days.length,
      active_days: days.filter((day) => day.event_count > 0).length,
      events: new Set(selected.map(eventIdentity)).size,
      sessions: selectedSessionIds.size,
      sources: new Set(selected.map((event) => event.source)).size,
      projects: new Set(selected.map((event) => event.project)).size,
      folders: new Set(selected.map((event) => event.folder)).size,
    },
    days,
  };
}

export function buildHistorySession(
  events: EventRow[],
  occurrences: EventSourceRow[],
  options: HistorySessionOptions,
): HistorySessionResponse {
  parseDateKey(options.date);
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new HistoryInputError("offset must be a non-negative integer");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new HistoryInputError("limit must be an integer from 1 to 500");
  }
  const rows = filteredEvents(events, occurrences, options)
    .filter((event) => event.session_id === options.session_id)
    .sort(eventOrder);
  const selectedDayEvents = rows.filter(
    (event) => bangkokDateKey(event.timestamp) === options.date,
  ).length;
  const page = rows.slice(options.offset, options.offset + options.limit);
  const nextOffset = options.offset + page.length;
  return {
    time_zone: HISTORY_TIME_ZONE,
    date: options.date,
    source: options.source,
    project: options.project,
    folder: options.folder,
    session_id: options.session_id,
    offset: options.offset,
    limit: options.limit,
    total: rows.length,
    selected_day_events: selectedDayEvents,
    next_offset: nextOffset < rows.length ? nextOffset : null,
    events: page.map(({ id, timestamp, block_index, block_type, semantic_role, tool_name, text }) => ({
      id,
      timestamp,
      block_index,
      block_type,
      semantic_role,
      tool_name,
      text,
    })),
  };
}
