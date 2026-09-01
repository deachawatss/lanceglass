import { describe, expect, test } from "bun:test";
import { nextHistoryDate, shiftHistoryDate } from "./history-date";

describe("history date navigation", () => {
  test("moves day and week anchors in calendar time", () => {
    expect(shiftHistoryDate("2026-08-31", "day", -1)).toBe("2026-08-30");
    expect(shiftHistoryDate("2026-08-17", "week", 1)).toBe("2026-08-24");
  });

  test("clamps month navigation to the target month's last day", () => {
    expect(shiftHistoryDate("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(shiftHistoryDate("2024-03-31", "month", -1)).toBe("2024-02-29");
  });

  test("clamps a next week that would jump beyond Bangkok today", () => {
    expect(nextHistoryDate("2026-08-30", "week", "2026-08-31")).toBe("2026-08-31");
  });

  test("clamps a next month anchor when the current month is incomplete", () => {
    expect(nextHistoryDate("2026-07-31", "month", "2026-08-20")).toBe("2026-08-20");
  });
});
