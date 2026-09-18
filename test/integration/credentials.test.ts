import { describe, expect, it } from "bun:test";
import { resolveConfig } from "../../src/config.ts";
import {
  getAuthorizationHeader,
  getGitExtraHeader,
  resolveAzureDevOpsCredential,
} from "../../src/credentials.ts";

describe("Credential resolution integration (Phase 9)", () => {
  it("resolves active environment credentials for Azure DevOps without hardcoding secrets", async () => {
    const config = resolveConfig({
      cwd: process.cwd(),
      env: { ...process.env },
    });

    if (config.tokens.azureDevOps) {
      const cred = await resolveAzureDevOpsCredential(config);
      expect(cred.token.length).toBeGreaterThan(0);
      expect(cred.kind).toBe("pat");
      expect(getAuthorizationHeader(cred)).toContain("Basic ");
      expect(getGitExtraHeader(cred)).toContain("http.extraheader=AUTHORIZATION: Basic ");
    }
  });
});
