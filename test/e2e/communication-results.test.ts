import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
describe("answers explain empty state and next action", () => {
  let home: string;
  let root: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dev-answers-"));
    root = join(home, "dev");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function run(args: readonly string[]) {
    const child = Bun.spawn([Bun.which("bun")!, CLI, ...args, "--root", root], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DEV_ROOT: root,
        DEV_CWD: home,
        CI: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }
  it.each([
    { args: ["ws"], cause: "No workspaces", next: "dev ws init", json: [] },
    { args: ["pr"], cause: "No provider connected", next: "dev provider add", json: [] },
    {
      args: ["wi"],
      cause: "No Azure DevOps provider connected",
      next: "dev provider add ado",
      json: [],
    },
    { args: ["workset"], cause: "No worksets", next: "dev workset manage", json: [] },
    { args: ["mirror", "ls"], cause: "No mirrors", next: "dev mirror add", json: [] },
    { args: ["mirror", "pick"], cause: "No mirrors", next: "dev mirror add", json: [] },
    {
      args: ["provider", "list"],
      cause: "No provider connected",
      next: "dev provider add",
      json: [],
    },
    { args: ["label", "ls"], cause: "No labels", next: "dev label add", json: [] },
    {
      args: ["qmd", "sync"],
      cause: "No index:",
      next: "dev label add index:docs",
      json: { exitCode: 0, labels: [], warnings: [] },
    },
  ])(
    "offers a next command for %j without changing its JSON answer",
    async ({ args, cause, next, json }) => {
      expect((await run(["init", root, "--json"])).code).toBe(0);
      const answer = await run(args);
      expect(answer.code).toBe(0);
      expect(answer.stderr).toBe("");
      expect(answer.stdout).toContain(`○ ${cause}`);
      expect(answer.stdout).toContain(`↳ ${next}`);
      const structured = await run([...args, "--json"]);
      expect(structured.code).toBe(0);
      expect(structured.stderr).toBe("");
      expect(structured.stdout).toBe(`${JSON.stringify(json, null, 2)}\n`);
    },
  );
  it.each(
    [
      ["ws"],
      ["pr"],
      ["workset"],
      ["mirror", "ls"],
      ["provider", "list"],
      ["label", "ls"],
      ["roots"],
    ].map((args) => ({ args })),
  )(
    "offers setup rather than a root-specific action when no root exists (%j)",
    async ({ args }) => {
      const answer = await run(args);
      expect(answer.code).toBe(0);
      expect(answer.stdout).toContain("○ No dev root yet");
      expect(answer.stdout).toContain("↳ dev init");
    },
  );
  it("names what init changed and what you can do next, including an identical rerun", async () => {
    const created = await run(["init", root]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain(`✓ Created your dev root at ${root}`);
    expect(created.stdout).toContain("↳ dev ws init <repository-url>");
    expect(created.stdout).toContain("↳ dev provider add");
    const repeated = await run(["init", root]);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain(`○ Your dev root at ${root} is ready`);
    expect(repeated.stdout).toContain("↳ dev ws init");
  });
});
