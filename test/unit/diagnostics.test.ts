import { describe, expect, test } from "bun:test";
import {
  classifyHardwareProfile,
  recommendModels,
  buildDoctorReport,
  inspectEnvironment,
  type ToolDiagnostic,
} from "../../src/doctor";
import type { RuntimeConfig } from "../../src/config";

describe("Hardware & Diagnostics Pure Logic (Phase 18)", () => {
  describe("Hardware Profile Classification", () => {
    const GB = 1024 * 1024 * 1024;

    test("classifies memory < 16GB as 'light'", () => {
      expect(classifyHardwareProfile({ totalMemoryBytes: 8 * GB, cores: 4 })).toBe("light");
    });

    test("classifies memory 16GB - 31GB as 'medium'", () => {
      expect(classifyHardwareProfile({ totalMemoryBytes: 16 * GB, cores: 8 })).toBe("medium");
    });

    test("classifies memory 32GB - 63GB as 'heavy'", () => {
      expect(classifyHardwareProfile({ totalMemoryBytes: 32 * GB, cores: 16 })).toBe("heavy");
    });

    test("classifies memory >= 64GB as 'workstation'", () => {
      expect(classifyHardwareProfile({ totalMemoryBytes: 64 * GB, cores: 32 })).toBe("workstation");
      expect(classifyHardwareProfile({ totalMemoryBytes: 128 * GB, cores: 64 })).toBe(
        "workstation",
      );
    });
  });

  describe("Model Recommendations", () => {
    test("recommends compact models for 'light' profile", () => {
      const rec = recommendModels("light");
      expect(rec.recommendedModelTier).toBe("compact (1.5B - 3B)");
      expect(rec.suggestedModels.some((m) => m.includes("1.5B") || m.includes("3B"))).toBe(true);
      expect(rec.maxContextWindow).toBeLessThanOrEqual(8192);
    });

    test("recommends 7B-8B models for 'medium' profile", () => {
      const rec = recommendModels("medium");
      expect(rec.recommendedModelTier).toBe("balanced (7B - 8B)");
      expect(rec.suggestedModels.some((m) => m.includes("7B") || m.includes("8B"))).toBe(true);
    });

    test("recommends 14B-32B models for 'heavy' profile", () => {
      const rec = recommendModels("heavy");
      expect(rec.recommendedModelTier).toBe("advanced (14B - 32B)");
      expect(rec.suggestedModels.some((m) => m.includes("14B") || m.includes("32B"))).toBe(true);
    });

    test("recommends high-capacity models for 'workstation' profile", () => {
      const rec = recommendModels("workstation");
      expect(rec.recommendedModelTier).toBe("frontier (32B - 70B+)");
      expect(rec.suggestedModels.some((m) => m.includes("70B") || m.includes("32B"))).toBe(true);
      expect(rec.maxContextWindow).toBeGreaterThanOrEqual(32768);
    });
  });

  describe("Doctor Report Construction", () => {
    const validTools: ToolDiagnostic[] = [
      { name: "git", required: true, available: true, version: "2.45.0", path: "/usr/bin/git" },
      { name: "bun", required: true, available: true, version: "1.2.0", path: "/usr/bin/bun" },
      {
        name: "mise",
        required: false,
        available: true,
        version: "2024.5.0",
        path: "/usr/bin/mise",
      },
      { name: "gh", required: false, available: false, message: "Optional CLI tool not found" },
    ];

    test("constructs 'healthy' report when required tools are present", () => {
      const report = buildDoctorReport({
        root: { path: "C:/fake/dev", exists: true, hasDevDir: true },
        tools: validTools,
        providers: {
          azureDevOps: { configured: true, credentialSource: "config" },
          github: { configured: false },
        },
        providerList: [],
      });

      expect(report.status).toBe("healthy");
      expect(report.tools.length).toBe(4);
      expect(report.root.exists).toBe(true);
    });

    test("constructs 'error' report when required tool is missing", () => {
      const missingRequired: ToolDiagnostic[] = [
        {
          name: "git",
          required: true,
          available: false,
          message: "Git executable not found in PATH",
        },
        { name: "bun", required: true, available: true, version: "1.2.0" },
      ];

      const report = buildDoctorReport({
        root: { path: "C:/fake/dev", exists: true, hasDevDir: true },
        tools: missingRequired,
        providers: {
          azureDevOps: { configured: false },
          github: { configured: false },
        },
        providerList: [],
      });

      expect(report.status).toBe("error");
      expect(report.messages.some((m) => m.includes("Git executable not found"))).toBe(true);
    });

    test("constructs 'warning' report when dev root does not exist", () => {
      const report = buildDoctorReport({
        root: { path: "C:/non-existent/dev", exists: false, hasDevDir: false },
        tools: validTools,
        providers: {
          azureDevOps: { configured: false },
          github: { configured: false },
        },
        providerList: [],
      });

      expect(report.status).toBe("warning");
      expect(report.messages.some((m) => m.includes("does not exist"))).toBe(true);
    });

    test("uses the same Azure CLI credential resolution as live commands", async () => {
      const config = {
        root: "/dev",
        tokens: {},
        azureDevOps: {},
        github: { enabled: true },
        providers: [{ id: "ado-org", type: "azure_devops", organization: "org" }],
      } as RuntimeConfig;
      const deps = {
        fs: { exists: () => true },
        shell: {
          runCommand: async (command: string) => ({
            command,
            exitCode: 0,
            stdout: `${command} version`,
            stderr: "",
            durationMs: 1,
          }),
        },
        resolveAzureDevOpsCredential: async () => ({
          kind: "bearer" as const,
          token: "not-exposed",
          source: "azure_cli" as const,
        }),
        resolveGitHubCredential: async () => {
          throw new Error("not authenticated");
        },
      } as unknown as Parameters<typeof inspectEnvironment>[1];

      const report = await inspectEnvironment(config, deps);

      expect(report.providerList[0].configured).toBe(true);
      expect(report.providerList[0].credentialSource).toBe("azure_cli");
      expect(JSON.stringify(report)).not.toContain("not-exposed");
    });
  });
});
