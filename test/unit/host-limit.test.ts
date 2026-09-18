import { describe, expect, test } from "bun:test";
import { withHostLimit } from "../../src/host-limit";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("withHostLimit", () => {
  test("does not reacquire the same host limit in a nested operation", async () => {
    const allOuterOperationsStarted = deferred();
    let started = 0;

    const operations = Array.from({ length: 5 }, () =>
      withHostLimit("https://example.com/outer", async () => {
        started += 1;
        if (started === 5) allOuterOperationsStarted.resolve();
        await allOuterOperationsStarted.promise;
        return await withHostLimit("https://example.com/inner", async () => "done");
      }),
    );

    const result = await Promise.race([
      Promise.all(operations),
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);

    expect(result).toEqual(["done", "done", "done", "done", "done"]);
  });

  test("shares a host limit between HTTPS and SSH Git URLs", async () => {
    const releaseHttpsOperations = deferred();
    const allHttpsOperationsStarted = deferred();
    let httpsStarted = 0;

    const httpsOperations = Array.from({ length: 5 }, () =>
      withHostLimit("https://dev.azure.com/org/repo", async () => {
        httpsStarted += 1;
        if (httpsStarted === 5) allHttpsOperationsStarted.resolve();
        await releaseHttpsOperations.promise;
      }),
    );
    await allHttpsOperationsStarted.promise;

    const sshOperationStarted = deferred();
    const sshOperation = withHostLimit("git@dev.azure.com:org/repo.git", async () => {
      sshOperationStarted.resolve();
    });

    const startedBeforeRelease = await Promise.race([
      sshOperationStarted.promise.then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    expect(startedBeforeRelease).toBe(false);

    releaseHttpsOperations.resolve();
    await Promise.all([...httpsOperations, sshOperation]);
  });
});
