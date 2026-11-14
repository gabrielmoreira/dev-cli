import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const STUB = join(import.meta.dir, "..", "fixtures", "ado-fetch-stub.ts");

// Two providers share one organization but default to different projects; a third
// provider lives in another organization. The cache is empty, so every lookup is live.
const CONFIG = [
  "version: 1",
  "providers:",
  "  - id: shared-a",
  "    type: azure_devops",
  "    organization: example-shared",
  "    project: proj-a",
  "  - id: shared-b",
  "    type: azure_devops",
  "    organization: example-shared",
  "    project: proj-b",
  "  - id: other",
  "    type: azure_devops",
  "    organization: example-other",
  "    project: proj-o",
  "",
].join("\n");

describe("dev wi view live lookups honor the selected scope", () => {
  let root: string;
  let log: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-wi-view-live-"));
    log = join(root, "requests.log");
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
      AZURE_DEVOPS_PAT: "example-token",
      STUB_FETCH_LOG: log,
    };
  });

  beforeEach(async () => {
    await writeFile(log, "");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function view(args: string[]) {
    const child = Bun.spawn(
      [process.execPath, "--preload", STUB, CLI, "wi", "view", ...args, "--json", "--root", root],
      { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const requests = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    return { stdout, stderr, exitCode, requests };
  }

  it("queries the explicitly selected provider even when another shares its organization", async () => {
    const result = await view(["900", "--provider", "shared-b"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 900,
      title: "Live example-shared/proj-b/900",
      project: "proj-b",
    });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toContain("/example-shared/proj-b/_apis/wit/workitems/900");
  });

  it("uses the default project of a provider in another organization", async () => {
    const result = await view(["900", "--provider", "other"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ project: "proj-o" });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toContain("/example-other/proj-o/_apis/wit/workitems/900");
  });

  it("asks for an organization instead of querying the first one on a cache miss", async () => {
    const result = await view(["901"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error).toMatchObject({ code: "INTERACTION_REQUIRED", field: "tenant" });
    expect([...error.choices].sort()).toEqual([
      "dev.azure.com/example-other",
      "dev.azure.com/example-shared",
    ]);
    expect(result.requests).toEqual([]);
  });

  it("asks for a provider when one organization has several with different default projects", async () => {
    const result = await view(["902", "--tenant", "dev.azure.com/example-shared"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error).toMatchObject({ code: "INTERACTION_REQUIRED", field: "provider" });
    expect([...error.choices].sort()).toEqual(["shared-a", "shared-b"]);
    expect(result.requests).toEqual([]);
  });

  it("lets an explicit project settle which default applies within one organization", async () => {
    const result = await view([
      "903",
      "--tenant",
      "dev.azure.com/example-shared",
      "--project",
      "proj-b",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toContain("/example-shared/proj-b/_apis/wit/workitems/903");
  });
});
