import yaml from "yaml";
import { readText, withFileLock, writeTextAtomic } from "./fs.ts";

export interface RevisionTracking {
  mode: "track";
  branch: string;
  upstream?: string;
}

export interface RevisionLock {
  mode: "lock";
  commit: string;
}

export interface RevisionTag {
  mode: "tag";
  tag: string;
}

export type MountRevision = RevisionTracking | RevisionLock | RevisionTag;

export interface MountHooks {
  pre_checkout?: string;
  post_checkout?: string;
  post_add?: string;
  post_sync?: string;
}

export interface MountDefinition {
  path: string;
  source: string;
  readonly?: boolean;
  revision: MountRevision;
  hooks?: MountHooks;
}

export interface WorkspaceManifest {
  version: number;
  name: string;
  created_at: string;
  description?: string;
  mounts: MountDefinition[];
}

export function defaultWorkspaceBody(name: string, description?: string): string {
  const objective = description
    ? description.trim()
    : "<!-- Describe the intended outcome here -->";
  return `# Workspace: ${name}

> Read this file at the start of every work session. Keep it current so a human or LLM can resume without reconstructing prior context.
> Edit the Markdown sections below, but keep the YAML frontmatter intact because dev CLI owns the workspace definition.
> Use this workspace's \`.local/\` for workspace-local artifacts, scratch files, generated plans, and other material that must never be committed.

## Objective
${objective}

## Current Progress
<!-- Summarize what is complete and what is in progress -->

## Decisions
<!-- Record decisions and the alternatives they rejected -->

## Next Steps
<!-- List the next concrete actions in order -->

## dev CLI
- Run \`dev --help\` for human-oriented usage.
- Run \`dev --help --llms\` for the structured LLM command contract.
- Add a repository with \`dev ws add <url-or-name>\`.
- Compare declared and checked-out state with \`dev ws status\`.
- Start or focus OMP in HerdR with \`dev ws start\`.
- Bring the checkouts in line with this file with \`dev ws update\`.
`;
}

export function serializeManifestYaml(manifest: WorkspaceManifest): string {
  return yaml.stringify(manifest).trimEnd();
}

export function serializeWorkspace(manifest: WorkspaceManifest, body?: string): string {
  const yamlStr = serializeManifestYaml(manifest);
  const markdown =
    body !== undefined ? body : defaultWorkspaceBody(manifest.name, manifest.description);
  return `---\n${yamlStr}\n---\n\n${markdown.trim()}\n`;
}

export function parseWorkspace(
  content: string,
  filePath = "ws.md",
): { manifest: WorkspaceManifest; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    throw new Error("Invalid ws.md format: missing YAML frontmatter");
  }

  const [, yamlContent, body] = match;
  const parsed = yaml.parse(yamlContent) as Partial<WorkspaceManifest>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid ws.md format: frontmatter failed to parse as object");
  }

  if (parsed.mounts !== undefined && !Array.isArray(parsed.mounts)) {
    throw Object.assign(new Error("Invalid ws.md format: mounts must be an array"), {
      code: "INVALID_MANIFEST",
      details: { filePath, field: "mounts" },
    });
  }

  const manifest: WorkspaceManifest = {
    version: parsed.version ?? 1,
    name: parsed.name ?? "",
    created_at: parsed.created_at ? String(parsed.created_at) : new Date().toISOString(),
    description: parsed.description,
    mounts: Array.isArray(parsed.mounts) ? parsed.mounts : [],
  };

  return {
    manifest,
    body: body.trim(),
  };
}

export async function readWorkspace(
  filePath: string,
): Promise<{ manifest: WorkspaceManifest; body: string }> {
  const content = await readText(filePath);
  return parseWorkspace(content, filePath);
}

export async function writeWorkspace(
  filePath: string,
  manifest: WorkspaceManifest,
  body?: string,
): Promise<void> {
  const content = serializeWorkspace(manifest, body);
  await writeTextAtomic(filePath, content);
}

export async function updateWorkspace(
  filePath: string,
  mutate: (doc: { manifest: WorkspaceManifest; body: string }) => void | Promise<void>,
): Promise<{ manifest: WorkspaceManifest; body: string }> {
  return await withFileLock(filePath, async () => {
    const doc = await readWorkspace(filePath);
    await mutate(doc);
    await writeWorkspace(filePath, doc.manifest, doc.body);
    return doc;
  });
}
