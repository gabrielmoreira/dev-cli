import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("semantic CLI input errors", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dev-semantic-errors-"));
    await Bun.write(
      join(root, "dev.yaml"),
      "version: 1\nsources:\n  - url: https://github.com/acme/docs\n  - url: https://github.com/other/docs\nworksets:\n  alpha:\n    members:\n      - source: https://github.com/acme/docs\n",
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function run(args: readonly string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args, "--json"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DEV_ROOT: root,
        DEV_CWD: root,
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        CI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
  it("still reads an existing workset", async () => {
    const result = await run(["workset", "show", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).name).toBe("alpha");
    expect(result.stderr).toBe("");
  });
  it("keeps the workset-not-found code and recovery command", async () => {
    const result = await run(["workset", "show", "missing"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "WORKSET_NOT_FOUND",
      nextStep: "dev workset list",
    });
  });
  it.each([
    { args: ["ws", "add", "missing"] },
    { args: ["workset", "create", "new", "missing"] },
    { args: ["label", "add", "team:docs", "missing"] },
  ])("keeps a missing source code for $args", async ({ args }) => {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "SOURCE_NOT_FOUND",
      query: "missing",
    });
  });
  it("reports ambiguous declared repositories without losing candidates", async () => {
    const result = await run(["label", "add", "team:docs", "docs"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "SOURCE_AMBIGUOUS",
      matches: ["https://github.com/acme/docs", "https://github.com/other/docs"],
    });
  });
});
