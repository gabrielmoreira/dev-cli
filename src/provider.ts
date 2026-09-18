import { join } from "node:path";
import yaml from "yaml";
import * as fs from "./fs.ts";

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
  const devYamlPath = join(root, "dev.yaml");
  let content = "";
  if (fs.exists(devYamlPath)) {
    content = await fs.readText(devYamlPath);
  }

  const doc = yaml.parseDocument(content || "sync_strategy: ff-only\n");
  const existing = doc.get("providers") as any;

  let items: any[] = [];
  if (existing && typeof existing.toJSON === "function") {
    items = existing.toJSON();
  } else if (Array.isArray(existing)) {
    items = existing;
  }

  const filtered = items.filter((p: any) => p && p.id !== provider.id);
  filtered.push(provider);

  doc.set("providers", filtered);
  await fs.writeText(devYamlPath, doc.toString());
}

export async function removeProvider(root: string, id: string): Promise<boolean> {
  const devYamlPath = join(root, "dev.yaml");
  if (!fs.exists(devYamlPath)) {
    return false;
  }

  const content = await fs.readText(devYamlPath);
  const doc = yaml.parseDocument(content);
  const existing = doc.get("providers") as any;

  let items: any[] = [];
  if (existing && typeof existing.toJSON === "function") {
    items = existing.toJSON();
  } else if (Array.isArray(existing)) {
    items = existing;
  }

  const initialLength = items.length;
  const filtered = items.filter((p: any) => p && p.id !== id);
  if (filtered.length === initialLength) {
    return false;
  }

  doc.set("providers", filtered);
  await fs.writeText(devYamlPath, doc.toString());
  return true;
}

export async function listProviders(root: string): Promise<ProviderConfig[]> {
  const devYamlPath = join(root, "dev.yaml");
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
