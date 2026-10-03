import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(process.cwd(), "src", "cli.ts");
let temp: string;
let root: string;
let env: Record<string, string | undefined>;
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, cliPath, ...args, "--root", root, "--json"], {
    cwd: root,
    env,
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
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "dev-dual-subject-"));
  root = join(temp, "root");
  const home = join(temp, "home");
  await mkdir(root);
  await mkdir(home);
  await writeFile(
    join(root, "dev.yaml"),
    "providers:\n  - id: fixture\n    type: azure_devops\n    organization: example\n",
  );
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    CI: "1",
    DEV_ROOT: undefined,
    DEV_CWD: undefined,
  };
  for (const name of ["alpha", "beta"]) {
    const result = await cli(["ws", "init", name]);
    expect(result.code, result.stderr).toBe(0);
  }
}, 30_000);
afterAll(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
for (const verb of ["status", "update", "path", "jump"]) {
  const options =
    verb === "status" ? ["--offline"] : verb === "update" ? ["--offline", "--dry-run"] : [];
  it(
    "ws " + verb + " rejects disagreeing positional and --ws without changing either manifest",
    async () => {
      const alpha = join(root, "ws", "alpha", "ws.md");
      const beta = join(root, "ws", "beta", "ws.md");
      const before = await Promise.all([readFile(alpha, "utf8"), readFile(beta, "utf8")]);
      const result = await cli(["ws", verb, "alpha", "--ws", "beta", ...options]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toMatchObject({
        code: "CONFLICTING_OPTIONS",
        positional: "alpha",
        flag: "beta",
      });
      expect(await Promise.all([readFile(alpha, "utf8"), readFile(beta, "utf8")])).toEqual(before);
    },
  );
  it("ws " + verb + " accepts the same explicit workspace twice", async () => {
    const result = await cli(["ws", verb, "alpha", "--ws", "alpha", ...options]);
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    if (verb === "status" || verb === "update") expect(data.workspaceName).toBe("alpha");
    else if (verb === "jump") expect(data.name).toBe("alpha");
    else expect(data.path).toBe(join(root, "ws", "alpha"));
  });
}
it("ws update compares a positional ws.md by manifest identity before rejecting --ws", async () => {
  const path = join(root, "ws", "alpha", "ws.md");
  const before = await readFile(path, "utf8");
  const result = await cli(["ws", "update", path, "--ws", "beta", "--offline", "--dry-run"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatchObject({
    code: "CONFLICTING_OPTIONS",
    positional: "alpha",
    flag: "beta",
  });
  expect(await readFile(path, "utf8")).toBe(before);
});
it("ws update accepts a ws.md path and the same manifest name in --ws", async () => {
  const result = await cli([
    "ws",
    "update",
    join(root, "ws", "alpha", "ws.md"),
    "--ws",
    "alpha",
    "--offline",
    "--dry-run",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).workspaceName).toBe("alpha");
});
it("pr list rejects contradictory positional and --repo before provider work", async () => {
  const result = await cli(["pr", "list", "alpha", "--repo", "beta", "--offline"]);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatchObject({
    code: "CONFLICTING_OPTIONS",
    positional: "alpha",
    flag: "beta",
  });
});
it("pr list accepts the same repository twice on an empty offline cache", async () => {
  const result = await cli(["pr", "list", "alpha", "--repo", "alpha", "--offline"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
});
