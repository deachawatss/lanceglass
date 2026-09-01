type LatestRequestRunner = {
  invalidate: () => void;
  run: <T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    reject?: (error: unknown) => void,
  ) => Promise<void>;
};

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function createLatestRequestRunner(): LatestRequestRunner {
  let epoch = 0;
  const controllers = new Map<string, AbortController>();

  return {
    invalidate() {
      epoch += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },

    async run(key, load, apply, reject) {
      controllers.get(key)?.abort();
      const controller = new AbortController();
      const requestEpoch = epoch;
      controllers.set(key, controller);
      const isCurrent = () => (
        requestEpoch === epoch
        && !controller.signal.aborted
        && controllers.get(key) === controller
      );

      try {
        const value = await load(controller.signal);
        if (isCurrent()) apply(value);
      } catch (error) {
        if (isCurrent() && !isAbortError(error)) reject?.(error);
      } finally {
        if (controllers.get(key) === controller) controllers.delete(key);
      }
    },
  };
}
