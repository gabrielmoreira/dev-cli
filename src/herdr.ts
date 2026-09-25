import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import * as shell from "./shell.ts";

export class HerdrError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
    this.details = details;
  }
}

export interface StartHerdrWorkspaceInput {
  workspace: string;
  path: string;
  insideHerdr: boolean;
  session?: string;
}

export interface HerdrSession {
  name: string;
  running: boolean;
}

export interface StartHerdrWorkspaceResult {
  workspace: string;
  path: string;
  herdrWorkspaceId: string;
  session?: string;
  paneId: string;
  agentName: string;
  reused: boolean;
}

export interface HerdrDeps {
  run(args: string[]): Promise<shell.ShellExecResult>;
  canonicalize(path: string): Promise<string>;
  startServer(): void;
  wait(milliseconds: number): Promise<void>;
  interactions?: {
    chooseSession?(sessions: HerdrSession[]): Promise<string>;
  };
}

interface PaneSummary {
  paneId: string;
  workspaceId: string;
  cwd?: string;
  agent?: string;
}

interface AgentSummary extends PaneSummary {
  name?: string;
  displayAgent?: string;
  interactiveReady: boolean;
}

export const defaultDeps: HerdrDeps = {
  run: async (args) => await shell.runCommand("herdr", args),
  canonicalize: async (path) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  },
  startServer: () => {
    const process = Bun.spawn(["herdr", "server"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    process.unref();
  },
  wait: async (milliseconds) => {
    await Bun.sleep(milliseconds);
  },
};

/**
 * Hands the terminal to the HerdR client and waits until it closes. The
 * client must stay in the foreground: a background one cannot read the
 * terminal once dev exits, and fails to start.
 */
export async function openClient(session?: string): Promise<number> {
  const client = Bun.spawn(session ? ["herdr", "--session", session] : ["herdr"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await client.exited;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HerdrError("HERDR_INVALID_RESPONSE", `HerdR response is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseResult(stdout: string, expectedType: string | string[]): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new HerdrError("HERDR_INVALID_RESPONSE", "HerdR returned invalid JSON.");
  }

  const result = asRecord(asRecord(payload)?.result);
  const expected = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!result || !expected.includes(String(result.type))) {
    throw new HerdrError(
      "HERDR_INVALID_RESPONSE",
      `HerdR returned an unexpected response; expected ${expected.join(" or ")}.`,
    );
  }
  return result;
}

function parsePanes(stdout: string): PaneSummary[] {
  const panes = parseResult(stdout, "pane_list").panes;
  if (!Array.isArray(panes)) {
    throw new HerdrError("HERDR_INVALID_RESPONSE", "HerdR pane list is missing panes.");
  }
  return panes.map((value, index) => {
    const pane = asRecord(value);
    if (!pane) {
      throw new HerdrError("HERDR_INVALID_RESPONSE", `HerdR pane ${index} is invalid.`);
    }
    return {
      paneId: requiredString(pane.pane_id, `panes[${index}].pane_id`),
      workspaceId: requiredString(pane.workspace_id, `panes[${index}].workspace_id`),
      cwd: optionalString(pane.foreground_cwd) ?? optionalString(pane.cwd),
      agent: optionalString(pane.agent) ?? optionalString(pane.display_agent),
    };
  });
}

function parseAgents(stdout: string): AgentSummary[] {
  const agents = parseResult(stdout, "agent_list").agents;
  if (!Array.isArray(agents)) {
    throw new HerdrError("HERDR_INVALID_RESPONSE", "HerdR agent list is missing agents.");
  }
  return agents.map((value, index) => {
    const agent = asRecord(value);
    if (!agent) {
      throw new HerdrError("HERDR_INVALID_RESPONSE", `HerdR agent ${index} is invalid.`);
    }
    return {
      paneId: requiredString(agent.pane_id, `agents[${index}].pane_id`),
      workspaceId: requiredString(agent.workspace_id, `agents[${index}].workspace_id`),
      cwd: optionalString(agent.foreground_cwd) ?? optionalString(agent.cwd),
      agent: optionalString(agent.agent),
      displayAgent: optionalString(agent.display_agent),
      name: optionalString(agent.name),
      interactiveReady: agent.interactive_ready === true,
    };
  });
}

async function runRequired(
  args: string[],
  expectedType: string | string[],
  deps: HerdrDeps,
): Promise<Record<string, unknown>> {
  const result = await deps.run(args);
  if (result.exitCode !== 0) {
    throw commandError(args, result);
  }
  return parseResult(result.stdout, expectedType);
}

function commandError(args: string[], result: shell.ShellExecResult): HerdrError {
  const reason = result.stderr || result.stdout || "unknown error";
  return new HerdrError("HERDR_COMMAND_FAILED", `HerdR command failed: ${reason}`, {
    command: ["herdr", ...args],
    exitCode: result.exitCode,
  });
}

async function listPanes(deps: HerdrDeps): Promise<PaneSummary[]> {
  const result = await deps.run(["pane", "list"]);
  if (result.exitCode !== 0) throw commandError(["pane", "list"], result);
  return parsePanes(result.stdout);
}

async function listAgents(deps: HerdrDeps): Promise<AgentSummary[]> {
  const result = await deps.run(["agent", "list"]);
  if (result.exitCode !== 0) throw commandError(["agent", "list"], result);
  return parseAgents(result.stdout);
}

export function parseSessions(stdout: string): HerdrSession[] {
  const sessions: HerdrSession[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(running|stopped)\b/.exec(line.trim());
    if (match) sessions.push({ name: match[1]!, running: match[2] === "running" });
  }
  return sessions;
}

async function listSessions(deps: HerdrDeps): Promise<HerdrSession[]> {
  const result = await deps.run(["session", "list"]);
  if (result.exitCode !== 0) throw commandError(["session", "list"], result);
  return parseSessions(result.stdout);
}

async function resolveSession(
  input: StartHerdrWorkspaceInput,
  deps: HerdrDeps,
): Promise<string | undefined> {
  // Inside a pane the CLI already targets the surrounding session.
  if (input.insideHerdr) return undefined;

  const sessions = await listSessions(deps);
  if (input.session) {
    const chosen = sessions.find((session) => session.name === input.session);
    if (!chosen?.running) {
      throw new HerdrError(
        "HERDR_SESSION_NOT_RUNNING",
        `HerdR session '${input.session}' is not running. Running sessions: ${runningNames(sessions) || "none"}.`,
        { session: input.session, sessions },
      );
    }
    return chosen.name;
  }

  const running = sessions.filter((session) => session.running);
  if (running.length === 0) return undefined;
  if (running.length === 1) return running[0]!.name;

  const choose = deps.interactions?.chooseSession;
  if (!choose) {
    throw new HerdrError(
      "HERDR_AMBIGUOUS_SESSION",
      `Multiple HerdR sessions are running (${runningNames(sessions)}). Pass --session <name>.`,
      { sessions: running },
    );
  }
  return await choose(running);
}

function runningNames(sessions: HerdrSession[]): string {
  return sessions
    .filter((session) => session.running)
    .map((session) => session.name)
    .join(", ");
}

function scopedDeps(deps: HerdrDeps, session: string | undefined): HerdrDeps {
  if (!session) return deps;
  return { ...deps, run: (args) => deps.run(["--session", session, ...args]) };
}

async function isServerRunning(deps: HerdrDeps): Promise<boolean> {
  const result = await deps.run(["status", "server"]);
  if (result.exitCode !== 0) throw commandError(["status", "server"], result);
  if (/^status:\s+running$/m.test(result.stdout)) return true;
  if (/^status:\s+not running$/m.test(result.stdout)) return false;
  throw new HerdrError("HERDR_INVALID_RESPONSE", "HerdR server status is missing its state.");
}

async function ensureServer(input: StartHerdrWorkspaceInput, deps: HerdrDeps): Promise<void> {
  if (input.insideHerdr || (await isServerRunning(deps))) return;
  deps.startServer();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await deps.wait(100);
    if (await isServerRunning(deps)) return;
  }
  throw new HerdrError(
    "HERDR_SERVER_START_TIMEOUT",
    "HerdR server did not become ready within 5 seconds.",
  );
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function isSamePath(
  candidate: string | undefined,
  expected: string,
  deps: HerdrDeps,
): Promise<boolean> {
  if (!candidate) return false;
  return normalizePath(await deps.canonicalize(candidate)) === normalizePath(expected);
}

function isReadyOmp(agent: AgentSummary): boolean {
  return agent.interactiveReady && (agent.agent === "omp" || agent.displayAgent === "omp");
}

function baseAgentName(workspace: string): string {
  let stem = workspace
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(stem)) stem = `ws-${stem}`;
  return `${stem.slice(0, 28)}-omp`;
}

function uniqueAgentName(workspace: string, agents: AgentSummary[]): string {
  const base = baseAgentName(workspace);
  const used = new Set(agents.flatMap((agent) => (agent.name ? [agent.name] : [])));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${base.slice(0, 32 - marker.length)}${marker}`;
    if (!used.has(candidate)) return candidate;
  }
}

export async function startWorkspace(
  input: StartHerdrWorkspaceInput,
  rawDeps: HerdrDeps = defaultDeps,
): Promise<StartHerdrWorkspaceResult> {
  const session = await resolveSession(input, rawDeps);
  const deps = scopedDeps(rawDeps, session);
  await ensureServer(input, deps);

  const targetPath = normalizePath(await deps.canonicalize(input.path));
  const panes = await listPanes(deps);
  const agents = await listAgents(deps);

  for (const agent of agents) {
    if (isReadyOmp(agent) && (await isSamePath(agent.cwd, targetPath, deps))) {
      await runRequired(
        ["workspace", "focus", agent.workspaceId],
        ["workspace_info", "workspace_focused"],
        deps,
      );
      return {
        workspace: input.workspace,
        path: input.path,
        herdrWorkspaceId: agent.workspaceId,
        session,
        paneId: agent.paneId,
        agentName: agent.name ?? baseAgentName(input.workspace),
        reused: true,
      };
    }
  }

  let pane = undefined as PaneSummary | undefined;
  for (const candidate of panes) {
    if (!candidate.agent && (await isSamePath(candidate.cwd, targetPath, deps))) {
      pane = candidate;
      break;
    }
  }

  if (!pane) {
    const created = await runRequired(
      ["workspace", "create", "--cwd", input.path, "--label", input.workspace, "--no-focus"],
      "workspace_created",
      deps,
    );
    const workspace = asRecord(created.workspace);
    const rootPane = asRecord(created.root_pane);
    pane = {
      workspaceId: requiredString(workspace?.workspace_id, "workspace.workspace_id"),
      paneId: requiredString(rootPane?.pane_id, "root_pane.pane_id"),
      cwd: optionalString(rootPane?.cwd) ?? input.path,
    };
  }

  const agentName = uniqueAgentName(input.workspace, agents);
  const startArgs = ["agent", "start", agentName, "--kind", "omp", "--pane", pane.paneId];
  const started = await deps.run(startArgs);
  if (started.exitCode === 0) {
    parseResult(started.stdout, "agent_started");
  } else {
    const recovered = (await listAgents(deps)).find(
      (agent) => agent.paneId === pane.paneId && isReadyOmp(agent),
    );
    if (!recovered) {
      const failure = commandError(startArgs, started);
      throw new HerdrError(
        failure.code,
        `${failure.message} HerdR workspace ${pane.workspaceId} and pane ${pane.paneId} were preserved; inspect that pane before retrying.`,
        failure.details,
      );
    }
  }

  await runRequired(
    ["workspace", "focus", pane.workspaceId],
    ["workspace_info", "workspace_focused"],
    deps,
  );
  return {
    workspace: input.workspace,
    path: input.path,
    herdrWorkspaceId: pane.workspaceId,
    session,
    paneId: pane.paneId,
    agentName,
    reused: false,
  };
}
