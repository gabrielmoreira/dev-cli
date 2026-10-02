import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePullRequests, writeWorkItems } from "../../src/cache.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("numeric CLI inputs", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-numeric-input-"));
    await Bun.write(join(root, "dev.yaml"), "version: 1\n");
    await writePullRequests({
      root,
      tenant: "fixture",
      repo: "api",
      project: "project",
      records: [123, 124].map((id) => ({
        id,
        title: `PR ${id}`,
        description: "",
        status: "open",
        sourceBranch: "feature",
        targetBranch: "main",
        author: "Example",
        url: `https://example.test/pr/${id}`,
        createdAt: "",
        updatedAt: "",
        isDraft: false,
        repository: "api",
        project: "project",
        tenant: "fixture",
        syncedAt: "",
      })),
    });
    await writeWorkItems({
      root,
      tenant: "fixture",
      project: "project",
      records: [123, 124].map((id) => ({
        id,
        type: "Task",
        title: `WI ${id}`,
        state: "New",
        url: `https://example.test/wi/${id}`,
        tenant: "fixture",
        project: "project",
        syncedAt: "",
      })),
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function run(args: readonly string[]) {
    const child = Bun.spawn([process.execPath, CLI, "--json", ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DEV_ROOT: root,
        DEV_CWD: root,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        CI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it.each(["pr", "wi"])("keeps valid %s limits and IDs", async (command) => {
    const list = await run([command, "--limit", "1", "--offline"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).map((item: { id: number }) => item.id)).toEqual([124]);
    const view = await run([command, "view", "123", "--offline"]);
    expect(view.exitCode).toBe(0);
    expect(JSON.parse(view.stdout).id).toBe(123);
  });

  it.each(["0", "-3", "abc", "5x", "1.5", "9007199254740992", ""])(
    "rejects invalid limits '%s' before workspace/provider resolution",
    async (value) => {
      for (const command of ["pr", "wi"]) {
        const result = await run([
          command,
          `--limit=${value}`,
          "--ws",
          "missing",
          "--provider",
          "missing",
          "--project",
          "missing",
        ]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error).toMatchObject({
          code: "INVALID_ARGUMENT",
          field: "--limit",
          value,
        });
      }
    },
  );

  it.each(["0", "123abc", "1.5", "9007199254740992"])(
    "rejects invalid IDs '%s' instead of viewing a different item",
    async (value) => {
      for (const command of ["pr", "wi"]) {
        const result = await run([command, "view", value, "--offline"]);
        expect(result.exitCode).toBe(2);
        expect(JSON.parse(result.stderr).error).toMatchObject({
          code: "INVALID_ARGUMENT",
          field: "id",
          value,
        });
      }
      const checkout = await run(["pr", "checkout", value]);
      expect(checkout.exitCode).toBe(2);
      expect(JSON.parse(checkout.stderr).error).toMatchObject({
        code: "INVALID_ARGUMENT",
        field: "reference",
        value,
      });
    },
  );

  it("rejects a negative ID passed after the option boundary", async () => {
    const result = await run(["wi", "view", "--", "-3"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "INVALID_ARGUMENT",
      field: "id",
      value: "-3",
    });
  });
});
