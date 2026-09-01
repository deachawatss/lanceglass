import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { EventRow, EventSourceRow, SemanticRole } from "./types";

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

const string = (value: unknown) => typeof value === "string" ? value : "";

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const block = item as Record<string, unknown>;
        return block.type === "text" ? string(block.text) : stable(block);
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return value && typeof value === "object" ? stable(value) : "";
}

function codexToolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const block = item as Record<string, unknown>;
      const type = string(block.type);
      return type === "text" || type === "input_text" || type === "output_text"
        ? string(block.text)
        : "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const block = value as Record<string, unknown>;
    const type = string(block.type);
    return type === "text" || type === "input_text" || type === "output_text"
      ? string(block.text)
      : "";
  }
  return "";
}

type Block = {
  index: number;
  type: string;
  role: SemanticRole;
  text: string;
  toolName: string;
  toolUseId: string;
  isError: boolean;
};

export type NormalizationState = {
  sessionId: string;
  cwd: string;
  sessionIdentity: "fallback" | "session_id" | "id";
};

export function createNormalizationState(fallbackSession: string): NormalizationState {
  return { sessionId: fallbackSession, cwd: "", sessionIdentity: "fallback" };
}

function extractBlocks(record: Record<string, unknown>): Block[] {
  const envelope = string(record.type);
  if (envelope === "summary") {
    const text = string(record.summary);
    return text ? [{
      index: 0, type: "summary", role: "summary", text,
      toolName: "", toolUseId: "", isError: false,
    }] : [];
  }
  if (envelope !== "user" && envelope !== "assistant") return [];

  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : {};
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? [{
      index: 0,
      type: "text",
      role: envelope === "user" ? "human_intent" : "assistant_answer",
      text: content,
      toolName: "",
      toolUseId: "",
      isError: false,
    }] : [];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((value, index): Block[] => {
    if (!value || typeof value !== "object") return [];
    const block = value as Record<string, unknown>;
    const type = string(block.type);
    if (type === "text" && string(block.text).trim()) return [{
      index,
      type,
      role: envelope === "user" ? "human_intent" : "assistant_answer",
      text: string(block.text),
      toolName: "",
      toolUseId: "",
      isError: false,
    }];
    if (type === "tool_use") return [{
      index,
      type,
      role: "tool_action",
      text: stable(block.input ?? {}),
      toolName: string(block.name),
      toolUseId: string(block.id),
      isError: false,
    }];
    if (type === "tool_result" && toolResultText(block.content).trim()) return [{
      index,
      type,
      role: "tool_evidence",
      text: toolResultText(block.content),
      toolName: "",
      toolUseId: string(block.tool_use_id),
      isError: block.is_error === true,
    }];
    return []; // progress, thinking and images are not search documents.
  });
}

