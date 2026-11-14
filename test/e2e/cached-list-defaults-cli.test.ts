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
          description: "Cached description ".repeat(128),
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
        title: `WI ${index + 1} ${"cached detail ".repeat(160)}`,
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
    const command = [process.execPath, CLI, ...args, "--offline", "--json", "--root", root];
    // Exercise a real pipe on macOS rather than Bun's captured-stdout transport.
    const child = Bun.spawn(
      process.platform === "darwin"
        ? [
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-o",
            "pipefail",
            "-c",
            '"$@" | cat',
            "dev-list-test",
            ...command,
          ]
        : command,
      {
        cwd: root,
        env: {
          ...process.env,
          BASH_ENV: "",
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

  it("keeps large cached PR JSON complete with open status and explicit choices", async () => {
    expect(await ids(["pr", "list"])).toEqual(Array.from({ length: 60 }, (_, index) => 60 - index));
    expect(await ids(["pr", "list", "--status", "completed", "--limit", "1"])).toEqual([62]);
    expect(await ids(["pr", "list", "--status", "all", "--limit", "2"])).toEqual([62, 61]);
  });

  it("filters offline PRs by project without changing status or limit semantics", async () => {
    expect(await ids(["pr", "list", "--all", "--project", "missing"])).toEqual([]);
    expect(await ids(["pr", "list", "--all", "--project", "PROJECT", "--limit", "1"])).toEqual([
      60,
    ]);
    expect(
      await ids(["pr", "list", "--all", "--project", "project", "--status", "completed"]),
    ).toEqual([62, 61]);
  });

  it("keeps large cached WI JSON complete with bounded defaults and explicit limits", async () => {
    expect(await ids(["wi", "list"])).toEqual(Array.from({ length: 50 }, (_, index) => 60 - index));
    expect(await ids(["wi", "list", "--limit", "2"])).toEqual([60, 59]);
    expect(await ids(["wi", "list", "--limit", "60"])).toEqual(
      Array.from({ length: 60 }, (_, index) => 60 - index),
    );
  });
});
