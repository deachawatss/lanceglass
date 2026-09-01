import { describe, expect, test } from "bun:test";
import { historySourceNumbers } from "./history-source";

describe("history source display numbers", () => {
  test("stay tied to the complete source catalogue, not a filtered response", () => {
    const numbers = historySourceNumbers(["fixture", "codex", "claude"]);

    expect(numbers.get("claude")).toBe("01");
    expect(numbers.get("codex")).toBe("02");
    expect(numbers.get("fixture")).toBe("03");
    // A history response limited to Codex must still render its canonical ID.
    expect(numbers.get("codex")).toBe("02");
  });
});
