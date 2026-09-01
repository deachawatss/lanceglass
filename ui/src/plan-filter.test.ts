import { describe, expect, test } from "bun:test";
import { initialPlanFilter } from "./App";

describe("initialPlanFilter", () => {
  test("opens pending work instead of an empty new-files view", () => {
    expect(initialPlanFilter({ new: 0, changed: 9, shrunk: 0 })).toBe("actionable");
  });

  test("includes reconciliation work in the initial attention view", () => {
    expect(initialPlanFilter({ new: 0, changed: 0, shrunk: 1 })).toBe("actionable");
  });

  test("shows the complete inventory when nothing needs attention", () => {
    expect(initialPlanFilter({ new: 0, changed: 0, shrunk: 0 })).toBe("all");
  });
});
