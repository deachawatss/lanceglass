export type HistoryGroupOrder = "latest" | "earliest" | "project" | "events" | "sessions";

export type TimedSession = {
  started_at: string;
  ended_at: string;
  session_id?: string;
};

export type TimedRecordSession = TimedSession & { event_count: number };

export type SortableHistoryGroup = {
  source: string;
  project: string;
  folder: string;
  event_count: number;
  session_count: number;
  sessions: TimedSession[];
};

export type SortableHistoryRecord<T extends TimedRecordSession = TimedRecordSession> = {
  group: Pick<SortableHistoryGroup, "source" | "project" | "folder" | "event_count" | "session_count">;
  session: T;
};

export function historyGroupRange(group: SortableHistoryGroup) {
  const starts = group.sessions.map((session) => session.started_at).filter(Boolean).sort();
  const updates = group.sessions.map((session) => session.ended_at).filter(Boolean).sort();
  return {
    startedAt: starts[0] ?? "",
    updatedAt: updates.at(-1) ?? "",
  };
}

function identity(group: SortableHistoryGroup) {
  return `${group.source}\u0000${group.project}\u0000${group.folder}`;
}

export function sortHistoryGroups<T extends SortableHistoryGroup>(groups: T[], order: HistoryGroupOrder): T[] {
  return [...groups].sort((left, right) => {
    const leftRange = historyGroupRange(left);
    const rightRange = historyGroupRange(right);
    let difference = 0;

    if (order === "latest") difference = rightRange.updatedAt.localeCompare(leftRange.updatedAt);
    else if (order === "earliest") difference = (leftRange.startedAt || "\uffff").localeCompare(rightRange.startedAt || "\uffff");
    else if (order === "project") difference = left.project.localeCompare(right.project);
    else if (order === "events") difference = right.event_count - left.event_count;
    else if (order === "sessions") difference = right.session_count - left.session_count;

    return difference || identity(left).localeCompare(identity(right));
  });
}

export function sortHistorySessions<T extends TimedSession>(sessions: T[], order: HistoryGroupOrder): T[] {
  return [...sessions].sort((left, right) => {
    const difference = order === "earliest"
      ? (left.started_at || "\uffff").localeCompare(right.started_at || "\uffff")
      : right.ended_at.localeCompare(left.ended_at);
    return difference || (left.session_id ?? "").localeCompare(right.session_id ?? "");
  });
}

function recordTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Valid timestamps always precede malformed or missing timestamps. */
function compareRecordTimestamp(leftValue: string, rightValue: string, direction: "ascending" | "descending") {
  const left = recordTimestamp(leftValue);
  const right = recordTimestamp(rightValue);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "ascending" ? left - right : right - left;
}

function recordIdentity(record: SortableHistoryRecord) {
  return `${record.group.source}\u0000${record.group.project}\u0000${record.group.folder}\u0000${record.session.session_id ?? ""}`;
}

/** Sort the primary, flattened session ledger without changing calendar-day order. */
export function sortHistoryRecords<T extends SortableHistoryRecord>(records: T[], order: HistoryGroupOrder): T[] {
  return [...records].sort((left, right) => {
    let difference = 0;

    if (order === "latest") difference = compareRecordTimestamp(left.session.ended_at, right.session.ended_at, "descending");
    else if (order === "earliest") difference = compareRecordTimestamp(left.session.started_at, right.session.started_at, "ascending");
    else if (order === "project") {
      difference = left.group.project.localeCompare(right.group.project)
        || left.group.folder.localeCompare(right.group.folder)
        || compareRecordTimestamp(left.session.ended_at, right.session.ended_at, "descending");
    } else if (order === "events") difference = right.session.event_count - left.session.event_count || compareRecordTimestamp(left.session.ended_at, right.session.ended_at, "descending");
    else if (order === "sessions") difference = right.group.session_count - left.group.session_count || compareRecordTimestamp(left.session.ended_at, right.session.ended_at, "descending");

    return difference || recordIdentity(left).localeCompare(recordIdentity(right));
  });
}