function codexBlocks(
  record: Record<string, unknown>,
  state: NormalizationState,
): { eventUuid: string; envelope: string; blocks: Block[] } {
  const envelope = string(record.type);
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {};

  if (envelope === "session_meta") {
    // A rollout may contain a second compatibility session_meta record. The
    // first payload.id identifies the file/rollout, so do not replace it with
    // the later payload.session_id.
    const payloadId = string(payload.id);
    const legacySessionId = string(payload.session_id);
    if (payloadId && state.sessionIdentity !== "id") {
      state.sessionId = payloadId;
      state.sessionIdentity = "id";
    } else if (legacySessionId && state.sessionIdentity === "fallback") {
      state.sessionId = legacySessionId;
      state.sessionIdentity = "session_id";
    }
    state.cwd = string(payload.cwd) || state.cwd;
    return { eventUuid: "", envelope, blocks: [] };
  }
  if (envelope === "turn_context") {
    state.cwd = string(payload.cwd) || state.cwd;
    return { eventUuid: "", envelope, blocks: [] };
  }
  if (envelope !== "response_item") return { eventUuid: "", envelope, blocks: [] };

  const payloadType = string(payload.type);
  const payloadId = string(payload.id);
  const callId = string(payload.call_id);
  const eventUuid = payloadId || `hash:${sha256(stable({
    sessionId: state.sessionId,
    timestamp: record.timestamp ?? "",
    ordinal: record.__ordinal ?? "",
    payloadType,
    callId,
  }))}`;

  if (payloadType === "message") {
    const role = string(payload.role);
    if (role !== "user" && role !== "assistant") return { eventUuid, envelope, blocks: [] };
    const content = Array.isArray(payload.content) ? payload.content : [];
    const blocks = content.flatMap((item, index): Block[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const contentBlock = item as Record<string, unknown>;
      const contentType = string(contentBlock.type);
      const text = string(contentBlock.text);
      if (
        (contentType !== "text" && contentType !== "input_text" && contentType !== "output_text") ||
        !text.trim()
      ) return [];
      return [{
        index,
        type: contentType,
        role: role === "user" ? "human_intent" : "assistant_answer",
        text,
        toolName: "",
        toolUseId: "",
        isError: false,
      }];
    });
    return { eventUuid, envelope, blocks };
  }
  if (payloadType === "custom_tool_call") {
    const input = payload.input ?? payload.arguments ?? {};
    return {
      eventUuid,
      envelope,
      blocks: [{
        index: 0,
        type: payloadType,
        role: "tool_action",
        text: typeof input === "string" ? input : stable(input),
        toolName: string(payload.name),
        toolUseId: callId,
        isError: false,
      }],
    };
  }
  if (payloadType === "function_call") {
    const input = payload.arguments ?? {};
    return {
      eventUuid,
      envelope,
      blocks: [{
        index: 0,
        type: payloadType,
        role: "tool_action",
        text: typeof input === "string" ? input : stable(input),
        toolName: string(payload.name),
        toolUseId: callId,
        isError: false,
      }],
    };
  }
  if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
    const text = codexToolOutputText(payload.output);
    return {
      eventUuid,
      envelope,
      blocks: text.trim() ? [{
        index: 0,
        type: payloadType,
        role: "tool_evidence",
        text,
        toolName: "",
        toolUseId: callId,
        isError: false,
      }] : [],
    };
  }
  return { eventUuid, envelope, blocks: [] };
}

export function normalize(
  record: Record<string, unknown>,
  context: {
    source: string;
    filePath: string;
    fileHash: string;
    line: number;
    fallbackSession: string;
  },
  state = createNormalizationState(context.fallbackSession),
) {
  const codex = context.source === "codex";
  // The ordinal is supplied out-of-band so fallback IDs remain independent of
  // object key ordering while the persisted source record stays untouched.
  const codexRecord = codex ? { ...record, __ordinal: context.line } : record;
  const extracted = codex ? codexBlocks(codexRecord, state) : null;
  const sessionId = codex
    ? state.sessionId
    : string(record.sessionId) || string(record.session_id) || context.fallbackSession;
  const eventUuid = codex ? extracted!.eventUuid : string(record.uuid) || `hash:${sha256(stable({
    sessionId,
    timestamp: record.timestamp ?? "",
    type: record.type ?? "",
    parentUuid: record.parentUuid ?? "",
    message: record.message ?? null,
    summary: record.summary ?? null,
  }))}`;
  const cwd = codex ? state.cwd : string(record.cwd);
  const blocks = codex ? extracted!.blocks : extractBlocks(record);

  const events: EventRow[] = blocks.map((block) => {
    const textHash = sha256(block.text);
    return {
      id: `${eventUuid}#${block.index}`,
      event_uuid: eventUuid,
      block_index: block.index,
      session_id: sessionId,
      parent_uuid: string(record.parentUuid),
      timestamp: string(record.timestamp),
      project: basename(cwd) || "?",
      envelope_type: codex ? extracted!.envelope : string(record.type),
      block_type: block.type,
      semantic_role: block.role,
      tool_name: block.toolName,
      tool_use_id: block.toolUseId,
      is_error: block.isError,
      text: block.text.slice(0, 4_000),
      text_hash: textHash,
      source: context.source,
    };
  });

  const occurrences: EventSourceRow[] = events.map((event) => ({
    id: sha256([
      event.id,
      context.source,
      context.filePath,
      context.line,
      event.text_hash,
    ].join("\0")),
    event_id: event.id,
    source: context.source,
    file_path: context.filePath,
    file_hash: context.fileHash,
    source_line: context.line,
    observed_text_hash: event.text_hash,
  }));

  return { events, occurrences };
}
