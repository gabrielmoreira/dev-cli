import { cpus, freemem, platform, arch, totalmem } from "node:os";
import { devDir } from "./paths.ts";
import * as fs from "./fs.ts";
import * as shell from "./shell.ts";
import type { RuntimeConfig } from "./config.ts";
import {
  resolveAzureDevOpsCredential,
  resolveGitHubCredential,
  type AzureDevOpsCredential,
  type GitHubCredential,
} from "./credentials.ts";

export type HardwareProfile = "light" | "medium" | "heavy" | "workstation";

export interface ModelRecommendations {
  recommendedModelTier: string;
  suggestedModels: string[];
  maxContextWindow: number;
  notes: string[];
}

export interface ToolDiagnostic {
  name: string;
  required: boolean;
  available: boolean;
  version?: string;
  path?: string;
  message?: string;
}

export interface ProviderDiagnostic {
  id: string;
  type: "azure_devops" | "github";
  target: string; // org/owner
  configured: boolean;
  credentialSource?: string;
}

export interface DoctorReport {
  status: "healthy" | "warning" | "error";
  root: {
    path: string;
    exists: boolean;
    hasDevDir: boolean;
  };
  tools: ToolDiagnostic[];
  /** @deprecated use providerList */
  providers: {
    azureDevOps: { configured: boolean; credentialSource?: string };
    github: { configured: boolean; credentialSource?: string };
  };
  providerList: ProviderDiagnostic[];
  messages: string[];
}

export interface HardwareReport {
  platform: string;
  arch: string;
  cpu: {
    model: string;
    cores: number;
    speedMHz: number;
  };
  memory: {
    totalBytes: number;
    totalGB: number;
    freeBytes: number;
    freeGB: number;
  };
  profile: HardwareProfile;
  recommendations: ModelRecommendations;
}

export function classifyHardwareProfile(options: {
  totalMemoryBytes: number;
  cores?: number;
}): HardwareProfile {
  const GB = 1024 * 1024 * 1024;
  const mem = options.totalMemoryBytes;

  if (mem < 16 * GB) {
    return "light";
  }
  if (mem < 32 * GB) {
    return "medium";
  }
  if (mem < 64 * GB) {
    return "heavy";
  }
  return "workstation";
}

export function recommendModels(profile: HardwareProfile): ModelRecommendations {
  switch (profile) {
    case "light":
      return {
        recommendedModelTier: "compact (1.5B - 3B)",
        suggestedModels: ["Qwen 2.5 Coder 1.5B", "Qwen 2.5 Coder 3B", "Llama 3.2 3B"],
        maxContextWindow: 8192,
        notes: ["Lightweight profile: optimal for fast local code completions and linting."],
      };
    case "medium":
      return {
        recommendedModelTier: "balanced (7B - 8B)",
        suggestedModels: ["Qwen 2.5 Coder 7B", "Llama 3.1 8B", "DeepSeek Coder 6.7B"],
        maxContextWindow: 16384,
        notes: [
          "Balanced profile: ideal for daily development assistance, refactoring, and review.",
        ],
      };
    case "heavy":
      return {
        recommendedModelTier: "advanced (14B - 32B)",
        suggestedModels: ["Qwen 2.5 Coder 14B", "Qwen 2.5 Coder 32B", "Codestral 22B"],
        maxContextWindow: 32768,
        notes: [
          "High-performance profile: suitable for complex multi-file reasoning and architecture.",
        ],
      };
    case "workstation":
      return {
        recommendedModelTier: "frontier (32B - 70B+)",
        suggestedModels: ["Qwen 2.5 Coder 32B", "Llama 3.3 70B", "DeepSeek V3 (quantized)"],
        maxContextWindow: 65536,
        notes: [
          "Workstation-class profile: capable of running local frontier-class coding models.",
        ],
      };
  }
}

export function buildDoctorReport(input: {
  root: { path: string; exists: boolean; hasDevDir: boolean };
  tools: ToolDiagnostic[];
  providers: {
    azureDevOps: { configured: boolean; credentialSource?: string };
    github: { configured: boolean; credentialSource?: string };
  };
  providerList: ProviderDiagnostic[];
}): DoctorReport {
  const messages: string[] = [];
  let hasRequiredToolMissing = false;

  for (const tool of input.tools) {
    if (tool.required && !tool.available) {
      hasRequiredToolMissing = true;
      messages.push(tool.message || `Required tool '${tool.name}' is not installed or not in PATH`);
    } else if (!tool.available) {
      messages.push(
        `Optional tool '${tool.name}' is not available: ${tool.message || "not installed"}`,
      );
    }
  }

  if (!input.root.exists) {
    messages.push(`Development root directory '${input.root.path}' does not exist on disk.`);
  } else if (!input.root.hasDevDir) {
    messages.push(`Development root directory exists but '.dev/' metadata directory is missing.`);
  }

  let status: "healthy" | "warning" | "error" = "healthy";
  if (hasRequiredToolMissing) {
    status = "error";
  } else if (!input.root.exists || !input.root.hasDevDir) {
    status = "warning";
  }

  return {
    status,
    root: input.root,
    tools: input.tools,
    providers: input.providers,
    providerList: input.providerList,
    messages,
  };
}

