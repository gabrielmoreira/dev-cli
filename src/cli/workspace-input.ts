import { join } from "node:path";
import * as manifest from "../manifest.ts";
import * as ws from "../ws.ts";
import { ui } from "../ui.ts";
import { canPrompt, getAmbient, type AmbientContext } from "./context.ts";
import { CliInputRequiredError, resolveChoiceInput, type ResolvedCliInput } from "./input.ts";

export interface ResolveWorkspaceMountInputOptions {
  value?: string;
  workspace: string;
  root: string;
  workspacePrefix?: string;
  command: string;
  usage: string;
  ambient?: AmbientContext;
}

export interface ResolveWorkspaceMountScopeOptions extends ResolveWorkspaceMountInputOptions {
  all?: boolean;
}

export interface ResolveWorkspaceInputOptions {
  value?: string;
  root: string;
  workspacePrefix?: string;
  cwd?: string;
  command: string;
  usage: string;
  ambient?: AmbientContext;
}

export interface WorkspaceQueryContext {
  name: string;
  sources: string[];
}

export async function resolveWorkspaceQueryContext(options: {
  value?: string;
  root: string;
  workspacePrefix?: string;
  cwd?: string;
  ambient?: AmbientContext;
}): Promise<WorkspaceQueryContext | undefined> {
  const ambient = options.ambient ?? getAmbient();
  const name =
    options.value ??
    ws.detectWorkspaceFromCwd(options.cwd ?? ambient.cwd, options.root, options.workspacePrefix);
  if (!name) return undefined;
  const context = await ws.loadWorkspaceContext(
    options.root,
    name,
    undefined,
    options.workspacePrefix,
  );
  return {
    name,
    sources: context.manifest.mounts.map((mount) => mount.source),
  };
}

export async function resolveWorkspaceInput(
  options: ResolveWorkspaceInputOptions,
): Promise<ResolvedCliInput<string>> {
  const ambient = options.ambient ?? getAmbient();
  const detected = ws.detectWorkspaceFromCwd(
    options.cwd ?? ambient.cwd,
    options.root,
    options.workspacePrefix,
  );

  return await resolveChoiceInput({
    value: options.value,
    inferred: detected ? { value: detected, source: "cwd" } : undefined,
    choices: async () =>
      (await ws.list({ root: options.root, workspacePrefix: options.workspacePrefix })).map(
        (workspace) => ({
          label: workspace.description
            ? `${workspace.name} — ${workspace.description}`
            : workspace.name,
          value: workspace.name,
        }),
      ),
    message: "Select workspace",
    required: {
      command: options.command,
      field: "workspace",
      usage: options.usage,
      description: "Target workspace",
    },
    ambient,
  });
}

export async function resolveWorkspaceMountInput(
  options: ResolveWorkspaceMountInputOptions,
): Promise<ResolvedCliInput<string>> {
  const ambient = options.ambient ?? getAmbient();

  return await resolveChoiceInput({
    value: options.value,
    choices: async () => {
      const manifestPath = join(
        ws.deriveWorkspacePath(options.root, options.workspace, options.workspacePrefix),
        "ws.md",
      );
      const { manifest: workspaceManifest } = await manifest.readWorkspace(manifestPath);
      return workspaceManifest.mounts.map((mount) => ({
        label: `${mount.path} — ${mount.source}`,
        value: mount.path,
      }));
    },
    message: "Select mount",
    required: {
      command: options.command,
      field: "mount",
      usage: options.usage,
      description: "Target mount",
    },
    ambient,
  });
}

export async function resolveWorkspaceMountScope(
  options: ResolveWorkspaceMountScopeOptions,
): Promise<string | undefined> {
  if (options.value) return options.value;
  if (options.all) return undefined;

  const ambient = options.ambient ?? getAmbient();
  const required = {
    command: options.command,
    field: "mount",
    usage: options.usage,
    description: "Target mount or explicit --all scope",
  };
  if (!canPrompt(ambient)) throw new CliInputRequiredError(required);

  const scope = await ui.select("Choose operation scope", [
    { label: "One mount", value: "one" },
    { label: "All mounts", value: "all" },
  ]);
  if (scope === "all") return undefined;

  return (
    await resolveWorkspaceMountInput({
      ...options,
      ambient,
    })
  ).value;
}
