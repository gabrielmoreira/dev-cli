import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../src/config.ts";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("Config resolution rules (Phase 1 & Phase 9)", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dev-cli-config-test-"));
    const yamlContent = `version: 1
defaults:
  workspace_prefix: ws/
  canonical_prefix: mirrors/
  auto_fetch_interval: 2h
azure_devops:
  organization: my-org
  project: my-proj
  token: configured-ado-token
github:
  owner: my-github-org
  token: configured-gh-token
  enabled: true
trusted_scopes:
  - provider: azure_devops
    tenant: dev.azure.com
    owner: my-org
    repos: [app1, app2]
    install: true
    allowed_tools: [mise, bun]
`;
    await Bun.write(join(tempDir, "dev.yaml"), yamlContent);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("prioritizes --root CLI flag over everything else", () => {
    const config = resolveConfig({
      rootFlag: "/custom/flag/path",
      cwd: "/current/dir",
      env: {
        DEV_ROOT: "/env/root/path",
        HOME: "/home/user",
      },
    });

    expect(config.rootSource).toBe("flag");
    expect(config.root.replace(/\\/g, "/")).toContain("/custom/flag/path");
  });

  it("prioritizes DEV_ROOT environment variable when no flag is provided", () => {
    const config = resolveConfig({
      cwd: "/current/dir",
      env: {
        DEV_ROOT: "/env/root/path",
        HOME: "/home/user",
      },
    });

    expect(config.rootSource).toBe("env");
    expect(config.root.replace(/\\/g, "/")).toContain("/env/root/path");
  });

  it("falls back to ~/dev when neither flag nor env nor dev.yaml is found", () => {
    const config = resolveConfig({
      cwd: "/isolated/path/without/config",
      env: {
        HOME: "/mock/home",
      },
    });

    expect(config.rootSource).toBe("default");
    expect(config.root.replace(/\\/g, "/")).toBe(resolve("/mock/home", "dev").replace(/\\/g, "/"));
  });

  it("finds and parses dev.yaml from cwd, normalizing providers and trusted scopes", () => {
    const subDir = join(tempDir, "subfolder", "deeper");
    const config = resolveConfig({
      cwd: subDir,
      env: {},
    });

    expect(config.rootSource).toBe("file");
    expect(config.root.replace(/\\/g, "/")).toBe(tempDir.replace(/\\/g, "/"));
    expect(config.defaults.autoFetchInterval).toBe("2h");
    expect(config.azureDevOps.organization).toBe("my-org");
    expect(config.azureDevOps.project).toBe("my-proj");
    expect(config.github.owner).toBe("my-github-org");
    expect(config.trustedScopes).toHaveLength(1);
    expect(config.trustedScopes[0].repos).toEqual(["app1", "app2"]);
    expect(config.trustedScopes[0].allowedTools).toEqual(["mise", "bun"]);
  });

  it("rejects malformed provider entries instead of silently dropping them", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "dev-cli-invalid-provider-"));
    try {
      await Bun.write(
        join(invalidRoot, "dev.yaml"),
        ["version: 1", "providers:", "  - id: incomplete-ado", "    type: azure_devops", ""].join(
          "\n",
        ),
      );

      expect(() => resolveConfig({ cwd: invalidRoot, env: {} })).toThrow(
        /Invalid configuration.*providers\.0\.organization/,
      );
    } finally {
      await rm(invalidRoot, { recursive: true, force: true });
    }
  });

  it("prioritizes environment tokens over dev.yaml configured tokens", () => {
    const config = resolveConfig({
      cwd: tempDir,
      env: {
        AZURE_DEVOPS_PAT: "env-override-ado-pat",
        GITHUB_TOKEN: "env-override-gh-token",
      },
    });

    expect(config.tokens.azureDevOps).toBe("env-override-ado-pat");
    expect(config.tokens.github).toBe("env-override-gh-token");
  });
});
