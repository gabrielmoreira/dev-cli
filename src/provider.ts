import { updateConfig } from "./config.ts";
import yaml from "yaml";
import * as fs from "./fs.ts";
import { configFilePath } from "./paths.ts";

export type ProviderType = "azure_devops" | "github";

export interface AzureDevOpsProviderConfig {
  id: string;
  type: "azure_devops";
  organization: string;
  project?: string;
}

export interface GitHubProviderConfig {
  id: string;
  type: "github";
  owner: string;
}

export type ProviderConfig = AzureDevOpsProviderConfig | GitHubProviderConfig;

export async function addProvider(root: string, provider: ProviderConfig): Promise<void> {
  await updateConfig(configFilePath({ root }), (doc) => {
    const existing = doc.get("providers");
    const items: unknown[] = yaml.isSeq(existing)
      ? existing.toJSON()
      : Array.isArray(existing)
        ? existing
        : [];
    const filtered = items.filter(
      (p) => p && !(typeof p === "object" && "id" in p && p.id === provider.id),
    );
    filtered.push(provider);
    doc.set("providers", filtered);
  });
}

export async function removeProvider(root: string, id: string): Promise<boolean> {
  const devYamlPath = configFilePath({ root });
  if (!fs.exists(devYamlPath)) {
    return false;
  }

  let removed = false;
  await updateConfig(devYamlPath, (doc) => {
    const existing = doc.get("providers");
    const items: unknown[] = yaml.isSeq(existing)
      ? existing.toJSON()
      : Array.isArray(existing)
        ? existing
        : [];
    const filtered = items.filter((p) => p && !(typeof p === "object" && "id" in p && p.id === id));
    if (filtered.length === items.length) return;
    doc.set("providers", filtered);
    removed = true;
  });
  return removed;
}

export async function listProviders(root: string): Promise<ProviderConfig[]> {
  const devYamlPath = configFilePath({ root });
  if (!fs.exists(devYamlPath)) {
    return [];
  }

  const content = await fs.readText(devYamlPath);
  const parsed = yaml.parse(content) as Record<string, unknown> | null;
  if (!parsed || !Array.isArray(parsed.providers)) {
    return [];
  }

  return parsed.providers as ProviderConfig[];
}
