import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkItems, type WorkItemRecord } from "../../src/cache.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const TENANT_A = "dev.azure.com/example-a";
const TENANT_B = "dev.azure.com/example-b";

// The first configured provider and its default project are deliberately the
// wrong place for most records below: identity has to come from the row or the flags.
const CONFIG = [
  "version: 1",
  "providers:",
  "  - id: example-a",
  "    type: azure_devops",
  "    organization: example-a",
  "    project: shared",
  "  - id: example-b",
  "    type: azure_devops",
  "    organization: example-b",
  "    project: shared",
  "",
].join("\n");

function record(tenant: string, project: string, id: number, title: string): WorkItemRecord {
  return {
    id,
    type: "Task",
    title,
    state: "New",
    url: `https://example.test/${tenant}/${project}/${id}`,
    tenant,
    project,
    syncedAt: "",
  };
}

describe("dev wi view identity", () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-wi-view-identity-"));
    await writeFile(join(root, "dev.yaml"), CONFIG);
    env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      DEV_ROOT: root,
      DEV_CWD: root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "1",
    };
    const write = (tenant: string, project: string, records: WorkItemRecord[]) =>
      writeWorkItems({ root, tenant, project, records });
    // Same id and same project name in two organizations.
    await write(TENANT_A, "shared", [
      record(TENANT_A, "shared", 7, "Alpha seven"),
      record(TENANT_A, "shared", 8, "Alpha eight"),
    ]);
    await write(TENANT_B, "shared", [record(TENANT_B, "shared", 7, "Bravo seven")]);
    // Only exists outside the first provider and its default project.
    await write(TENANT_B, "other", [
      record(TENANT_B, "other", 101, "Only in bravo other"),
      record(TENANT_B, "other", 102, "Second in bravo other"),
    ]);
    await write(TENANT_A, "solo", [record(TENANT_A, "solo", 55, "Alpha solo")]);
    // The same id in a second project of one organization.
    await write(TENANT_A, "second", [record(TENANT_A, "second", 8, "Alpha eight again")]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function view(args: string[]) {
    const child = Bun.spawn(
      [process.execPath, CLI, "wi", "view", ...args, "--offline", "--json", "--root", root],
      { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function found(args: string[]) {
    const result = await view(args);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    return JSON.parse(result.stdout) as WorkItemRecord;
  }

  async function failed(args: string[], exitCode: number) {
    const result = await view(args);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    return JSON.parse(result.stderr).error as Record<string, unknown>;
  }

  it("finds a cached item that lives in a non-default organization and project", async () => {
    expect(await found(["101"])).toMatchObject({
      id: 101,
      title: "Only in bravo other",
      tenant: TENANT_B,
      project: "other",
    });
  });

  it("opens the record a tenant and project select when two organizations share id and project", async () => {
    expect(await found(["7", "--tenant", TENANT_A, "--project", "shared"])).toMatchObject({
      title: "Alpha seven",
      tenant: TENANT_A,
    });
    expect(await found(["7", "--tenant", TENANT_B, "--project", "shared"])).toMatchObject({
      title: "Bravo seven",
      tenant: TENANT_B,
    });
  });

  it("opens the only match inside a tenant without needing the project", async () => {
    expect(await found(["101", "--tenant", TENANT_B])).toMatchObject({ project: "other" });
    expect(await found(["7", "--tenant", TENANT_B])).toMatchObject({ title: "Bravo seven" });
  });

  it("asks which organization instead of opening a wrong record for an ambiguous id", async () => {
    const error = await failed(["7", "--project", "shared"], 2);
    expect(error).toMatchObject({ code: "INTERACTION_REQUIRED", field: "tenant" });
    expect([...(error.choices as string[])].sort()).toEqual([TENANT_A, TENANT_B]);
    expect(typeof error.nextStep).toBe("string");
    expect(error.nextStep).toContain("--tenant");
  });

  it("asks which project when one organization holds the id in several projects", async () => {
    const error = await failed(["8", "--tenant", TENANT_A], 2);
    expect(error).toMatchObject({ code: "INTERACTION_REQUIRED", field: "project" });
    expect([...(error.choices as string[])].sort()).toEqual(["second", "shared"]);
    expect(await found(["8", "--tenant", TENANT_A, "--project", "second"])).toMatchObject({
      title: "Alpha eight again",
    });
  });

  it("never resolves an item from another organization or project", async () => {
    for (const selector of [
      ["--tenant", TENANT_A],
      ["--tenant", TENANT_A, "--project", "shared"],
      ["--tenant", TENANT_B, "--project", "shared"],
      ["--provider", "example-a"],
    ]) {
      const error = await failed(["101", ...selector], 1);
      expect(error.message).toContain("#101");
    }
  });

  it("keeps explicit provider and tenant constraints in agreement", async () => {
    expect(await found(["7", "--provider", "example-b"])).toMatchObject({ title: "Bravo seven" });
    expect(await found(["7", "--provider", "example-a", "--tenant", TENANT_A])).toMatchObject({
      title: "Alpha seven",
    });
    const error = await failed(["7", "--provider", "example-a", "--tenant", TENANT_B], 2);
    expect(error.code).toBe("CONFLICTING_OPTIONS");
  });

  it("limits selection without an id to the requested namespace", async () => {
    expect(await found(["--tenant", TENANT_A, "--project", "solo"])).toMatchObject({
      id: 55,
      title: "Alpha solo",
    });
    const error = await failed(["--tenant", TENANT_B], 2);
    expect(error).toMatchObject({ code: "INTERACTION_REQUIRED", field: "id" });
    expect(error.choices as string[]).toHaveLength(3);
  });
});