export function inspectHardware(): HardwareReport {
  const cpuList = cpus();
  const firstCpu = cpuList[0] || { model: "Unknown CPU", speed: 0 };
  const total = totalmem();
  const free = freemem();
  const GB = 1024 * 1024 * 1024;

  const profile = classifyHardwareProfile({
    totalMemoryBytes: total,
    cores: cpuList.length,
  });

  const recommendations = recommendModels(profile);

  return {
    platform: platform(),
    arch: arch(),
    cpu: {
      model: firstCpu.model,
      cores: cpuList.length,
      speedMHz: firstCpu.speed,
    },
    memory: {
      totalBytes: total,
      totalGB: Math.round((total / GB) * 10) / 10,
      freeBytes: free,
      freeGB: Math.round((free / GB) * 10) / 10,
    },
    profile,
    recommendations,
  };
}

export interface DoctorDeps {
  fs: Pick<typeof fs, "exists">;
  shell: Pick<typeof shell, "runCommand">;
  resolveAzureDevOpsCredential: typeof resolveAzureDevOpsCredential;
  resolveGitHubCredential: typeof resolveGitHubCredential;
}

const doctorDeps: DoctorDeps = {
  fs,
  shell,
  resolveAzureDevOpsCredential,
  resolveGitHubCredential,
};

export async function inspectEnvironment(
  config: RuntimeConfig,
  deps: DoctorDeps = doctorDeps,
): Promise<DoctorReport> {
  const checkTool = async (
    name: string,
    required: boolean,
    versionArgs: string[] = ["--version"],
  ): Promise<ToolDiagnostic> => {
    const res = await deps.shell.runCommand(name, versionArgs);
    if (res.exitCode === 0) {
      const version = res.stdout.split("\n")[0]?.trim();
      return {
        name,
        required,
        available: true,
        version,
      };
    }
    return {
      name,
      required,
      available: false,
      message: res.stderr || `${name} executable not found in PATH`,
    };
  };

  const tools: ToolDiagnostic[] = await Promise.all([
    checkTool("git", true),
    checkTool("bun", true),
    checkTool("mise", false),
    checkTool("gh", false),
    checkTool("az", false),
  ]);

  const rootExists = deps.fs.exists(config.root);
  const devDirExists = deps.fs.exists(devDir({ root: config.root }));

  const hasAdoProvider = config.providers.some((provider) => provider.type === "azure_devops");
  const hasGitHubProvider = config.providers.some((provider) => provider.type === "github");
  const [adoCredential, githubCredential] = await Promise.all([
    hasAdoProvider
      ? deps.resolveAzureDevOpsCredential(config).catch(() => undefined)
      : Promise.resolve<AzureDevOpsCredential | undefined>(undefined),
    hasGitHubProvider
      ? deps.resolveGitHubCredential(config).catch(() => undefined)
      : Promise.resolve<GitHubCredential | undefined>(undefined),
  ]);

  const providerList: ProviderDiagnostic[] = config.providers.map((p) => {
    if (p.type === "azure_devops") {
      return {
        id: p.id,
        type: "azure_devops" as const,
        target: p.project ? `${p.organization}/${p.project}` : p.organization,
        configured: Boolean(adoCredential),
        credentialSource: adoCredential?.source,
      };
    }
    return {
      id: p.id,
      type: "github" as const,
      target: p.owner,
      configured: Boolean(githubCredential),
      credentialSource: githubCredential?.source,
    };
  });

  // Flattened provider fields
  const adoProvider = providerList.find((p) => p.type === "azure_devops");
  const ghProvider = providerList.find((p) => p.type === "github");
  const providers = {
    azureDevOps: {
      configured: adoProvider?.configured ?? Boolean(config.azureDevOps.organization),
      credentialSource: adoProvider?.credentialSource,
    },
    github: {
      configured: ghProvider?.configured ?? Boolean(config.github.owner),
      credentialSource: ghProvider?.credentialSource,
    },
  };

  return buildDoctorReport({
    root: {
      path: config.root,
      exists: rootExists,
      hasDevDir: devDirExists,
    },
    tools,
    providers,
    providerList,
  });
}
