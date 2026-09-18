import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../../src/fs.ts";

describe("dev provider CLI E2E (Phase 2.5)", () => {
  let devRoot: string;
  const cliPath = join(process.cwd(), "src", "cli.ts");

  beforeAll(async () => {
    devRoot = await mkdtemp(join(tmpdir(), "dev-cli-prov-e2e-"));
    await fs.writeText(join(devRoot, "dev.yaml"), `# Root Configuration\nsync_strategy: ff-only\n`);
  });

  afterAll(async () => {
    await rm(devRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("dev provider add adds an Azure DevOps provider", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "provider",
        "add",
        "ado",
        "--id",
        "my-corp-ado",
        "--org",
        "corp-org",
        "--project",
        "main-proj",
        "--root",
        devRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("my-corp-ado");
    expect(parsed.type).toBe("azure_devops");
    expect(parsed.organization).toBe("corp-org");
    expect(parsed.project).toBe("main-proj");

    // Verify dev.yaml contains new provider and original comments
    const devYaml = await fs.readText(join(devRoot, "dev.yaml"));
    expect(devYaml).toContain("# Root Configuration");
    expect(devYaml).toContain("my-corp-ado");
  });

  it("dev provider add adds a GitHub provider", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "provider",
        "add",
        "github",
        "--id",
        "my-gh",
        "--owner",
        "octocat",
        "--root",
        devRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe("my-gh");
    expect(parsed.type).toBe("github");
    expect(parsed.owner).toBe("octocat");
  });

  it("dev provider list displays all configured providers", async () => {
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "provider", "list", "--root", devRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed.some((provider: { id: string }) => provider.id === "my-corp-ado")).toBe(true);
    expect(parsed.some((provider: { id: string }) => provider.id === "my-gh")).toBe(true);
  });

  it("dev provider remove removes a provider by id", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cliPath,
        "provider",
        "remove",
        "my-corp-ado",
        "--force",
        "--root",
        devRoot,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.removed).toBe(true);
    expect(parsed.id).toBe("my-corp-ado");

    // Verify list only has 1 remaining
    const listProc = Bun.spawn(
      ["bun", "run", cliPath, "provider", "list", "--root", devRoot, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const listStdout = await new Response(listProc.stdout).text();
    const listParsed = JSON.parse(listStdout);
    expect(listParsed.length).toBe(1);
    expect(listParsed[0].id).toBe("my-gh");
  });
});
