import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import * as ws from "../../src/ws.ts";

const fakeHerdr = `#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";

const args = Bun.argv.slice(2);
await appendFile(process.env.HERDR_CALLS, JSON.stringify(args) + "\\n");
const scenario = process.env.HERDR_SCENARIO;
const workspacePath = process.env.HERDR_WORKSPACE_PATH;
const response = (result) => console.log(JSON.stringify({ id: "test", result }));

if (args[0] === "pane" && args[1] === "list") {
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
  response({ type: "workspace_focused", workspace_id: args[2] });
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
    await Bun.write(join(binDir, "herdr"), fakeHerdr);
    await chmod(join(binDir, "herdr"), 0o755);
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
    scenario: "create" | "reuse" | "shell" | "timeout";
  }) {
    await writeFile(callsPath, "");
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "ws", "start", "payment-fix", "--root", tempRoot, "--json"],
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
    return { exitCode: await proc.exited, stdout, stderr };
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

  it("refuses to manage a HerdR workspace outside an active HerdR pane", async () => {
    const result = await runStart({ insideHerdr: false, scenario: "create" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HERDR_ENV=1");
    expect(await readFile(callsPath, "utf8")).toBe("");
  });
});
