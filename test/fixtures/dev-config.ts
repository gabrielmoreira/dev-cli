import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes a minimal dev.yaml to `root` containing a single ADO provider.
 * Tests that need multi-provider sync must call this before running CLI commands,
 * because sync inventory no longer accepts --tenant; it reads from config.providers[].
 */
export async function writeAdoProviderConfig(
  root: string,
  organization: string,
  project?: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const lines = [
    "version: 1",
    "providers:",
    "  - id: test-ado",
    "    type: azure_devops",
    `    organization: ${organization}`,
  ];
  if (project) {
    lines.push(`    project: ${project}`);
  }
  await writeFile(join(root, "dev.yaml"), lines.join("\n"), "utf8");
}
