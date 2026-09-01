import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceSpec } from "./types";

export type SourcePreset = {
  id: string;
  label: string;
  root: string;
  default?: boolean;
};

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    id: "claude",
    label: "Claude Code",
    root: join(homedir(), ".claude", "projects"),
    default: true,
  },
  {
    id: "codex",
    label: "Codex",
    root: join(homedir(), ".codex", "sessions"),
  },
  {
    id: "fixture",
    label: "Bundled fixture",
    root: fileURLToPath(new URL("../fixtures/minimal", import.meta.url)),
  },
];

export const DEFAULT_SOURCE_ID = "claude";

export function sourcePreset(source: string) {
  return SOURCE_PRESETS.find((preset) => preset.id === source);
}

/** Resolve an explicit custom root, or a known source preset when root is omitted. */
export function resolveSourceSpec(root = "", source = ""): SourceSpec {
  const selectedSource = source.trim() || DEFAULT_SOURCE_ID;
  const explicitRoot = root.trim();
  if (explicitRoot) return { root: explicitRoot, source: selectedSource };

  const preset = sourcePreset(selectedSource);
  if (!preset) {
    throw new Error(`unknown source preset "${selectedSource}"; pass --root <directory> for a custom source`);
  }
  return { root: preset.root, source: preset.id };
}
