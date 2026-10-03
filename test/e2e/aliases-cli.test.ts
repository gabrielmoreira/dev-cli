import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const INITIAL = `version: 1
worksets:
  incident:
    description: Fixture objective
    members:
      - source: https://example.test/api.git
        ref: main
        path: api
      - source: https://example.test/web.git
        ref: main
        path: web
      - label: docs
        reason: Fixture docs
`;

describe("CLI list/remove aliases", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-alias-cli-"));
    await writeFile(join(root, "dev.yaml"), INITIAL);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args, "--root", root], {
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
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it("lists the same worksets through list, ls, and the bare group", async () => {
    const expected = [{ name: "incident", description: "Fixture objective", memberCount: 3 }];
    for (const args of [
      ["workset", "list", "--json"],
      ["--json", "workset", "ls"],
      ["workset", "--json"],
    ]) {
      const result = await run(args);
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
    expect(await readFile(join(root, "dev.yaml"), "utf8")).toBe(INITIAL);
  });

  it.each([
    {
      group: "repo",
      target: "api",
      remaining: [
        { source: "https://example.test/web.git", ref: "main", path: "web" },
        { label: "docs", reason: "Fixture docs" },
      ],
    },
    {
      group: "label",
      target: "docs",
      remaining: [
        { source: "https://example.test/api.git", ref: "main", path: "api" },
        { source: "https://example.test/web.git", ref: "main", path: "web" },
      ],
    },
  ])(
    "removes the same $group member with remove and rm without weakening confirmation",
    async ({ group, target, remaining }) => {
      for (const verb of ["remove", "rm"]) {
        await writeFile(join(root, "dev.yaml"), INITIAL);
        const refused = await run(["workset", group, verb, "incident", target, "--json"]);
        expect(refused.exitCode).toBe(2);
        expect(refused.stdout).toBe("");
        expect(JSON.parse(refused.stderr).error.code).toBe("INTERACTION_REQUIRED");
        expect(await readFile(join(root, "dev.yaml"), "utf8")).toBe(INITIAL);
        const result = await run(["workset", group, verb, "incident", target, "--force", "--json"]);
        expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          exitCode: 0,
          stderr: "",
        });
        expect(JSON.parse(result.stdout)).toMatchObject({ name: "incident", members: remaining });
        const persisted = yaml.parse(await readFile(join(root, "dev.yaml"), "utf8"));
        expect(persisted.worksets.incident.members).toEqual(remaining);
        expect(persisted.worksets.incident.description).toBe("Fixture objective");
      }
    },
  );

  it("makes aliases visible through the public agent schema", async () => {
    const result = await run(["--help", "--llms"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const commands = JSON.parse(result.stdout).commands;
    expect(commands.find((command: { name: string }) => command.name === "update")).toMatchObject({
      name: "update",
      description: expect.stringContaining("Converge mounts"),
    });
    const workset = commands.find((command: { name: string }) => command.name === "workset");
    const list = workset.subcommands.find((command: { name: string }) => command.name === "list");
    expect(list.aliases).toContain("ls");
    for (const group of ["repo", "label"]) {
      const members = workset.subcommands.find(
        (command: { name: string }) => command.name === group,
      );
      const remove = members.subcommands.find(
        (command: { name: string }) => command.name === "remove",
      );
      expect(remove.aliases).toContain("rm");
    }
  });

  it("keeps root update workspace selection after argv rewrite removal", async () => {
    for (const name of ["alpha", "beta"]) {
      const result = await run(["ws", "init", name, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).name).toBe(name);
    }
    for (const args of [
      ["update", "--ws", "beta", "--offline", "--json"],
      ["--json", "update", "--ws=beta", "--offline"],
      ["--json", "update", "--ws", "beta", "--offline"],
      ["ws", "update", "--ws", "beta", "--offline", "--json"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ workspaceName: "beta", mounts: [] });
    }
    const help = await run(["help", "update"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("USAGE dev update");
  });
});
