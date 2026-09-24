import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";
import { runCli } from "../../src/cli";
import * as fs from "../../src/fs.ts";
import { ui } from "../../src/ui.ts";

interface TestConfig {
  worksets?: Record<
    string,
    {
      description?: string;
      members: Array<{ source: string; ref?: string; path?: string; reason?: string }>;
    }
  >;
}

describe("workset management", () => {
  let root: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-cli-workset-management-"));
    originalLog = console.log;
    originalError = console.error;
    logs = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    await fs.writeText(
      join(root, "dev.yaml"),
      `# Root Configuration
version: 1
plugins:
  qmd:
    command: qmd
`,
    );
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  });

  test("creates a workset without disturbing unrelated YAML", async () => {
    const code = await runCli({
      argv: [
        "workset",
        "create",
        "incident",
        "https://github.com/example/checkout-api.git",
        "--description",
        "Checkout incident context",
        "--ref",
        "main",
        "--path",
        "checkout-api",
        "--reason",
        "Service under investigation",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const content = await fs.readText(join(root, "dev.yaml"));
    expect(content).toContain("# Root Configuration");
    const config = yaml.parse(content) as TestConfig;
    expect(config.worksets?.incident).toEqual({
      description: "Checkout incident context",
      members: [
        {
          source: "https://github.com/example/checkout-api.git",
          ref: "main",
          path: "checkout-api",
          reason: "Service under investigation",
        },
      ],
    });
    expect((config as Record<string, unknown>).plugins).toEqual({ qmd: { command: "qmd" } });
  });
  test("renames a workset without copying it", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `# Root Configuration
version: 1
worksets:
  incident:
    description: Checkout incident context
    members:
      - source: https://github.com/example/checkout-api.git
plugins:
  qmd:
    command: qmd
`,
    );

    const code = await runCli({
      argv: ["workset", "rename", "incident", "checkout-outage", "--root", root, "--json"],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident).toBeUndefined();
    expect(config.worksets?.["checkout-outage"]).toEqual({
      description: "Checkout incident context",
      members: [{ source: "https://github.com/example/checkout-api.git" }],
    });
  });

  test("refuses to overwrite an existing workset during rename", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
  payments:
    members:
      - source: https://github.com/example/payments-api.git
`,
    );

    const code = await runCli({
      argv: ["workset", "rename", "incident", "payments", "--root", root, "--json"],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(1);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(Object.keys(config.worksets ?? {})).toEqual(["incident", "payments"]);
  });

  test("adds a repository to an existing workset", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
`,
    );

    const code = await runCli({
      argv: [
        "workset",
        "repo",
        "add",
        "incident",
        "https://github.com/example/runbooks.git",
        "--ref",
        "main",
        "--path",
        "runbooks",
        "--reason",
        "Operational procedures",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members).toEqual([
      { source: "https://github.com/example/checkout-api.git" },
      {
        source: "https://github.com/example/runbooks.git",
        ref: "main",
        path: "runbooks",
        reason: "Operational procedures",
      },
    ]);
  });

  test("edits only the requested repository fields", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        ref: main
        path: checkout-api
        reason: Service under investigation
`,
    );

    const code = await runCli({
      argv: [
        "workset",
        "repo",
        "edit",
        "incident",
        "checkout-api",
        "--ref",
        "release",
        "--reason",
        "Release incident owner",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members[0]).toEqual({
      source: "https://github.com/example/checkout-api.git",
      ref: "release",
      path: "checkout-api",
      reason: "Release incident owner",
    });
  });

  test("removes only the selected repository", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        path: checkout-api
      - source: https://github.com/example/runbooks.git
        path: runbooks
`,
    );

    const code = await runCli({
      argv: [
        "workset",
        "repo",
        "remove",
        "incident",
        "runbooks",
        "--force",
        "--root",
        root,
        "--json",
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members).toEqual([
      { source: "https://github.com/example/checkout-api.git", path: "checkout-api" },
    ]);
  });

  test("refuses to remove the final repository from a workset", async () => {
    const initial = `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        path: checkout-api
`;
    await fs.writeText(join(root, "dev.yaml"), initial);

    const code = await runCli({
      argv: [
        "workset",
        "repo",
        "remove",
        "incident",
        "checkout-api",
        "--force",
        "--json",
        "--root",
        root,
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(1);
    expect(logs.join("\n")).toContain('"code": "WORKSET_LAST_MEMBER"');
    expect(await fs.readText(join(root, "dev.yaml"))).toBe(initial);
  });

  test("creates a workset through one interactive manage transaction", async () => {
    const select = spyOn(ui, "select").mockResolvedValueOnce("add").mockResolvedValueOnce("save");
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("incident")
      .mockResolvedValueOnce("Checkout incident context")
      .mockResolvedValueOnce("https://github.com/example/checkout-api.git")
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("checkout-api")
      .mockResolvedValueOnce("Service under investigation");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "manage", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident).toEqual({
      description: "Checkout incident context",
      members: [
        {
          source: "https://github.com/example/checkout-api.git",
          ref: "main",
          path: "checkout-api",
          reason: "Service under investigation",
        },
      ],
    });

    select.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("applies several manage operations as one saved workset", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    description: Old description
    members:
      - source: https://github.com/example/checkout-api.git
        ref: main
        path: checkout-api
      - source: https://github.com/example/runbooks.git
        path: runbooks
`,
    );
    const select = spyOn(ui, "select")
      .mockResolvedValueOnce("rename")
      .mockResolvedValueOnce("description")
      .mockResolvedValueOnce("edit")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("remove")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("add")
      .mockResolvedValueOnce("save");
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("checkout-outage")
      .mockResolvedValueOnce("Checkout outage response")
      .mockResolvedValueOnce("release")
      .mockResolvedValueOnce("checkout-api")
      .mockResolvedValueOnce("Primary service")
      .mockResolvedValueOnce("https://github.com/example/skills.git")
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("skills")
      .mockResolvedValueOnce("Debugging playbooks");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "manage", "incident", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident).toBeUndefined();
    expect(config.worksets?.["checkout-outage"]).toEqual({
      description: "Checkout outage response",
      members: [
        {
          source: "https://github.com/example/checkout-api.git",
          ref: "release",
          path: "checkout-api",
          reason: "Primary service",
        },
        {
          source: "https://github.com/example/skills.git",
          ref: "main",
          path: "skills",
          reason: "Debugging playbooks",
        },
      ],
    });

    select.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("discards a manage draft without changing dev.yaml", async () => {
    const initial = `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
`;
    await fs.writeText(join(root, "dev.yaml"), initial);
    const select = spyOn(ui, "select")
      .mockResolvedValueOnce("rename")
      .mockResolvedValueOnce("discard");
    const text = spyOn(ui, "text").mockResolvedValueOnce("renamed-incident");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "manage", "incident", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    expect(await fs.readText(join(root, "dev.yaml"))).toBe(initial);
    select.mockRestore();
    text.mockRestore();
    confirm.mockRestore();
  });

  test("rejects a duplicate repository identity", async () => {
    const initial = `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        ref: main
        path: checkout-api
`;
    await fs.writeText(join(root, "dev.yaml"), initial);

    const code = await runCli({
      argv: [
        "workset",
        "repo",
        "add",
        "incident",
        "https://github.com/example/checkout-api.git",
        "--ref",
        "main",
        "--path",
        "checkout-api",
        "--json",
        "--root",
        root,
      ],
      cwd: root,
      env: {},
      isTTY: false,
    });

    expect(code).toBe(1);
    expect(logs.join("\n")).toContain('"code": "WORKSET_MEMBER_EXISTS"');
    expect(await fs.readText(join(root, "dev.yaml"))).toBe(initial);
  });

  test("resolves omitted create inputs interactively", async () => {
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("incident")
      .mockResolvedValueOnce("Checkout incident context")
      .mockResolvedValueOnce("https://github.com/example/checkout-api.git")
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("checkout-api")
      .mockResolvedValueOnce("Service under investigation");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "create", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members).toEqual([
      {
        source: "https://github.com/example/checkout-api.git",
        ref: "main",
        path: "checkout-api",
        reason: "Service under investigation",
      },
    ]);
    text.mockRestore();
    confirm.mockRestore();
  });
  test("resolves omitted rename inputs interactively", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
`,
    );
    const select = spyOn(ui, "select").mockResolvedValueOnce("incident");
    const text = spyOn(ui, "text").mockResolvedValueOnce("checkout-outage");

    const code = await runCli({
      argv: ["workset", "rename", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident).toBeUndefined();
    expect(config.worksets?.["checkout-outage"]).toBeDefined();
    select.mockRestore();
    text.mockRestore();
  });

  test("resolves omitted repository add inputs interactively", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
`,
    );
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("https://github.com/example/runbooks.git")
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("runbooks")
      .mockResolvedValueOnce("Operational procedures");

    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);
    const code = await runCli({
      argv: ["workset", "repo", "add", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members.at(-1)).toEqual({
      source: "https://github.com/example/runbooks.git",
      ref: "main",
      path: "runbooks",
      reason: "Operational procedures",
    });
    text.mockRestore();
    confirm.mockRestore();
  });
  test("resolves omitted repository edit inputs interactively", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        ref: main
        path: checkout-api
        reason: Original reason
`,
    );
    const text = spyOn(ui, "text")
      .mockResolvedValueOnce("release")
      .mockResolvedValueOnce("checkout-api")
      .mockResolvedValueOnce("Updated reason");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "repo", "edit", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members[0]).toEqual({
      source: "https://github.com/example/checkout-api.git",
      ref: "release",
      path: "checkout-api",
      reason: "Updated reason",
    });
    text.mockRestore();
    confirm.mockRestore();
  });
  test("resolves omitted repository remove inputs interactively", async () => {
    await fs.writeText(
      join(root, "dev.yaml"),
      `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        path: checkout-api
      - source: https://github.com/example/runbooks.git
        path: runbooks
`,
    );
    const select = spyOn(ui, "select").mockResolvedValueOnce("runbooks");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(true);

    const code = await runCli({
      argv: ["workset", "repo", "remove", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    const config = yaml.parse(await fs.readText(join(root, "dev.yaml"))) as TestConfig;
    expect(config.worksets?.incident?.members).toEqual([
      { source: "https://github.com/example/checkout-api.git", path: "checkout-api" },
    ]);
    select.mockRestore();
    confirm.mockRestore();
  });

  test("keeps the workset unchanged when repository removal is declined", async () => {
    const initial = `version: 1
worksets:
  incident:
    members:
      - source: https://github.com/example/checkout-api.git
        path: checkout-api
      - source: https://github.com/example/runbooks.git
        path: runbooks
`;
    await fs.writeText(join(root, "dev.yaml"), initial);
    const select = spyOn(ui, "select").mockResolvedValueOnce("runbooks");
    const confirm = spyOn(ui, "confirm").mockResolvedValueOnce(false);

    const code = await runCli({
      argv: ["workset", "repo", "remove", "--root", root],
      cwd: root,
      env: {},
      isTTY: true,
      stdinIsTTY: true,
    });

    expect(code).toBe(0);
    expect(await fs.readText(join(root, "dev.yaml"))).toBe(initial);
    select.mockRestore();
    confirm.mockRestore();
  });
});
