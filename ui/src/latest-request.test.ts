import { describe, expect, test } from "bun:test";
import { createLatestRequestRunner } from "./latest-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("latest request runner", () => {
  test("does not apply a delayed response after invalidation", async () => {
    const gate = createLatestRequestRunner();
    const response = deferred<string>();
    const applied: string[] = [];
    const pending = gate.run("session", () => response.promise, (value) => applied.push(value));

    gate.invalidate();
    response.resolve("stale");
    await pending;

    expect(applied).toEqual([]);
  });

  test("aborts an in-flight loader when invalidated", async () => {
    const gate = createLatestRequestRunner();
    const response = deferred<string>();
    let signal: AbortSignal | undefined;
    const pending = gate.run("session", (nextSignal) => {
      signal = nextSignal;
      return response.promise;
    }, () => {});

    gate.invalidate();
    expect(signal?.aborted).toBe(true);
    response.resolve("ignored");
    await pending;
  });

  test("only applies the newest response for one session key", async () => {
    const gate = createLatestRequestRunner();
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const applied: string[] = [];
    const oldPending = gate.run("session", () => oldResponse.promise, (value) => applied.push(value));
    const newPending = gate.run("session", () => newResponse.promise, (value) => applied.push(value));

    newResponse.resolve("new");
    oldResponse.resolve("old");
    await Promise.all([oldPending, newPending]);

    expect(applied).toEqual(["new"]);
  });

  test("does not publish a delayed error after invalidation", async () => {
    const gate = createLatestRequestRunner();
    const response = deferred<string>();
    const rejected: unknown[] = [];
    const pending = gate.run("session", () => response.promise, () => {}, (error) => rejected.push(error));

    gate.invalidate();
    response.reject(new Error("stale failure"));
    await pending;

    expect(rejected).toEqual([]);
  });
});
