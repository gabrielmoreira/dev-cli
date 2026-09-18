import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";
import {
  addProvider,
  listProviders,
  removeProvider,
  type ProviderConfig,
} from "../../src/provider.ts";

describe("Explicit Provider Management (Phase 2.5)", () => {
  it("adds provider to dev.yaml while strictly preserving comments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-prov-test-"));
    const devYamlPath = join(tempDir, "dev.yaml");

    const initialYaml = `# dev CLI Configuration Header
# Essential settings
sync_strategy: ff-only

defaults:
  workspace_prefix: ws/
`;
    await fs.writeText(devYamlPath, initialYaml);

    try {
      const adoProvider: ProviderConfig = {
        id: "corp-ado",
        type: "azure_devops",
        organization: "my-company",
        project: "core-platform",
      };

      await addProvider(tempDir, adoProvider);

      const content = await fs.readText(devYamlPath);
      // Comments must remain
      expect(content).toContain("# dev CLI Configuration Header");
      expect(content).toContain("# Essential settings");
      expect(content).toContain("sync_strategy: ff-only");

      // Provider must be present
      expect(content).toContain("providers:");
      expect(content).toContain("id: corp-ado");
      expect(content).toContain("type: azure_devops");
      expect(content).toContain("organization: my-company");

      // Verify listProviders
      const list = await listProviders(tempDir);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("corp-ado");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("adds multiple providers and removes by id preserving other entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dev-prov-multi-"));
    const devYamlPath = join(tempDir, "dev.yaml");
    await fs.writeText(devYamlPath, "sync_strategy: ff-only\n");

    try {
      await addProvider(tempDir, {
        id: "corp-ado",
        type: "azure_devops",
        organization: "my-company",
      });
      await addProvider(tempDir, {
        id: "personal-gh",
        type: "github",
        owner: "example-owner",
      });

      let list = await listProviders(tempDir);
      expect(list.length).toBe(2);

      const removed = await removeProvider(tempDir, "corp-ado");
      expect(removed).toBe(true);

      list = await listProviders(tempDir);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("personal-gh");

      const removeNonExistent = await removeProvider(tempDir, "missing-id");
      expect(removeNonExistent).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
