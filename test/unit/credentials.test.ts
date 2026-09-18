import { describe, expect, it } from "bun:test";
import {
  CredentialError,
  getAuthorizationHeader,
  getGitExtraHeader,
  resolveAzureDevOpsCredential,
  resolveExtraHeader,
  resolveGitHubCredential,
} from "../../src/credentials.ts";
import { resolveConfig } from "../../src/config.ts";
import type * as shell from "../../src/shell.ts";

describe("Credential resolution unit tests (Phase 9)", () => {
  const baseConfig = resolveConfig({
    cwd: "/mock/cwd",
    env: {},
  });

  describe("Azure DevOps credentials", () => {
    it("returns configured PAT from config without calling Azure CLI", async () => {
      const config = {
        ...baseConfig,
        tokens: { azureDevOps: "secret-pat-123" },
      };

      let cliCalled = false;
      const fakeShell = {
        runCommand: async () => {
          cliCalled = true;
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as typeof shell;

      const cred = await resolveAzureDevOpsCredential(config, { shell: fakeShell });
      expect(cliCalled).toBe(false);
      expect(cred.kind).toBe("pat");
      expect(cred.token).toBe("secret-pat-123");
      expect(cred.source).toBe("config");
      expect(getAuthorizationHeader(cred)).toContain("Basic ");
    });

    it("falls back to Azure CLI authenticated session when no token is configured", async () => {
      const config = {
        ...baseConfig,
        tokens: { azureDevOps: undefined },
        azureDevOps: {},
      };

      const fakeShell = {
        runCommand: async (cmd: string, args: string[]) => {
          if (cmd === "az" && args.includes("get-access-token")) {
            return { stdout: "cli-bearer-token-abc", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as typeof shell;

      const cred = await resolveAzureDevOpsCredential(config, { shell: fakeShell });
      expect(cred.kind).toBe("bearer");
      expect(cred.token).toBe("cli-bearer-token-abc");
      expect(cred.source).toBe("azure_cli");
      expect(getAuthorizationHeader(cred)).toBe("Bearer cli-bearer-token-abc");
      expect(getGitExtraHeader(cred)).toBe(
        "http.extraheader=AUTHORIZATION: Bearer cli-bearer-token-abc",
      );
    });
    it("does not send an Azure DevOps credential to another organization", async () => {
      const config = {
        ...baseConfig,
        providers: [
          {
            id: "example-ado",
            type: "azure_devops" as const,
            organization: "trusted-org",
          },
        ],
        tokens: { azureDevOps: "secret-pat-123" },
      };

      const header = await resolveExtraHeader(
        config,
        "https://dev.azure.com/untrusted-org/project/_git/repository",
      );

      expect(header).toBeUndefined();
    });

    it("throws structured CREDENTIAL_NOT_AVAILABLE when neither config nor Azure CLI is available", async () => {
      const config = {
        ...baseConfig,
        tokens: { azureDevOps: undefined },
        azureDevOps: {},
      };

      const fakeShell = {
        runCommand: async () => ({
          stdout: "",
          stderr: "ERROR: Please run 'az login'",
          exitCode: 1,
        }),
      } as unknown as typeof shell;

      expect(resolveAzureDevOpsCredential(config, { shell: fakeShell })).rejects.toThrow(
        CredentialError,
      );
    });
  });

  describe("GitHub credentials", () => {
    it("returns configured token from config without calling gh CLI", async () => {
      const config = {
        ...baseConfig,
        tokens: { github: "ghp_secretToken456" },
      };

      let ghCalled = false;
      const fakeShell = {
        runCommand: async () => {
          ghCalled = true;
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as typeof shell;

      const cred = await resolveGitHubCredential(config, { shell: fakeShell });
      expect(ghCalled).toBe(false);
      expect(cred.kind).toBe("token");
      expect(cred.token).toBe("ghp_secretToken456");
      expect(cred.source).toBe("config");
      expect(getAuthorizationHeader(cred)).toBe("Bearer ghp_secretToken456");
    });

    it("falls back to gh auth token when no token is configured", async () => {
      const config = {
        ...baseConfig,
        tokens: { github: undefined },
        github: { enabled: true },
      };

      const fakeShell = {
        runCommand: async (cmd: string, args: string[]) => {
          if (cmd === "gh" && args[0] === "auth" && args[1] === "token") {
            return { stdout: "gho_cli_token_xyz", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      } as unknown as typeof shell;

      const cred = await resolveGitHubCredential(config, { shell: fakeShell });
      expect(cred.kind).toBe("token");
      expect(cred.token).toBe("gho_cli_token_xyz");
      expect(cred.source).toBe("github_cli");
      expect(getAuthorizationHeader(cred)).toBe("Bearer gho_cli_token_xyz");
    });

    it("throws structured CREDENTIAL_NOT_AVAILABLE when neither config nor gh CLI is available", async () => {
      const config = {
        ...baseConfig,
        tokens: { github: undefined },
        github: { enabled: true },
      };

      const fakeShell = {
        runCommand: async () => ({
          stdout: "",
          stderr: "no oauth token found",
          exitCode: 1,
        }),
      } as unknown as typeof shell;

      expect(resolveGitHubCredential(config, { shell: fakeShell })).rejects.toThrow(
        CredentialError,
      );
    });
  });
});
