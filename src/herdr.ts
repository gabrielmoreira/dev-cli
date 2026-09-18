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
}

export interface StartHerdrWorkspaceResult {
  workspace: string;
  path: string;
  herdrWorkspaceId: string;
  paneId: string;
  agentName: string;
  reused: boolean;
}

export interface HerdrDeps {
  run(args: string[]): Promise<shell.ShellExecResult>;
  canonicalize(path: string): Promise<string>;
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

const defaultDeps: HerdrDeps = {
  run: async (args) => await shell.runCommand("herdr", args),
  canonicalize: async (path) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  },
};

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

function parseResult(stdout: string, expectedType: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new HerdrError("HERDR_INVALID_RESPONSE", "HerdR returned invalid JSON.");
  }

  const result = asRecord(asRecord(payload)?.result);
  if (!result || result.type !== expectedType) {
    throw new HerdrError(
      "HERDR_INVALID_RESPONSE",
      `HerdR returned an unexpected response; expected ${expectedType}.`,
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
  expectedType: string,
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
  deps: HerdrDeps = defaultDeps,
): Promise<StartHerdrWorkspaceResult> {
  if (!input.insideHerdr) {
    throw new HerdrError(
      "HERDR_ENV_REQUIRED",
      "dev ws start requires an active HerdR pane (HERDR_ENV=1). Open HerdR, then run it from a HerdR pane.",
    );
  }

  const targetPath = normalizePath(await deps.canonicalize(input.path));
  const panes = await listPanes(deps);
  const agents = await listAgents(deps);

  for (const agent of agents) {
    if (isReadyOmp(agent) && (await isSamePath(agent.cwd, targetPath, deps))) {
      await runRequired(["workspace", "focus", agent.workspaceId], "workspace_focused", deps);
      return {
        workspace: input.workspace,
        path: input.path,
        herdrWorkspaceId: agent.workspaceId,
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

  await runRequired(["workspace", "focus", pane.workspaceId], "workspace_focused", deps);
  return {
    workspace: input.workspace,
    path: input.path,
    herdrWorkspaceId: pane.workspaceId,
    paneId: pane.paneId,
    agentName,
    reused: false,
  };
}
