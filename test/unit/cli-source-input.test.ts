import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInventory } from "../../src/cache.ts";
import { resolveConfig } from "../../src/config.ts";
import { describeError } from "../../src/cli/errors.ts";
import { resolveRepositoryInput } from "../../src/cli/repository-input.ts";

const URLS = ["https://github.com/example/api-one", "https://github.com/example/api-two"];

describe("source and root config input errors", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-source-errors-"));
    await Bun.write(join(root, "dev.yaml"), "version: 1\n");
    await writeInventory({
      root,
      tenant: "fixture",
      records: URLS.map((url, index) => ({
        id: String(index),
        name: `api-${index === 0 ? "one" : "two"}`,
        url,
        description: "",
        last_changed: "",
        syncedAt: "",
      })),
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function resolve(value: string) {
    return await resolveRepositoryInput({
      value,
      root,
      message: "Repository",
      required: {
        command: "ws add",
        field: "repository",
        usage: "dev ws add <repository>",
        description: "Repository",
      },
      ambient: {
        argv: [],
        cwd: root,
        env: { HOME: root, USERPROFILE: root },
        isTTY: false,
        stdinIsTTY: false,
      },
    });
  }

  it("still accepts explicit URLs and exact inventory names", async () => {
    expect((await resolve(URLS[0]!)).value).toBe(URLS[0]);
    expect((await resolve("api-one")).value).toBe(URLS[0]);
  });

  it("names a missing source without recommending an unconfigured provider", async () => {
    let error: unknown;
    try {
      await resolve("missing");
    } catch (caught) {
      error = caught;
    }
    expect(describeError(error)).toMatchObject({
      code: "SOURCE_NOT_FOUND",
      details: { query: "missing" },
    });
    expect(describeError(error).nextStep).toContain("dev provider add <type>");
  });

  it("retains both ambiguous source candidates", async () => {
    await writeInventory({
      root,
      tenant: "fixture",
      records: URLS.map((url, index) => ({
        id: String(index),
        name: `api-${index === 0 ? "one" : "two"}`,
        url: url.replace("https://", "https://fixture-user:fixture-secret@"),
        description: "",
        last_changed: "",
        syncedAt: "",
      })),
    });
    let error: unknown;
    try {
      await resolve("api");
    } catch (caught) {
      error = caught;
    }
    expect(describeError(error)).toMatchObject({
      code: "SOURCE_AMBIGUOUS",
      details: { query: "api", matches: URLS },
    });
    for (const url of URLS) expect(describeError(error).message).toContain(url);
    expect(JSON.stringify(describeError(error))).not.toContain("fixture-secret");
  });

  it.each(["version: [", "version: 1\nworksets:\n  broken:\n    members: []\n"])(
    "codes invalid dev.yaml (%s)",
    async (content) => {
      const path = join(root, "dev.yaml");
      await Bun.write(path, content);
      let error: unknown;
      try {
        resolveConfig({ rootFlag: root, cwd: root, env: { HOME: root } });
      } catch (caught) {
        error = caught;
      }
      expect(describeError(error)).toMatchObject({ code: "INVALID_CONFIG", details: { path } });
      expect(describeError(error).nextStep).toContain(path);
    },
  );
});
