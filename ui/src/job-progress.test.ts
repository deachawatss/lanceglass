import { describe, expect, test } from "bun:test";
import { latestJobProgress } from "./App";

describe("import job progress", () => {
  test("returns the newest structured jscan progress line", () => {
    expect(latestJobProgress("job-1", [
      "! [jscan] import start 0/829",
      "ordinary terminal output",
      "! [jscan] import progress 135/829 records=40471 blocks=800",
    ])).toEqual({
      jobId: "job-1",
      current: 135,
      total: 829,
      records: 40471,
      blocks: 800,
    });
  });

  test("ignores terminal lines without structured progress", () => {
    expect(latestJobProgress("job-2", ["Import complete", "exit 0"])).toBeNull();
  });
});
