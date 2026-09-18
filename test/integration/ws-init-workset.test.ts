import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cache from "../../src/cache.ts";
import { runCli } from "../../src/cli";
import * as git from "../../src/git.ts";
import * as manifest from "../../src/manifest.ts";
import { ui } from "../../src/ui.ts";

async function createRemote(
  root: string,
  name: string,
  branches: string[] = ["main"],
): Promise<string> {
  const remote = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await git.runGit(["init", "--bare", "-b", branches[0]!, remote]);
  await git.runGit(["init", "-b", branches[0]!, seed]);
  await git.runGit(["config", "user.name", "Workset Test"], { cwd: seed });
  await git.runGit(["config", "user.email", "workset@example.com"], { cwd: seed });
  await Bun.write(join(seed, "README.md"), `# ${name}\n`);
  await git.runGit(["add", "."], { cwd: seed });
  await git.runGit(["commit", "-m", `feat: seed ${name}`], { cwd: seed });
  await git.runGit(["remote", "add", "origin", remote], { cwd: seed });
  await git.runGit(["push", "-u", "origin", branches[0]!], { cwd: seed });
  for (const branch of branches.slice(1)) {
    await git.runGit(["checkout", "-b", branch], { cwd: seed });
    await git.runGit(["push", "-u", "origin", branch], { cwd: seed });
  }
  await rm(seed, { recursive: true, force: true });
  return remote;
}

describe("workspace initialization plans", () => {
  let root: string;
  let appRemote: string;
  let wikiRemote: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-workset-"));
    appRemote = await createRemote(root, "mobile-app");
    wikiRemote = await createRemote(root, "wiki-docs", ["master", "internal"]);
    originalLog = console.log;
    originalError = console.error;
    logs = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    await Bun.write(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  app:
    description: Mobile app with public and internal documentation
    members:
      - source: ${appRemote}
        ref: main
        reason: Mobile implementation
      - source: ${wikiRemote}
        ref: master
        path: wiki-docs
        reason: Public documentation
      - source: ${wikiRemote}
        ref: internal
        path: wiki-docs-internal
        reason: Internal documentation
`,
    );
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  });

  test("materializes every workset member with its configured ref and path", async () => {
    const code = await runCli({
      argv: ["ws", "init", "review-app", "--workset", "app", "--root", root, "--json"],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const parsed = await manifest.readWorkspace(join(root, "ws", "review-app", "ws.md"));
    expect(parsed.manifest.mounts.map((mount) => [mount.path, mount.revision])).toEqual([
      ["mobile-app", { mode: "track", branch: "main" }],
      ["wiki-docs", { mode: "track", branch: "master" }],
      ["wiki-docs-internal", { mode: "track", branch: "internal" }],
    ]);
  });

  test("creates a workspace from multiple repositories selected from inventory", async () => {
    await cache.writeInventory({
      root,
      tenant: "local/test",
      records: [
        {
          id: "app",
          name: "mobile-app",
          url: appRemote,
          default_branch: "main",
          syncedAt: "2026-09-18T00:00:00Z",
          description: "Mobile application",
          last_changed: "2026-09-18T00:00:00Z",
        },
        {
          id: "wiki",
          name: "wiki-docs",
          url: wikiRemote,
          default_branch: "master",
          syncedAt: "2026-09-18T00:00:00Z",
          description: "Documentation",
          last_changed: "2026-09-18T00:00:00Z",
        },
      ],
    });
    const select = spyOn(ui, "select").mockResolvedValueOnce("repositories");
    const multiSelect = spyOn(ui, "multiSelect")
      .mockResolvedValueOnce([appRemote, wikiRemote])
      .mockResolvedValueOnce(["defaults"]);
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("selected-repositories")
      .mockResolvedValueOnce("Review selected repositories");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["ws", "init", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const parsed = await manifest.readWorkspace(join(root, "ws", "selected-repositories", "ws.md"));
    expect(parsed.manifest.mounts.map((mount) => [mount.path, mount.revision])).toEqual([
      ["mobile-app", { mode: "track", branch: "main" }],
      ["wiki-docs", { mode: "track", branch: "master" }],
    ]);

    select.mockRestore();
    multiSelect.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("accepts a manual repository URI from the repository picker", async () => {
    await cache.writeInventory({
      root,
      tenant: "local/test",
      records: [
        {
          id: "wiki",
          name: "wiki-docs",
          url: wikiRemote,
          default_branch: "master",
          syncedAt: "2026-09-18T00:00:00Z",
          description: "Documentation",
          last_changed: "2026-09-18T00:00:00Z",
        },
      ],
    });
    const select = spyOn(ui, "select").mockResolvedValueOnce("repositories");
    const multiSelect = spyOn(ui, "multiSelect")
      .mockResolvedValueOnce(["\0manual-source"])
      .mockResolvedValueOnce(["defaults"]);
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce(appRemote)
      .mockResolvedValueOnce("manual-repository")
      .mockResolvedValueOnce("Manual URI selection");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["ws", "init", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const parsed = await manifest.readWorkspace(join(root, "ws", "manual-repository", "ws.md"));
    expect(parsed.manifest.mounts.map((mount) => mount.path)).toEqual(["mobile-app"]);

    select.mockRestore();
    multiSelect.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("lists and shows configured worksets", async () => {
    logs = [];
    expect(
      await runCli({
        argv: ["workset", "list", "--root", root, "--json"],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) ?? "[]")).toEqual([
      {
        name: "app",
        description: "Mobile app with public and internal documentation",
        memberCount: 3,
      },
    ]);

    logs = [];
    expect(
      await runCli({
        argv: ["workset", "show", "app", "--root", root, "--json"],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    const shown = JSON.parse(logs.at(-1) ?? "{}");
    expect(shown.name).toBe("app");
    expect(shown.members.map((member: { path?: string }) => member.path)).toEqual([
      undefined,
      "wiki-docs",
      "wiki-docs-internal",
    ]);
  });

  test("selects a configured workset from a dedicated picker", async () => {
    const select = spyOn(ui, "select")
      .mockResolvedValueOnce("workset")
      .mockResolvedValueOnce("app");
    const multiSelect = spyOn(ui, "multiSelect").mockResolvedValueOnce(["defaults"]);
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("app-review")
      .mockResolvedValueOnce("Review app context");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["ws", "init", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const parsed = await manifest.readWorkspace(join(root, "ws", "app-review", "ws.md"));
    expect(parsed.manifest.mounts.map((mount) => mount.path)).toEqual([
      "mobile-app",
      "wiki-docs",
      "wiki-docs-internal",
    ]);

    select.mockRestore();
    multiSelect.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });
});
