import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import * as ws from "../../src/ws.ts";
import * as herdr from "../../src/herdr.ts";

const fakeHerdr = `#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";

const raw = Bun.argv.slice(2);
await appendFile(process.env.HERDR_CALLS, JSON.stringify(raw) + "\\n");
const args = raw[0] === "--session" ? raw.slice(2) : raw;
const scenario = process.env.HERDR_SCENARIO;
const workspacePath = process.env.HERDR_WORKSPACE_PATH;
const response = (result) => console.log(JSON.stringify({ id: "test", result }));


if (args[0] === "session" && args[1] === "list") {
  const status = scenario === "server-down" ? "stopped" : "running";
  console.log("name     status   directory   socket");
  console.log("default  " + status + "  /herdr   /herdr/herdr.sock");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "server") {
  const calls = await readFile(process.env.HERDR_CALLS, "utf8");
  const running = scenario !== "server-down" || calls.includes('["server"]');
  console.log("status: " + (running ? "running" : "not running"));
} else if (args.length === 1 && args[0] === "server") {
  process.exit(0);
} else if (args[0] === "pane" && args[1] === "list") {
  const existing = scenario === "reuse" || scenario === "shell";
  response({
    type: "pane_list",
    panes: existing ? [{ pane_id: "w1:p1", workspace_id: "w1", cwd: workspacePath, agent: scenario === "reuse" ? "omp" : null }] : [],
  });
} else if (args[0] === "agent" && args[1] === "list") {
  const calls = await readFile(process.env.HERDR_CALLS, "utf8");
  const recovered = scenario === "timeout" && calls.includes('["agent","start"');
  const workspaceId = scenario === "reuse" ? "w1" : "w7";
  const paneId = scenario === "reuse" ? "w1:p1" : "w7:p1";
  response({
    type: "agent_list",
    agents: scenario === "reuse" || recovered ? [{ name: "payment-fix-omp", pane_id: paneId, workspace_id: workspaceId, cwd: workspacePath, agent: "omp", interactive_ready: true }] : [],
  });
} else if (args[0] === "workspace" && args[1] === "create") {
  response({
    type: "workspace_created",
    workspace: { workspace_id: "w7" },
    tab: { tab_id: "w7:t1" },
    root_pane: { pane_id: "w7:p1", workspace_id: "w7", cwd: workspacePath },
  });
} else if (args[0] === "agent" && args[1] === "start") {
  if (scenario === "timeout") {
    console.error("agent_not_ready: startup timed out");
    process.exit(1);
  }
  response({
    type: "agent_started",
    agent: { name: args[2], pane_id: scenario === "shell" ? "w1:p1" : "w7:p1", workspace_id: scenario === "shell" ? "w1" : "w7", cwd: workspacePath, agent: "omp", interactive_ready: true },
    argv: ["omp"],
  });
} else if (args[0] === "workspace" && args[1] === "focus") {
  response({ type: "workspace_info", workspace: { workspace_id: args[2] } });
} else {
  console.error("Unexpected fake herdr command: " + args.join(" "));
  process.exit(2);
}
`;

