import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sync inventory provider concurrency", () => {
  let root: string;
  let originalFetch: typeof globalThis.fetch;
  let originalLog: typeof console.log;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-sync-concurrency-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "dev.yaml"),
      [
        "version: 1",
        "providers:",
        ...Array.from({ length: 6 }, (_, index) => [
          `  - id: ado-${index}`,
          "    type: azure_devops",
          `    organization: org-${index}`,
        ]).flat(),
      ].join("\n"),
      "utf8",
    );
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("runs providers concurrently without exceeding the per-host limit", async () => {
    const gate = deferred();
    const fiveRequestsStarted = deferred();
    let active = 0;
    let peak = 0;

    const fetchStub = async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (peak === 5) fiveRequestsStarted.resolve();
      await gate.promise;
      active -= 1;
      return Response.json({ value: [], count: 0 });
    };
    fetchStub.preconnect = () => {};
    globalThis.fetch = fetchStub;

    const running = runCli({
      argv: ["sync", "inventory", "--root", root, "--json"],
      cwd: root,
      env: { AZURE_DEVOPS_PAT: "test-token" },
      isTTY: false,
    });

    await Promise.race([fiveRequestsStarted.promise, Bun.sleep(500)]);
    gate.resolve();

    expect(await running).toBe(0);
    expect(peak).toBe(5);
  });
});
