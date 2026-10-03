import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePullRequests, writeWorkItems } from "../../src/cache.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("cached CLI list omission and explicit intent", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-list-policy-"));
    await writeFile(join(root, "dev.yaml"), "version: 1\n");
    await writePullRequests({
      root,
      tenant: "fixture",
      repo: "api",
      project: "project",
      records: Array.from({ length: 62 }, (_, index) => {
        const id = index + 1;
        return {
          id,
          title: `PR ${id}`,
          description: "",
          status: id <= 60 ? ("open" as const) : ("completed" as const),
          sourceBranch: "feature",
          targetBranch: "main",
          author: "Example",
          isDraft: false,
          url: `https://example.test/pr/${id}`,
          createdAt: "",
          updatedAt: "",
          syncedAt: "",
          repository: "api",
          project: "project",
          tenant: "fixture",
        };
      }),
    });
    await writeWorkItems({
      root,
      tenant: "fixture",
      project: "project",
      records: Array.from({ length: 60 }, (_, index) => ({
        id: index + 1,
        type: "Task",
        title: `WI ${index + 1}`,
        state: "New",
        url: `https://example.test/wi/${index + 1}`,
        tenant: "fixture",
        project: "project",
        syncedAt: "",
      })),
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function ids(args: string[]): Promise<number[]> {
    const child = Bun.spawn(
      [process.execPath, CLI, ...args, "--offline", "--json", "--root", root],
      {
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
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return JSON.parse(stdout).map((record: { id: number }) => record.id);
  }

  it("keeps omitted PR status open and display unlimited while explicit choices win", async () => {
    expect(await ids(["pr", "list"])).toEqual(Array.from({ length: 60 }, (_, index) => 60 - index));
    expect(await ids(["pr", "list", "--status", "completed", "--limit", "1"])).toEqual([62]);
    expect(await ids(["pr", "list", "--status", "all", "--limit", "2"])).toEqual([62, 61]);
  });

  it("keeps omitted WI display bounded and explicit limits authoritative", async () => {
    expect(await ids(["wi", "list"])).toEqual(Array.from({ length: 50 }, (_, index) => 60 - index));
    expect(await ids(["wi", "list", "--limit", "2"])).toEqual([60, 59]);
    expect(await ids(["wi", "list", "--limit", "60"])).toEqual(
      Array.from({ length: 60 }, (_, index) => 60 - index),
    );
  });
});