describe("dev ws start CLI", () => {
  let tempRoot: string;
  let binDir: string;
  let callsPath: string;
  let workspacePath: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dev-cli-herdr-"));
    binDir = join(tempRoot, "bin");
    callsPath = join(tempRoot, "herdr-calls.jsonl");
    await mkdir(binDir, { recursive: true });
    // A shebang file is not executable on Windows: PATH lookup would fall through
    // to the real herdr and drive the developer's live session.
    await Bun.write(join(binDir, "herdr-fake.ts"), fakeHerdr);
    if (process.platform === "win32") {
      await Bun.write(join(binDir, "herdr.cmd"), `@echo off\r\nbun "%~dp0herdr-fake.ts" %*\r\n`);
    } else {
      await Bun.write(join(binDir, "herdr"), fakeHerdr);
      await chmod(join(binDir, "herdr"), 0o755);
    }
    const workspace = await ws.init({
      root: tempRoot,
      name: "payment-fix",
      description: "Fix payment retries",
    });
    workspacePath = workspace.path;
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function runStart(options: {
    insideHerdr: boolean;
    scenario: "create" | "reuse" | "shell" | "timeout" | "server-down";
    name?: string;
  }) {
    await writeFile(callsPath, "");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "ws",
        "start",
        options.name ?? "payment-fix",
        "--root",
        tempRoot,
        "--json",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          HERDR_ENV: options.insideHerdr ? "1" : undefined,
          HERDR_CALLS: callsPath,
          HERDR_SCENARIO: options.scenario,
          HERDR_WORKSPACE_PATH: workspacePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    // Empty call log means PATH resolved something other than the fake: refuse to
    // interpret results produced by a real HerdR session.
    const calls = await readFile(callsPath, "utf8");
    if (calls.trim() === "")
      throw new Error("fake herdr was never invoked; the real binary may have run");
    return { exitCode, stdout, stderr };
  }

  it("creates a HerdR workspace at the dev workspace root and starts OMP", async () => {
    const result = await runStart({ insideHerdr: true, scenario: "create" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      workspace: "payment-fix",
      path: workspacePath,
      herdrWorkspaceId: "w7",
      paneId: "w7:p1",
      agentName: "payment-fix-omp",
      reused: false,
    });
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["pane", "list"],
      ["agent", "list"],
      ["workspace", "create", "--cwd", workspacePath, "--label", "payment-fix", "--no-focus"],
      ["agent", "start", "payment-fix-omp", "--kind", "omp", "--pane", "w7:p1"],
      ["workspace", "focus", "w7"],
    ]);
  });

  it("resolves a unique fuzzy workspace name before starting OMP", async () => {
    const result = await runStart({ insideHerdr: true, scenario: "create", name: "payf" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workspace: "payment-fix",
      path: workspacePath,
    });
  });
  it("reuses a ready OMP for the same dev workspace", async () => {
    const result = await runStart({ insideHerdr: true, scenario: "reuse" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      herdrWorkspaceId: "w1",
      paneId: "w1:p1",
      agentName: "payment-fix-omp",
      reused: true,
    });
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["pane", "list"],
      ["agent", "list"],
      ["workspace", "focus", "w1"],
    ]);
  });

  it("starts OMP in an available shell for the same dev workspace", async () => {
    const result = await runStart({ insideHerdr: true, scenario: "shell" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      herdrWorkspaceId: "w1",
      paneId: "w1:p1",
      agentName: "payment-fix-omp",
      reused: false,
    });
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["pane", "list"],
      ["agent", "list"],
      ["agent", "start", "payment-fix-omp", "--kind", "omp", "--pane", "w1:p1"],
      ["workspace", "focus", "w1"],
    ]);
  });

  it("recovers a start timeout when OMP is already ready in the created pane", async () => {
    const result = await runStart({ insideHerdr: true, scenario: "timeout" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      herdrWorkspaceId: "w7",
      paneId: "w7:p1",
      agentName: "payment-fix-omp",
      reused: false,
    });
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["pane", "list"],
      ["agent", "list"],
      ["workspace", "create", "--cwd", workspacePath, "--label", "payment-fix", "--no-focus"],
      ["agent", "start", "payment-fix-omp", "--kind", "omp", "--pane", "w7:p1"],
      ["agent", "list"],
      ["workspace", "focus", "w7"],
    ]);
  });

  it("uses a running HerdR server when called outside a HerdR pane", async () => {
    const result = await runStart({ insideHerdr: false, scenario: "create" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workspace: "payment-fix",
      herdrWorkspaceId: "w7",
      agentName: "payment-fix-omp",
      reused: false,
    });
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["session", "list"],
      ["--session", "default", "status", "server"],
      ["--session", "default", "pane", "list"],
      ["--session", "default", "agent", "list"],
      [
        "--session",
        "default",
        "workspace",
        "create",
        "--cwd",
        workspacePath,
        "--label",
        "payment-fix",
        "--no-focus",
      ],
      [
        "--session",
        "default",
        "agent",
        "start",
        "payment-fix-omp",
        "--kind",
        "omp",
        "--pane",
        "w7:p1",
      ],
      ["--session", "default", "workspace", "focus", "w7"],
    ]);
  });

  it("starts and waits for HerdR when no server is running", async () => {
    const result = await runStart({ insideHerdr: false, scenario: "server-down" });

    expect(result.exitCode).toBe(0);
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.slice(0, 5)).toEqual([
      ["session", "list"],
      ["status", "server"],
      ["server"],
      ["status", "server"],
      ["pane", "list"],
    ]);
  });

  it("opens the HerdR client after the requested workspace is ready and focused", async () => {
    const events: string[] = [];
    const reply = (result: Record<string, unknown>) => ({
      stdout: JSON.stringify({ id: "test", result }),
      stderr: "",
      exitCode: 0,
    });

    await herdr.startWorkspace(
      {
        workspace: "payment-fix",
        path: workspacePath,
        insideHerdr: false,
        openClient: true,
      },
      {
        canonicalize: async (path) => path,
        startServer: () => events.push("server:start"),
        openClient: () => events.push("client:open"),
        wait: async () => {},
        run: async (args) => {
          events.push(args.join(" "));
          if (args[0] === "status") return { stdout: "status: running", stderr: "", exitCode: 0 };
          if (args[0] === "pane") return reply({ type: "pane_list", panes: [] });
          if (args[0] === "agent" && args[1] === "list") {
            return reply({ type: "agent_list", agents: [] });
          }
          if (args[0] === "workspace" && args[1] === "create") {
            return reply({
              type: "workspace_created",
              workspace: { workspace_id: "w7" },
              tab: { tab_id: "w7:t1" },
              root_pane: { pane_id: "w7:p1", workspace_id: "w7", cwd: workspacePath },
            });
          }
          if (args[0] === "agent" && args[1] === "start") {
            return reply({ type: "agent_started", agent: { pane_id: "w7:p1" } });
          }
          return reply({ type: "workspace_focused", workspace_id: "w7" });
        },
      },
    );

    expect(events.at(-2)).toBe("workspace focus w7");
    expect(events.at(-1)).toBe("client:open");
  });
});
