import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ui } from "../../src/ui.ts";
import * as git from "../../src/git.ts";
import { runCli } from "../../src/cli";
import * as cache from "../../src/cache.ts";
import * as manifest from "../../src/manifest.ts";
import { resolveWorkspaceInput } from "../../src/cli/workspace-input.ts";

describe("smart CLI input", () => {
  let root: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let errors: string[];
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-smart-input-"));
    originalLog = console.log;
    originalError = console.error;
    errors = [];
    logs = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  });

  test("guides an argument-free init with an editable default root path", async () => {
    const home = join(root, "home");
    const selectedRoot = join(home, "engineering");
    await mkdir(home, { recursive: true });
    await mkdir(join(home, "dev"), { recursive: true });
    const text = spyOn(ui, "text").mockResolvedValueOnce(selectedRoot);
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(false);

    const exitCode = await runCli({
      argv: ["init"],
      cwd: home,
      env: { HOME: home, USERPROFILE: home },
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(text).toHaveBeenCalledWith("Dev root path", join(home, "dev"));
    expect(existsSync(join(selectedRoot, "dev.yaml"))).toBe(true);
    expect(existsSync(join(selectedRoot, "AGENTS.md"))).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Add a provider now?", true);
    text.mockRestore();
    confirm.mockRestore();
  });

  test("offers to update the current root or create another one", async () => {
    const existingRoot = join(root, "existing-root");
    const nested = join(existingRoot, "ws", "current-task");
    await mkdir(nested, { recursive: true });
    await writeFile(join(existingRoot, "dev.yaml"), "sync_strategy: ff-only\n");
    const select = spyOn(ui, "select").mockResolvedValueOnce("update");
    const text = spyOn(ui, "text");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(false);

    const exitCode = await runCli({
      argv: ["init"],
      cwd: nested,
      env: { HOME: root, USERPROFILE: root },
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(select).toHaveBeenCalledWith("A dev root already exists here", [
      { label: `Update ${existingRoot}`, value: "update" },
      { label: "Create another dev root", value: "create" },
    ]);
    expect(text).not.toHaveBeenCalled();
    expect(await Bun.file(join(existingRoot, "dev.yaml")).text()).toBe("sync_strategy: ff-only\n");
    select.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("makes a newly created guided root the global default", async () => {
    const existingRoot = join(root, "current-root");
    const nested = join(existingRoot, "ws", "current-task");
    const newRoot = join(root, "next-root");
    await mkdir(nested, { recursive: true });
    expect(
      await runCli({
        argv: ["init", existingRoot, "--alias", "current"],
        cwd: root,
        env: { HOME: root, USERPROFILE: root },
        isTTY: false,
      }),
    ).toBe(0);
    const select = spyOn(ui, "select").mockResolvedValueOnce("create");
    const text = spyOn(ui, "text").mockResolvedValueOnce(newRoot);
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(false);

    expect(
      await runCli({
        argv: ["init"],
        cwd: nested,
        env: { HOME: root, USERPROFILE: root },
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);

    expect(existsSync(join(newRoot, "dev.yaml"))).toBe(true);
    expect(await Bun.file(join(root, ".dev.toml")).text()).toContain('default_root = "next-root"');
    select.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });
  test("adds a provider and synchronizes its inventory before init completes", async () => {
    const home = join(root, "onboarding-home");
    const selectedRoot = join(home, "dev");
    await mkdir(home, { recursive: true });
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce(selectedRoot)
      .mockResolvedValueOnce("example-owner");
    const select = spyOn(ui, "select").mockResolvedValueOnce("github");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          id: 1,
          name: "example-repository",
          full_name: "example-owner/example-repository",
          clone_url: "https://github.com/example-owner/example-repository.git",
          default_branch: "main",
        },
      ]),
    );

    const exitCode = await runCli({
      argv: ["init"],
      cwd: home,
      env: { HOME: home, USERPROFILE: home, GITHUB_TOKEN: "test-token" },
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    const config = await Bun.file(join(selectedRoot, "dev.yaml")).text();
    expect(config).toContain("type: github");
    expect(config).toContain("owner: example-owner");
    expect(await cache.loadAllCachedInventories(selectedRoot)).toMatchObject([
      { name: "example-repository", default_branch: "main" },
    ]);
    expect(logs.join("\n")).toContain("Synchronized repository inventory");
    expect(request).toHaveBeenCalledTimes(1);
    text.mockRestore();
    select.mockRestore();
    confirm.mockRestore();
    request.mockRestore();
  });

  test("collects a missing workspace name before creating it in an interactive terminal", async () => {
    const select = spyOn(ui, "select").mockResolvedValueOnce("blank");
    const prompt = spyOn(ui, "text")
      .mockResolvedValueOnce("guided-workspace")
      .mockResolvedValueOnce("Workspace for guided CLI reviews");

    const exitCode = await runCli({
      argv: ["ws", "init", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(root, "ws", "guided-workspace", "ws.md"))).toBe(true);
    expect(await Bun.file(join(root, "ws", "guided-workspace", "ws.md")).text()).toContain(
      "Workspace for guided CLI reviews",
    );
    select.mockRestore();
    prompt.mockRestore();
  });

  test("creates and mounts a repository through the guided workspace flow", async () => {
    const source = join(root, "guided-source.git");
    const seed = join(root, "guided-seed");
    await git.runGit(["init", "--bare", "-b", "main", source]);
    await git.runGit(["init", "-b", "main", seed]);
    await git.runGit(["config", "user.name", "Guided Workspace Test"], { cwd: seed });
    await git.runGit(["config", "user.email", "guided@example.com"], { cwd: seed });
    await writeFile(join(seed, "README.md"), "# guided\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "feat: seed guided repository"], { cwd: seed });
    await git.runGit(["remote", "add", "origin", source], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seed });

    const select = spyOn(ui, "select").mockResolvedValueOnce("repositories");
    const multiSelect = spyOn(ui, "multiSelect").mockResolvedValueOnce(["defaults"]);
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);
    const prompt = spyOn(ui, "text")
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce("local-guided-source")
      .mockResolvedValueOnce("Review guided source");

    const exitCode = await runCli({
      argv: ["ws", "init", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(prompt).toHaveBeenCalledWith("Workspace name", "local-guided-source");
    expect(existsSync(join(root, "ws", "local-guided-source", "guided-source"))).toBe(true);
    select.mockRestore();
    multiSelect.mockRestore();
    confirm.mockRestore();
    prompt.mockRestore();
  });

  test("creates a workspace from a GitHub pull request URL on its source branch", async () => {
    const source = join(root, "pr-source.git");
    const seed = join(root, "pr-seed");
    await git.runGit(["init", "--bare", source]);
    await git.runGit(["init", "-b", "feature/pr-url", seed]);
    await git.runGit(["config", "user.name", "PR Workspace Test"], { cwd: seed });
    await git.runGit(["config", "user.email", "pr@example.com"], { cwd: seed });
    await writeFile(join(seed, "README.md"), "# pull request branch\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "feat: seed pull request branch"], { cwd: seed });
    await git.runGit(["remote", "add", "origin", source], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "feature/pr-url"], { cwd: seed });

    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: 100,
        number: 52,
        title: "Make transitions deterministic",
        state: "open",
        head: {
          ref: "feature/pr-url",
          repo: { name: "contributor-fork", clone_url: source },
        },
        base: { ref: "main" },
      }),
    );

    const exitCode = await runCli({
      argv: [
        "ws",
        "init",
        "https://github.com/gabrielmoreira/tiny-asl-machine/pull/52",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      isTTY: false,
    });

    const workspaceName = "pr-52-tiny-asl-machine-feature-pr-url";
    const workspacePath = join(root, "ws", workspaceName);
    expect(exitCode).toBe(0);
    expect(existsSync(join(workspacePath, "tiny-asl-machine", "README.md"))).toBe(true);
    const workspace = await manifest.readWorkspace(join(workspacePath, "ws.md"));
    expect(workspace.manifest.description).toBe("Continue PR #52: Make transitions deterministic");
    expect(workspace.manifest.mounts[0]).toMatchObject({
      path: "tiny-asl-machine",
      source,
      revision: { mode: "track", branch: "feature/pr-url" },
    });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRestore();
  });

  test("creates a workspace from an Azure DevOps pull request URL on its source branch", async () => {
    const source = join(root, "ado-pr-source.git");
    const seed = join(root, "ado-pr-seed");
    await git.runGit(["init", "--bare", source]);
    await git.runGit(["init", "-b", "users/gabriel/update-auth", seed]);
    await git.runGit(["config", "user.name", "ADO PR Workspace Test"], { cwd: seed });
    await git.runGit(["config", "user.email", "ado-pr@example.com"], { cwd: seed });
    await writeFile(join(seed, "README.md"), "# Azure pull request branch\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "feat: seed Azure pull request branch"], { cwd: seed });
    await git.runGit(["remote", "add", "origin", source], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "users/gabriel/update-auth"], { cwd: seed });

    let authorization = "";
    const request = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return Response.json({
        pullRequestId: 18637,
        status: "active",
        title: "Update authentication flow",
        sourceRefName: "refs/heads/users/gabriel/update-auth",
        targetRefName: "refs/heads/main",
        creationDate: "2026-09-18T00:00:00Z",
        url: "https://dev.azure.com/nn-apps/retail-app/_apis/git/pullRequests/18637",
        repository: {
          id: "repo-id",
          name: "retail-app-bff-monorepo",
          remoteUrl: source,
        },
      });
    }) as typeof fetch);

    const exitCode = await runCli({
      argv: [
        "ws",
        "init",
        "https://dev.azure.com/nn-apps/retail-app/_git/retail-app-bff-monorepo/pullrequest/18637",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: { AZURE_DEVOPS_PAT: "test-pat" },
      isTTY: false,
    });

    const workspaceName = "pr-18637-retail-app-bff-monorepo-users-gabriel-update-auth";
    const workspacePath = join(root, "ws", workspaceName);
    expect(exitCode).toBe(0);
    expect(existsSync(join(workspacePath, "retail-app-bff-monorepo", "README.md"))).toBe(true);
    const workspace = await manifest.readWorkspace(join(workspacePath, "ws.md"));
    expect(workspace.manifest.mounts[0]).toMatchObject({
      path: "retail-app-bff-monorepo",
      source,
      revision: { mode: "track", branch: "users/gabriel/update-auth" },
    });
    expect(authorization).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
    request.mockRestore();
  });
  test("creates workspaces under the configured workspace prefix", async () => {
    await writeFile(
      join(root, "dev.yaml"),
      ["version: 1", "defaults:", "  workspace_prefix: tasks/", ""].join("\n"),
    );

    const exitCode = await runCli({
      argv: ["ws", "init", "prefixed-workspace", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(root, "tasks", "prefixed-workspace", "ws.md"))).toBe(true);
    expect(existsSync(join(root, "ws", "prefixed-workspace"))).toBe(false);
  });

  test("returns structured required-input details instead of prompting in JSON mode", async () => {
    const exitCode = await runCli({
      argv: ["ws", "init", "--root", root, "--json"],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('"code": "INTERACTION_REQUIRED"');
    expect(errors.join("\n")).toContain('"field": "name"');
    expect(errors.join("\n")).toContain("dev ws init <name|repository-uri|pull-request-url>");
  });

  test("selects a workspace when interactive context is ambiguous", async () => {
    for (const name of ["first-workspace", "second-workspace"]) {
      expect(
        await runCli({
          argv: ["ws", "init", name, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
    }

    const prompt = spyOn(ui, "select").mockResolvedValue("second-workspace");
    const exitCode = await runCli({
      argv: ["ws", "status", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Workspace: second-workspace");
    prompt.mockRestore();
  });

  test("prompts with fuzzy workspace matches when a query is ambiguous", async () => {
    for (const name of ["adobe-edge-poc", "adobe-mobile-review", "payments-review"]) {
      expect(
        await runCli({
          argv: ["ws", "init", name, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
    }

    const select = spyOn(ui, "select").mockResolvedValueOnce("adobe-edge-poc");
    const workspace = await resolveWorkspaceInput({
      value: "adob",
      fuzzyValue: true,
      root,
      command: "ws start",
      usage: "dev ws start [name]",
      ambient: { argv: [], cwd: root, env: {}, isTTY: true, stdinIsTTY: true },
    });

    expect(select.mock.calls[0]?.[1].map((option) => option.value)).toEqual([
      "adobe-edge-poc",
      "adobe-mobile-review",
    ]);
    expect(workspace).toEqual({ value: "adobe-edge-poc", source: "prompt" });
    select.mockRestore();
  });
  test("go selects recent workspaces and resolves a fuzzy name query", async () => {
    for (const [name, createdAt] of [
      ["older-workspace", "2026-09-01T00:00:00.000Z"],
      ["newest-workspace", "2026-09-03T00:00:00.000Z"],
      ["middle-workspace", "2026-09-02T00:00:00.000Z"],
    ]) {
      expect(
        await runCli({
          argv: ["ws", "init", name, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
      const manifestPath = join(root, "ws", name, "ws.md");
      const workspace = await manifest.readWorkspace(manifestPath);
      workspace.manifest.created_at = createdAt;
      await manifest.writeWorkspace(manifestPath, workspace.manifest, workspace.body);
    }

    logs = [];
    const prompt = spyOn(ui, "select").mockResolvedValue("newest-workspace");
    expect(
      await runCli({
        argv: ["go", "--root", root],
        cwd: root,
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);
    expect(prompt.mock.calls[0]?.[1].map((option) => option.value)).toEqual([
      "newest-workspace",
      "middle-workspace",
      "older-workspace",
    ]);
    expect(logs).toEqual([join(root, "ws", "newest-workspace")]);

    logs = [];
    expect(
      await runCli({
        argv: ["go", "oldw", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs).toEqual([join(root, "ws", "older-workspace")]);
    prompt.mockRestore();

    logs = [];
    expect(
      await runCli({
        argv: ["go", "--candidates", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs.join("\n").split("\n")).toEqual([
      join(root, "ws", "newest-workspace"),
      join(root, "ws", "middle-workspace"),
      join(root, "ws", "older-workspace"),
    ]);
  });

  test("mounts every repository selected by the searchable multi-select", async () => {
    const sources: string[] = [];
    for (const name of ["repository-a", "repository-b"]) {
      const source = join(root, `${name}.git`);
      const seed = join(root, `${name}-seed`);
      await git.runGit(["init", "--bare", "-b", "main", source]);
      await git.runGit(["init", "-b", "main", seed]);
      await git.runGit(["config", "user.name", "Test Agent"], { cwd: seed });
      await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seed });
      await writeFile(join(seed, "README.md"), `# ${name}\n`);
      await git.runGit(["add", "."], { cwd: seed });
      await git.runGit(["commit", "-m", "initial"], { cwd: seed });
      await git.runGit(["remote", "add", "origin", source], { cwd: seed });
      await git.runGit(["push", "origin", "main"], { cwd: seed });
      await git.runGit(["checkout", "-b", `feature/${name}`], { cwd: seed });
      await writeFile(join(seed, "feature.txt"), name);
      await git.runGit(["add", "."], { cwd: seed });
      await git.runGit(["commit", "-m", "feature"], { cwd: seed });
      await git.runGit(["push", "origin", `feature/${name}`], { cwd: seed });
      sources.push(source);
    }
    await cache.writeInventory({
      root,
      tenant: "local",
      records: sources.map((url, index) => ({
        id: String(index),
        name: `repository-${index === 0 ? "a" : "b"}`,
        url,
        default_branch: "main",
        description: "",
        last_changed: "",
        syncedAt: "",
      })),
    });
    expect(
      await runCli({
        argv: ["ws", "init", "multi-repository", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    const multiPrompt = spyOn(ui, "multiSelect")
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce(["0"]);
    const branchPrompt = spyOn(ui, "select")
      .mockResolvedValueOnce("feature/repository-a")
      .mockResolvedValueOnce("main");
    const pathPrompt = spyOn(ui, "text")
      .mockResolvedValueOnce("repository-a-feature")
      .mockResolvedValueOnce("repository-a-main");
    const confirmPrompt = spyOn(ui, "confirm")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const exitCode = await runCli({
      argv: ["ws", "add", "--ws", "multi-repository", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    const workspaceManifest = await manifest.readWorkspace(
      join(root, "ws", "multi-repository", "ws.md"),
    );
    expect(
      workspaceManifest.manifest.mounts.map((mount) => [
        mount.path,
        mount.revision.mode === "track" ? mount.revision.branch : undefined,
      ]),
    ).toEqual([
      ["repository-a-feature", "feature/repository-a"],
      ["repository-a-main", "main"],
      ["repository-b", "main"],
    ]);
    expect(logs.join("\n")).toContain("Selected mounts");
    expect(logs.join("\n")).toContain("Final mount plan");
    confirmPrompt.mockRestore();
    pathPrompt.mockRestore();
    branchPrompt.mockRestore();
    multiPrompt.mockRestore();
  });

  test("prompts for a repository source before mounting", async () => {
    expect(
      await runCli({
        argv: ["ws", "init", "guided-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    const prompt = spyOn(ui, "text").mockResolvedValue(process.cwd());
    const exitCode = await runCli({
      argv: ["ws", "add", "--ws", "guided-workspace", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Mounted repository 'dev-cli'");
    prompt.mockRestore();
  });

  test("returns the selected mount path from the interactive workspace picker", async () => {
    expect(
      await runCli({
        argv: ["ws", "init", "picked-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(
      await runCli({
        argv: ["ws", "add", process.cwd(), "--ws", "picked-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    logs = [];
    expect(
      await runCli({
        argv: ["ws", "pick", "--root", root],
        cwd: root,
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);
    expect(logs).toEqual([join(root, "ws", "picked-workspace", "dev-cli")]);
  });

  test("selects a bounded repository candidate before asking for manual input", async () => {
    expect(
      await runCli({
        argv: ["ws", "init", "inventory-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    await cache.writeInventory({
      root,
      tenant: "local/test",
      records: [
        {
          id: "selected",
          name: "dev-cli",
          url: process.cwd(),
          default_branch: "main",
          description: "Selected repository",
          last_changed: "2026-09-16T00:00:00Z",
          syncedAt: "2026-09-16T00:00:00Z",
        },
        {
          id: "other",
          name: "other-repository",
          url: join(root, "other.git"),
          default_branch: "main",
          description: "Other repository",
          last_changed: "2026-09-16T00:00:00Z",
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });

    const select = spyOn(ui, "multiSelect")
      .mockResolvedValueOnce([process.cwd()])
      .mockResolvedValueOnce(["defaults"]);
    const text = spyOn(ui, "text").mockResolvedValue(undefined);
    const confirm = spyOn(ui, "confirm").mockResolvedValue(true);
    const exitCode = await runCli({
      argv: ["ws", "add", "--ws", "inventory-workspace", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(select).toHaveBeenCalledTimes(2);
    expect(text).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Selected mounts");
    expect(logs.join("\n")).toContain("Final mount plan");
    confirm.mockRestore();
    select.mockRestore();
    text.mockRestore();
  });

  test("selects a source workspace and prompts for a duplicate name", async () => {
    for (const name of ["first-workspace", "second-workspace"]) {
      expect(
        await runCli({
          argv: ["ws", "init", name, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
    }

    const sourcePrompt = spyOn(ui, "select").mockResolvedValue("second-workspace");
    const namePrompt = spyOn(ui, "text").mockResolvedValue("copied-workspace");
    const exitCode = await runCli({
      argv: ["ws", "duplicate", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain(
      "Duplicated workspace 'second-workspace' to 'copied-workspace'",
    );
    sourcePrompt.mockRestore();
    namePrompt.mockRestore();
  });

  test("cancels workspace removal when confirmation is declined", async () => {
    expect(
      await runCli({
        argv: ["ws", "init", "safe-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    const prompt = spyOn(ui, "confirm").mockResolvedValue(false);
    const exitCode = await runCli({
      argv: ["ws", "remove", "missing-mount", "--ws", "safe-workspace", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(errors.join("\n")).toContain("Cancelled.");

    prompt.mockRestore();
  });
  test("requires an explicit mount or --all for non-interactive bulk actions", async () => {
    expect(
      await runCli({
        argv: ["ws", "init", "scoped-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    const exitCode = await runCli({
      argv: ["ws", "lock", "--ws", "scoped-workspace", "--root", root, "--json"],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('"field": "mount"');
    expect(errors.join("\n")).toContain("--all");
  });

  test("does not probe invented ADO projects during a default work-item list", async () => {
    await writeFile(
      join(root, "dev.yaml"),
      [
        "azure_devops:",
        "  token: test-token",
        "providers:",
        "  - id: ado-example",
        "    type: azure_devops",
        "    organization: example-org",
        "",
      ].join("\n"),
    );
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ workItems: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const exitCode = await runCli({
      argv: ["wi", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("dev wi --refresh");
    request.mockRestore();
  });

  test("uses dev-cli labels as pull-request worksets", async () => {
    const repositoryUrl = "https://dev.azure.com/example-org/Payments/_git/payments-api";
    await writeFile(
      join(root, "dev.yaml"),
      [
        "azure_devops:",
        "  token: test-token",
        "providers:",
        "  - id: ado-example",
        "    type: azure_devops",
        "    organization: example-org",
        "sources:",
        `  - url: ${repositoryUrl}`,
        "    labels:",
        "      review-workset: {}",
        "",
      ].join("\n"),
    );
    await cache.writeInventory({
      root,
      tenant: "dev.azure.com/example-org",
      records: [
        {
          id: "repo-1",
          name: "payments-api",
          url: repositoryUrl,
          default_branch: "main",
          description: "Payments API",
          last_changed: "2026-09-16T00:00:00Z",
          syncedAt: "2026-09-16T00:00:00Z",
          project: "Payments",
        },
      ],
    });
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          value: [
            {
              pullRequestId: 42,
              status: "active",
              title: "Review payment change",
              sourceRefName: "refs/heads/feature",
              targetRefName: "refs/heads/main",
              creationDate: "2026-09-16T00:00:00Z",
              url: `${repositoryUrl}/pullRequests/42`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const exitCode = await runCli({
      argv: ["pr", "--label", "review-workset", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    expect(String(request.mock.calls[0]?.[0])).toContain(
      "/Payments/_apis/git/repositories/repo-1/pullrequests",
    );
    expect(logs.join("\n")).toContain("payments-api");
    request.mockRestore();
  });

  test("selects a registered root when dev use has no target", async () => {
    const first = join(root, "first-root");
    const second = join(root, "second-root");
    await writeFile(
      join(root, ".dev.toml"),
      ["[roots.first]", `path = "${first}"`, "", "[roots.second]", `path = "${second}"`, ""].join(
        "\n",
      ),
    );
    const select = spyOn(ui, "select").mockResolvedValue("second");

    const exitCode = await runCli({
      argv: ["use"],
      cwd: root,
      env: { HOME: root },
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(logs.at(-1)).toContain(`export DEV_ROOT="${second}"`);
    select.mockRestore();
  });

  test("treats argument-free qmd sync with no index labels as an empty state", async () => {
    const exitCode = await runCli({
      argv: ["qmd", "sync", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    const narration = errors.join("\n");
    expect(narration).toContain("nothing to index");
    expect(narration).toContain("dev mirror label add <source> index:docs");
  });

  test("prompts for a repository source before creating a mirror", async () => {
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await git.runGit(["init", "--bare", remote]);
    await git.runGit(["init", "-b", "main", seed]);
    await git.runGit(["config", "user.name", "CLI Test"], { cwd: seed });
    await git.runGit(["config", "user.email", "cli@example.com"], { cwd: seed });
    await writeFile(join(seed, "file.txt"), "mirror input");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "test: seed mirror"], { cwd: seed });
    await git.runGit(["remote", "add", "origin", remote], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "main"], { cwd: seed });

    const prompt = spyOn(ui, "text").mockResolvedValue(remote);
    await git.runGit(["checkout", "-b", "feature"], { cwd: seed });
    await git.runGit(["push", "-u", "origin", "feature"], { cwd: seed });
    const exitCode = await runCli({
      argv: ["mirror", "add", "--branch", "main", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("✓ Mirrored ");
    prompt.mockRestore();

    logs = [];
    const pickExitCode = await runCli({
      argv: ["mirror", "pick", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });
    expect(pickExitCode).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.startsWith(root)).toBe(true);

    const branchPrompt = spyOn(ui, "text").mockResolvedValue("feature");
    const trackExitCode = await runCli({
      argv: ["mirror", "track", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(trackExitCode).toBe(0);
    expect(logs.join("\n")).toContain("✓ Tracking feature");
    branchPrompt.mockRestore();

    const branchPromptForUntrack = spyOn(ui, "text").mockResolvedValue("feature");
    const confirmationPrompt = spyOn(ui, "confirm").mockResolvedValue(false);
    const untrackExitCode = await runCli({
      argv: ["mirror", "untrack", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(untrackExitCode).toBe(0);
    expect(errors.join("\n")).toContain("Cancelled.");
    branchPromptForUntrack.mockRestore();
    confirmationPrompt.mockRestore();
  });

  test("guides provider creation and protects removal", async () => {
    const typePrompt = spyOn(ui, "select").mockResolvedValue("ado");
    const organizationPrompt = spyOn(ui, "text").mockResolvedValue("example-org");
    const addExitCode = await runCli({
      argv: ["provider", "add", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(addExitCode).toBe(0);
    expect(logs.join("\n")).toContain("Registered provider 'ado-example-org'");
    typePrompt.mockRestore();
    organizationPrompt.mockRestore();

    const removePrompt = spyOn(ui, "confirm").mockResolvedValue(false);
    const removeExitCode = await runCli({
      argv: ["provider", "remove", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(removeExitCode).toBe(0);
    expect(errors.join("\n")).toContain("Cancelled.");
    removePrompt.mockRestore();
  });

  test("opens the only cached pull request and work item without IDs", async () => {
    const tenant = "dev.azure.com/example";
    await cache.writePullRequests({
      root,
      tenant,
      repo: "sample-repo",
      records: [
        {
          id: 42,
          title: "Improve CLI context",
          description: "Details",
          status: "open",
          sourceBranch: "feature/context",
          targetBranch: "main",
          author: "Developer",
          url: "https://example.test/pr/42",
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: "2026-09-16T00:00:00Z",
          isDraft: false,
          repository: "sample-repo",
          tenant,
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });
    await cache.writeWorkItems({
      root,
      tenant,
      project: "sample-project",
      records: [
        {
          id: 84,
          type: "Task",
          title: "Verify smart views",
          state: "Active",
          url: "https://example.test/wi/84",
          tenant,
          project: "sample-project",
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });

    expect(
      await runCli({
        argv: ["pr", "view", "--offline", "--root", root],
        cwd: root,
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("Pull Request #42: Improve CLI context");

    expect(
      await runCli({
        argv: ["wi", "view", "--offline", "--root", root],
        cwd: root,
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("Work Item #84: Verify smart views");
  });

  test("checks out the PR source branch by default and isolates only explicit reviews", async () => {
    const remote = join(root, "review-source.git");
    const seed = join(root, "review-seed");
    await git.runGit(["init", "--bare", "-b", "main", remote]);
    await git.runGit(["init", "-b", "main", seed]);
    await git.runGit(["config", "user.name", "Test Agent"], { cwd: seed });
    await git.runGit(["config", "user.email", "agent@example.com"], { cwd: seed });
    await writeFile(join(seed, "README.md"), "# Review source\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "initial"], { cwd: seed });
    await git.runGit(["remote", "add", "origin", remote], { cwd: seed });
    await git.runGit(["push", "origin", "main"], { cwd: seed });
    await git.runGit(["checkout", "-b", "feature/review"], { cwd: seed });
    await writeFile(join(seed, "feature.txt"), "review me\n");
    await git.runGit(["add", "."], { cwd: seed });
    await git.runGit(["commit", "-m", "feature"], { cwd: seed });
    await git.runGit(["push", "origin", "feature/review"], { cwd: seed });

    await cache.writeInventory({
      root,
      tenant: "dev.azure.com/example-org",
      records: [
        {
          id: "review-source",
          name: "review-source",
          url: remote,
          default_branch: "main",
          description: "",
          last_changed: "",
          syncedAt: "",
        },
      ],
    });
    await cache.writePullRequests({
      root,
      tenant: "dev.azure.com/example-org",
      repo: "review-source",
      records: [
        {
          id: 42,
          title: "Improve review flow",
          description: "",
          status: "open",
          sourceBranch: "feature/review",
          targetBranch: "main",
          author: "Developer",
          url: "https://example.test/pr/42",
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: "2026-09-16T00:00:00Z",
          isDraft: false,
          repository: "review-source",
          tenant: "dev.azure.com/example-org",
          syncedAt: "2026-09-16T00:00:00Z",
        },
        {
          id: 43,
          title: "Review URL checkout",
          description: "",
          status: "open",
          sourceBranch: "feature/review",
          targetBranch: "main",
          author: "Developer",
          url: "https://dev.azure.com/example-org/sample-project/_git/review-source/pullrequest/43",
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: "2026-09-16T00:00:00Z",
          isDraft: false,
          repository: "review-source",
          tenant: "dev.azure.com/example-org",
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });

    expect(
      await runCli({
        argv: ["pr", "checkout", "42", "--review", "--name", "review-pr", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    const review = await manifest.readWorkspace(join(root, "ws", "review-pr", "ws.md"));
    expect(review.manifest.mounts[0].revision).toEqual({
      mode: "track",
      branch: "review/42-improve-review-flow",
      upstream: "feature/review",
    });

    expect(
      await runCli({
        argv: ["pr", "checkout", "42", "--name", "source-pr", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    const sourceCheckout = await manifest.readWorkspace(join(root, "ws", "source-pr", "ws.md"));
    expect(sourceCheckout.manifest.mounts[0].revision).toEqual({
      mode: "track",
      branch: "feature/review",
      upstream: undefined,
    });

    const checkoutPrompt = spyOn(ui, "select").mockResolvedValueOnce("0");
    expect(
      await runCli({
        argv: ["pr", "checkout", "--name", "prompted-pr", "--root", root],
        cwd: root,
        env: {},
        isTTY: true,
        stdinIsTTY: true,
      }),
    ).toBe(0);
    expect(existsSync(join(root, "ws", "prompted-pr", "ws.md"))).toBe(true);
    checkoutPrompt.mockRestore();

    expect(
      await runCli({
        argv: [
          "pr",
          "checkout",
          "https://dev.azure.com/example-org/sample-project/_git/review-source/pullrequest/43",
          "--review",
          "--name",
          "url-review",
          "--root",
          root,
        ],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    const urlReview = await manifest.readWorkspace(join(root, "ws", "url-review", "ws.md"));
    expect(urlReview.manifest.mounts[0].revision).toEqual({
      mode: "track",
      branch: "review/43-review-url-checkout",
      upstream: "feature/review",
    });
    const uncachedRequest = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        pullRequestId: 44,
        status: "active",
        title: "Uncached URL checkout",
        sourceRefName: "refs/heads/feature/review",
        targetRefName: "refs/heads/main",
        creationDate: "2026-09-16T00:00:00Z",
        url: "https://dev.azure.com/example-org/sample-project/_git/review-source/pullrequest/44",
        createdBy: { displayName: "Developer" },
      }),
    );
    expect(
      await runCli({
        argv: [
          "pr",
          "checkout",
          "https://dev.azure.com/example-org/sample-project/_git/review-source/pullrequest/44",
          "--review",
          "--name",
          "uncached-url-review",
          "--root",
          root,
        ],
        cwd: root,
        env: { AZURE_DEVOPS_PAT: "test-token" },
        isTTY: false,
      }),
    ).toBe(0);
    expect(String(uncachedRequest.mock.calls[0]?.[0])).toContain(
      "/sample-project/_apis/git/repositories/review-source/pullrequests/44",
    );
    uncachedRequest.mockRestore();
  });

  test("lists cached pull requests without network access unless refresh is requested", async () => {
    const tenant = "dev.azure.com/example-org";
    await writeFile(
      join(root, "dev.yaml"),
      [
        "version: 1",
        "providers:",
        "  - id: ado-example",
        "    type: azure_devops",
        "    organization: example-org",
        "    project: sample-project",
        "",
      ].join("\n"),
    );
    await cache.writePullRequestSelection({
      root,
      tenant,
      name: "mine-open",
      records: [
        {
          id: 42,
          title: "Cached pull request",
          description: "",
          status: "open",
          sourceBranch: "feature/cached",
          targetBranch: "main",
          author: "Developer",
          url: "https://example.test/pr/42",
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: "2026-09-16T00:00:00Z",
          isDraft: false,
          repository: "sample-repo",
          tenant,
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });
    const request = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("default PR listing must not use the network"),
    );

    const exitCode = await runCli({
      argv: ["pr", "--root", root],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Cached pull request");
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  test("summarizes inventory sync without dumping repository records", async () => {
    await cache.writeInventory({
      root,
      tenant: "dev.azure.com/example",
      records: [
        {
          id: "one",
          name: "repository-one",
          url: "https://example.test/repository-one.git",
          default_branch: "main",
          description: "One",
          last_changed: "2026-09-16T00:00:00Z",
          syncedAt: "2026-09-16T00:00:00Z",
        },
        {
          id: "two",
          name: "repository-two",
          url: "https://example.test/repository-two.git",
          default_branch: "main",
          description: "Two",
          last_changed: "2026-09-16T00:00:00Z",
          syncedAt: "2026-09-16T00:00:00Z",
        },
      ],
    });

    expect(
      await runCli({
        argv: ["sync", "inventory", "--offline", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toBe("Offline mode: 2 repositories from local cache.");
  });

  test("requires sync data provider and project disambiguation", async () => {
    for (const organization of ["first-org", "second-org"]) {
      expect(
        await runCli({
          argv: ["provider", "add", "ado", "--org", organization, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
    }

    errors = [];
    expect(
      await runCli({
        argv: ["sync", "data", "--json", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain('"field": "provider"');

    errors = [];
    expect(
      await runCli({
        argv: ["sync", "data", "--provider", "ado-first-org", "--json", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain('"field": "project"');
  });

  test("supports root ls and ws create aliases", async () => {
    expect(
      await runCli({
        argv: ["ws", "create", "alias-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);

    logs = [];
    expect(
      await runCli({
        argv: ["ls", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("alias-workspace");
  });

  test("accepts workspace selection before and after root shortcuts", async () => {
    for (const name of ["first-workspace", "second-workspace"]) {
      expect(
        await runCli({
          argv: ["ws", "init", name, "--root", root],
          cwd: root,
          env: {},
          isTTY: false,
        }),
      ).toBe(0);
    }

    logs = [];
    expect(
      await runCli({
        argv: ["--ws", "second-workspace", "status", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("Workspace: second-workspace");

    logs = [];
    expect(
      await runCli({
        argv: ["status", "--ws", "first-workspace", "--root", root],
        cwd: root,
        env: {},
        isTTY: false,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain("Workspace: first-workspace");
  });

  test("reports missing input when a text prompt returns no value", async () => {
    const select = spyOn(ui, "select").mockResolvedValueOnce("blank");
    const prompt = spyOn(ui, "text").mockResolvedValue(undefined);
    const exitCode = await runCli({
      argv: ["ws", "create", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Workspace name is required");
    prompt.mockRestore();
    select.mockRestore();
  });
});
